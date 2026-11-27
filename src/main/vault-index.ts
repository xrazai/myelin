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
import { createLinkResolver, linkKey, noteLinks, type LinkResolver } from '../shared/links.ts';
import { scanVault } from './vault-scan.ts';

/** Stored in `user_version`. Bump on any schema change: the index is dropped and rebuilt. */
export const SCHEMA_VERSION = 1;

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
  CREATE VIRTUAL TABLE notes_fts USING fts5 (title, body, tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER notes_delete AFTER DELETE ON notes BEGIN
    DELETE FROM notes_fts WHERE rowid = old.id;
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

/** Opens the index, starting over if the file is damaged or from another schema version. */
export function openIndex(file: string): Database.Database {
  mkdirSync(dirname(file), { recursive: true });
  // A WAL left behind by a deleted index must not reach the new one.
  if (!statSync(file, { throwIfNoEntry: false })) removeSidecars(file);
  try {
    const db = prepare(file);
    if (db) return db;
  } catch (error) {
    // Anything else (locked, disk full) is not a reason to delete the file.
    if (!UNUSABLE.test((error as { code?: string }).code ?? '')) throw error;
  }
  rmSync(file, { force: true });
  removeSidecars(file);
  return prepare(file)!;
}

function removeSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm']) rmSync(file + suffix, { force: true });
}

function notePaths(entries: TreeEntry[], into: string[] = []): string[] {
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

/** Makes `notes` match the scanned paths and re-resolves the links this affects. */
function applyPaths(db: Database.Database, paths: string[], resolve: LinkResolver): number {
  const known = new Set(db.prepare('SELECT path FROM notes').pluck().all() as string[]);
  const found = new Set(paths);
  const added = paths.filter((path) => !known.has(path));
  const removed = [...known].filter((path) => !found.has(path));
  if (added.length === 0 && removed.length === 0) return 0;

  const insert = db.prepare('INSERT INTO notes (path, title) VALUES (?, ?)');
  const remove = db.prepare('DELETE FROM notes WHERE path = ?');
  const affected = db.prepare('SELECT source, from_pos AS fromPos, target FROM links WHERE key = ?');
  const update = db.prepare('UPDATE links SET target_path = ?, name = ? WHERE source = ? AND from_pos = ?');
  db.transaction(() => {
    for (const path of removed) remove.run(path);
    for (const path of added) insert.run(path, title(path));
    for (const key of new Set([...added, ...removed].flatMap(affectedKeys))) {
      for (const link of affected.all(key) as { source: string; fromPos: number; target: string }[]) {
        const to = resolve(link.target, link.source);
        update.run(to.path, to.path === null ? to.name : null, link.source, link.fromPos);
      }
    }
  })();
  return removed.length;
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

/**
 * Brings the index up to date with the vault: everything on a new index, otherwise only
 * notes added, removed or modified (by mtime and size, then content hash). Reads with
 * sync calls in short slices, one transaction each, yielding in between. Rejects with
 * `signal`'s reason if aborted; the caller may close `db` once this settles.
 */
export async function syncIndex(db: Database.Database, root: string, signal: AbortSignal): Promise<SyncReport> {
  const started = performance.now();
  const paths = notePaths(await scanVault(root));
  signal.throwIfAborted();
  const resolve = createLinkResolver(paths);
  const removed = applyPaths(db, paths, resolve);

  const select = db.prepare('SELECT id, hash, mtime_ms AS mtimeMs, size FROM notes WHERE path = ?');
  const stamp = db.prepare('UPDATE notes SET mtime_ms = ?, size = ? WHERE id = ?');
  const save = db.prepare('UPDATE notes SET hash = ?, mtime_ms = ?, size = ? WHERE id = ?');
  const dropText = db.prepare('DELETE FROM notes_fts WHERE rowid = ?');
  const addText = db.prepare('INSERT INTO notes_fts (rowid, title, body) VALUES (?, ?, ?)');
  const dropLinks = db.prepare('DELETE FROM links WHERE source = ?');
  const addLink = db.prepare(`
    INSERT INTO links (source, from_pos, to_pos, target_from, target_to, target, key, target_path, name, subpath, alias)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  let indexed = 0;
  let failed = 0;

  const indexNote = (path: string) => {
    const row = select.get(path) as Row;
    let bytes: Buffer;
    let mtimeMs: number;
    let size: number;
    try {
      const file = join(root, path);
      const stats = statSync(file);
      if (row.hash !== null && stats.mtimeMs === row.mtimeMs && stats.size === row.size) return;
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
      // Deleted since the scan, held by another program, no permission...
      failed++;
      return;
    }
    const hash = contentHash(bytes);
    if (hash === row.hash) {
      stamp.run(mtimeMs, size, row.id);
      return;
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
    indexed++;
  };

  let next = 0;
  const slice = db.transaction(() => {
    const deadline = performance.now() + SLICE_MS;
    while (next < paths.length && performance.now() < deadline) indexNote(paths[next++]!);
  });
  while (next < paths.length) {
    slice();
    await nextTurn();
    signal.throwIfAborted();
  }

  return { notes: paths.length, indexed, removed, failed, ms: Math.round(performance.now() - started) };
}
