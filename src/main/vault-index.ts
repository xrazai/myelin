// `index.db`: the vault's derived index, outside the vault. Deleting it loses nothing.
// Runs inside vault-worker only. Loaded by Node as-is in tests (type stripping): erasable
// TypeScript only, value imports of project files carry the `.ts` extension.
//
// Every commit keeps one invariant: `notes` holds the paths found by the last scan, and
// every row of `links` is resolved against exactly those paths. A note whose content is not
// indexed yet has a NULL `hash`, so an interrupted sync just continues on the next one.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import Database from 'better-sqlite3';
import type { TreeEntry } from '../shared/ipc';
import { createLinkResolver, linkKey, noteLinks, type LinkResolver, type MutableLinkResolver } from '../shared/links.ts';
import { scanVault } from './vault-scan.ts';

/** Stored in `user_version`. Bump on any schema change: the index is dropped and rebuilt. */
export const SCHEMA_VERSION = 3;

// In `links`, a resolved link has `target_path`, an unresolved one has `name`. `key` is
// `linkKey(target)`. Positions are UTF-16 offsets in the note's text without BOM.
// `notes_fts.rowid` is `notes.id`.
const SCHEMA = `
  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    hash TEXT,
    mtime_ms REAL,
    size INTEGER
  );
  CREATE TABLE links (
    source TEXT NOT NULL REFERENCES notes (path) ON UPDATE CASCADE ON DELETE CASCADE,
    from_pos INTEGER NOT NULL,
    to_pos INTEGER NOT NULL,
    target_from INTEGER NOT NULL,
    target_to INTEGER NOT NULL,
    target TEXT NOT NULL,
    key TEXT NOT NULL,
    target_path TEXT,
    name TEXT,
    subpath TEXT NOT NULL,
    alias TEXT,
    PRIMARY KEY (source, from_pos),
    CHECK ((target_path IS NULL) <> (name IS NULL))
  ) WITHOUT ROWID;
  CREATE INDEX links_key ON links (key);
  CREATE INDEX links_target_path ON links (target_path);
  -- Where the graph put each note. Not derived from the vault: losing it only means
  -- the graph lays the notes out again.
  CREATE TABLE positions (path TEXT PRIMARY KEY, x REAL NOT NULL, y REAL NOT NULL) WITHOUT ROWID;
  -- The graph's communities of each note, a JSON array of ids, the finest level first.
  CREATE TABLE communities (path TEXT PRIMARY KEY, levels TEXT NOT NULL) WITHOUT ROWID;
  CREATE VIRTUAL TABLE notes_fts USING fts5 (title, body, tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER notes_delete AFTER DELETE ON notes BEGIN
    DELETE FROM notes_fts WHERE rowid = old.id;
    DELETE FROM positions WHERE path = old.path;
    DELETE FROM communities WHERE path = old.path;
  END;
  PRAGMA user_version = ${SCHEMA_VERSION};
`;

export function indexPath(userData: string, vaultId: string): string {
  return join(userData, 'vaults', vaultId, 'index.db');
}

/** Hash of a note's bytes; a string is hashed as the UTF-8 that `writeFileAtomic` writes. */
export function contentHash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** `null` if the file has another schema version; creates the schema in an empty one. */
function prepare(file: string): Database.Database | null {
  const db = new Database(file);
  try {
    const version = db.pragma('user_version', { simple: true });
    const empty = version === 0 && db.prepare('SELECT count(*) FROM sqlite_master').pluck().get() === 0;
    if (!empty && version !== SCHEMA_VERSION) {
      db.close();
      return null;
    }
    const mode = db.pragma('journal_mode = WAL', { simple: true });
    if (mode !== 'wal') throw new Error(`index.db cannot use WAL (journal mode: ${String(mode)})`);
    // Safe with WAL; a power cut can only lose recent commits of a rebuildable file.
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    // One transaction: a crash leaves the file empty, never half a schema.
    if (empty) db.transaction(() => db.exec(SCHEMA))();
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const UNUSABLE = /^SQLITE_(CORRUPT|NOTADB)/;

/** True if the index file itself is bad. Anything else (locked, disk full) is not a reason to delete it. */
export function isDamaged(error: unknown): boolean {
  return UNUSABLE.test((error as { code?: string } | null)?.code ?? '');
}

/** Opens the index, starting over if the file is damaged or from another schema version. */
export function openIndex(file: string): Database.Database {
  mkdirSync(dirname(file), { recursive: true });
  // A WAL left behind by a deleted index must not reach the new one.
  if (!statSync(file, { throwIfNoEntry: false })) removeSidecars(file);
  try {
    const db = prepare(file);
    if (db) return db;
  } catch (error) {
    if (!isDamaged(error)) throw error;
  }
  deleteIndex(file);
  return prepare(file)!;
}

/** Removes the index and its sidecars. It must be closed: Windows keeps an open file. */
export function deleteIndex(file: string): void {
  rmSync(file, { force: true });
  removeSidecars(file);
}

function removeSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true });
}

/** The path of every note in the tree, in tree order. */
/**
 * How many notes outside the target have a link that resolves into it: the note at `path`,
 * or every note under the folder at `path`.
 */
export function countLinkingNotes(db: Database.Database, path: string, kind: 'note' | 'folder'): number {
  if (kind === 'note') {
    return db
      .prepare('SELECT COUNT(DISTINCT source) FROM links WHERE target_path = ? AND source <> ?')
      .pluck()
      .get(path, path) as number;
  }
  // A range, not `LIKE`: names may hold `%` and `_`. `0` is the character after `/`.
  const from = `${path}/`;
  const to = `${path}0`;
  return db
    .prepare(
      `SELECT COUNT(DISTINCT source) FROM links
       WHERE target_path > ? AND target_path < ? AND NOT (source > ? AND source < ?)`,
    )
    .pluck()
    .get(from, to, from, to) as number;
}

export function notePaths(entries: TreeEntry[], into: string[] = []): string[] {
  for (const entry of entries) {
    if (entry.kind === 'note') into.push(entry.path);
    else notePaths(entry.children, into);
  }
  return into;
}

const title = (path: string) => path.slice(path.lastIndexOf('/') + 1, -'.md'.length);

/** The keys a link may have if creating or deleting this note changes where it points. */
function affectedKeys(path: string): string[] {
  const parts = linkKey(path).split('/');
  return parts.map((_, i) => parts.slice(i).join('/'));
}

/**
 * The notes a rename of `from` to `to` may have to rewrite, so that it need not read the
 * whole vault: those with a link either name can affect, and those the index is behind on
 * (by mtime and size, as the sync decides). `paths` are the notes on disk.
 */
export function renameCandidates(
  db: Database.Database,
  root: string,
  paths: string[],
  moves: ReadonlyMap<string, string>,
): string[] {
  const linking = db.prepare('SELECT DISTINCT source FROM links WHERE key = ?').pluck();
  const keys = new Set([...moves].flat().flatMap(affectedKeys));
  const sources = new Set<string>();
  for (const key of keys) for (const source of linking.all(key) as string[]) sources.add(source);
  const stamps = db.prepare('SELECT path, mtime_ms AS mtimeMs, size FROM notes WHERE hash IS NOT NULL').all();
  const indexed = new Map((stamps as (Row & { path: string })[]).map((row) => [row.path, row]));
  return paths.filter((path) => {
    if (sources.has(path)) return true;
    const row = indexed.get(path);
    const stats = row && statSync(join(root, path), { throwIfNoEntry: false });
    return !stats || stats.mtimeMs !== row.mtimeMs || stats.size !== row.size;
  });
}

/** The resolver for the paths now in `notes`; building it is slow on a large vault. */
const resolvers = new WeakMap<Database.Database, MutableLinkResolver>();

const allPaths = (db: Database.Database) => db.prepare('SELECT path FROM notes').pluck().all() as string[];

/** Makes `notes` match the scanned paths and re-resolves the links this affects. */
function applyPaths(db: Database.Database, paths: string[], resolve: MutableLinkResolver): number {
  resolvers.delete(db);
  const known = new Set(allPaths(db));
  const found = new Set(paths);
  const added = paths.filter((path) => !known.has(path));
  const removed = [...known].filter((path) => !found.has(path));
  applyChanges(db, added, removed, resolve);
  // Cached only once the rows match it.
  resolvers.set(db, resolve);
  return removed.length;
}

/** Adds and removes these notes and re-resolves the links this affects, in one transaction. */
function applyChanges(db: Database.Database, added: string[], removed: string[], resolve: LinkResolver): void {
  if (added.length === 0 && removed.length === 0) return;

  const insert = db.prepare('INSERT INTO notes (path, title) VALUES (?, ?)');
  const remove = db.prepare('DELETE FROM notes WHERE path = ?');
  const affected = db.prepare('SELECT source, from_pos AS fromPos, target FROM links WHERE key = ?');
  const update = db.prepare('UPDATE links SET target_path = ?, name = ? WHERE source = ? AND from_pos = ?');
  db.transaction(() => {
    for (const path of removed) remove.run(path);
    for (const path of added) insert.run(path, title(path));
    // A new index has no links yet: skip the lookups, hundreds of thousands in a large vault.
    if (db.prepare('SELECT 1 FROM links LIMIT 1').get() === undefined) return;
    for (const key of new Set([...added, ...removed].flatMap(affectedKeys))) {
      for (const link of affected.all(key) as { source: string; fromPos: number; target: string }[]) {
        const to = resolve(link.target, link.source);
        update.run(to.path, to.path === null ? to.name : null, link.source, link.fromPos);
      }
    }
  })();
}

export interface SyncReport {
  /** Notes in the vault. */
  notes: number;
  /** Notes whose content was (re)indexed. */
  indexed: number;
  /** Notes dropped from the index. */
  removed: number;
  /** Notes that could not be read; the index keeps what it had of them. */
  failed: number;
  ms: number;
}

interface Row {
  id: number;
  hash: string | null;
  mtimeMs: number | null;
  size: number | null;
}

/** How long the sync holds the thread before letting queued requests run. */
const SLICE_MS = 15;

/** `previous` is the hash the index had; equal to `hash` if the content did not change. */
interface Indexed {
  hash: string;
  previous: string | null;
  mtimeMs: number;
}

/**
 * Returns the function that brings one note listed in `notes` up to date. With
 * `trustStamp`, a note whose mtime and size did not move is not read and counts as
 * unchanged.
 */
function noteIndexer(db: Database.Database, root: string, resolve: LinkResolver) {
  const select = db.prepare('SELECT id, hash, mtime_ms AS mtimeMs, size FROM notes WHERE path = ?');
  const stamp = db.prepare('UPDATE notes SET mtime_ms = ?, size = ? WHERE id = ?');
  const save = db.prepare('UPDATE notes SET hash = ?, mtime_ms = ?, size = ? WHERE id = ?');
  const dropText = db.prepare('DELETE FROM notes_fts WHERE rowid = ?');
  const addText = db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)');
  const dropLinks = db.prepare('DELETE FROM links WHERE source = ?');
  const addLink = db.prepare(`
    INSERT INTO links (source, from_pos, to_pos, target_from, target_to, target, key, target_path, name, subpath, alias)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  return (path: string, trustStamp: boolean): Indexed | 'failed' => {
    const row = select.get(path) as Row;
    let bytes: Buffer;
    let mtimeMs: number;
    let size: number;
    try {
      const file = join(root, path);
      if (trustStamp && row.hash !== null) {
        const stats = statSync(file);
        if (stats.mtimeMs === row.mtimeMs && stats.size === row.size) {
          return { hash: row.hash, previous: row.hash, mtimeMs: stats.mtimeMs };
        }
      }
      // Stamp and bytes come from one handle. A write during the read changes the stamp
      // again, so the next sync reads the note once more.
      const handle = openSync(file, 'r');
      try {
        ({ mtimeMs, size } = fstatSync(handle));
        bytes = readFileSync(handle);
      } finally {
        closeSync(handle);
      }
    } catch {
      // Deleted since it was listed, held by another program, no permission...
      return 'failed';
    }
    const hash = contentHash(bytes);
    const result = { hash, previous: row.hash, mtimeMs };
    if (hash === row.hash) {
      stamp.run(mtimeMs, size, row.id);
      return result;
    }
    const text = bytes.toString('utf8').replace(/^﻿/, '');
    save.run(hash, mtimeMs, size, row.id);
    // A note never indexed has nothing to drop.
    if (row.hash !== null) {
      dropText.run(row.id);
      dropLinks.run(path);
    }
    addText.run(row.id, title(path), text);
    for (const link of noteLinks(path, text, resolve)) {
      addLink.run(
        path, link.from, link.to, link.targetFrom, link.targetTo, link.target, link.key,
        link.path, link.path === null ? link.name : null, link.subpath, link.alias,
      );
    }
    return result;
  };
}

/** Runs `step` over the items in short slices, one transaction each, yielding in between. */
async function inSlices<T>(
  db: Database.Database,
  items: T[],
  signal: AbortSignal,
  step: (item: T) => void,
): Promise<void> {
  let next = 0;
  const slice = db.transaction(() => {
    const deadline = performance.now() + SLICE_MS;
    while (next < items.length && performance.now() < deadline) step(items[next++]!);
  });
  while (next < items.length) {
    slice();
    await nextTurn();
    signal.throwIfAborted();
  }
}

export interface SyncOptions {
  /** A scan made just now, to not scan again. */
  tree?: TreeEntry[];
  /** A note's content was (re)indexed. */
  onIndexed?: (path: string) => void;
}

/**
 * Brings the index up to date with the vault: everything on a new index, otherwise only
 * notes added, removed or modified (by mtime and size, then content hash). Reads with
 * sync calls in short slices. Rejects with `signal`'s reason if aborted; the caller may
 * close `db` once this settles.
 */
export async function syncIndex(
  db: Database.Database,
  root: string,
  signal: AbortSignal,
  { tree, onIndexed }: SyncOptions = {},
): Promise<SyncReport> {
  const started = performance.now();
  const paths = notePaths(tree ?? (await scanVault(root)));
  signal.throwIfAborted();
  const resolve = createLinkResolver(paths);
  const removed = applyPaths(db, paths, resolve);
  const indexNote = noteIndexer(db, root, resolve);

  let indexed = 0;
  let failed = 0;
  await inSlices(db, paths, signal, (path) => {
    const result = indexNote(path, true);
    if (result === 'failed') failed++;
    else if (result.hash !== result.previous) {
      indexed++;
      onIndexed?.(path);
    }
  });

  return { notes: paths.length, indexed, removed, failed, ms: Math.round(performance.now() - started) };
}

export interface NoteUpdate {
  path: string;
  hash: string;
  /** The hash the index had: `null` for a note whose content it did not have. */
  previous: string | null;
  mtimeMs: number;
  /** A rename's link-only rewrite: not a content change for the heavy path. */
  linkOnly: boolean;
}

/**
 * Applies changes to a synced index. Each of `paths` may have been created, changed or
 * deleted; `exists` says which are notes now. Notes are added and removed, and links
 * re-resolved, in one transaction; contents are then read and hashed in slices, and
 * `onNote` gets each one. `trustStamp` skips reading those whose mtime and size did not
 * move, as the sync does. Returns the notes that could not be read. Never run it
 * while `syncIndex` or another update runs on `db`.
 */
export async function updateIndex(
  db: Database.Database,
  root: string,
  paths: string[],
  exists: (path: string) => boolean,
  signal: AbortSignal,
  onNote: (update: NoteUpdate) => void,
  { trustStamp = false, linkOnly = new Set<string>() }: { trustStamp?: boolean; linkOnly?: ReadonlySet<string> } = {},
): Promise<string[]> {
  signal.throwIfAborted();
  const row = db.prepare('SELECT 1 FROM notes WHERE path = ?');
  const present = paths.filter(exists);
  const added = present.filter((path) => row.get(path) === undefined);
  const kept = new Set(present);
  const removed = new Set(paths.filter((path) => !kept.has(path) && row.get(path) !== undefined));

  // Built once for this index; then it follows the changes, whatever the size of the vault.
  let resolve = resolvers.get(db);
  if (!resolve) resolvers.set(db, (resolve = createLinkResolver(allPaths(db))));
  if (added.length > 0 || removed.size > 0) {
    for (const path of removed) resolve.remove(path);
    for (const path of added) resolve.add(path);
    try {
      applyChanges(db, added, [...removed], resolve);
    } catch (error) {
      // The rows did not change: the resolver is ahead of them.
      resolvers.delete(db);
      throw error;
    }
  }

  const indexNote = noteIndexer(db, root, resolve);
  const failed: string[] = [];
  await inSlices(db, present, signal, (path) => {
    const result = indexNote(path, trustStamp);
    if (result === 'failed') failed.push(path);
    else onNote({ path, ...result, linkOnly: linkOnly.has(path) });
  });
  return failed;
}
