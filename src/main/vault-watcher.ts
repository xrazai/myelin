// The open vault, kept up to date: the tree the renderer was told about and the index.
// Runs inside vault-worker only. Loaded by Node as-is in tests (type stripping): erasable
// TypeScript only, value imports of project files carry the `.ts` extension.
//
// What chokidar reports is only a hint that a path may have changed. Events come from
// comparing disk with what is known: folder listings for the tree, content hashes for the
// notes. So repeated, merged or missing reports cannot corrupt either one.
import { isUtf8 } from 'node:buffer';
import { lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { watch } from 'chokidar';
import type Database from 'better-sqlite3';
import type { DeleteInfo, FolderRenameResult, RenameResult, TreeEntry, VaultEvent, WriteResult } from '../shared/ipc';
import { createLinkResolver, folderNameProblem, noteNameProblem, rewriteLinksForMoves } from '../shared/links.ts';
import { renameWithRetry, writeFileAtomic, type AtomicWriteDeps } from './atomic-write.ts';
import {
  contentHash,
  countLinkingNotes,
  isDamaged,
  notePaths,
  renameCandidates,
  syncIndex,
  updateIndex,
  type NoteUpdate,
  type SyncReport,
} from './vault-index.ts';
import {
  existingExactPath,
  existingItemPath,
  existingNotePath,
  folderOnDiskInOtherCase,
  newFolderPath,
  writableNotePath,
} from './vault-path.ts';
import { listFolder, scanFolder, scanVault } from './vault-scan.ts';

/** Hints are handled in one batch: after a quiet moment, or this long after the first. */
const QUIET_MS = 60;
const MAX_WAIT_MS = 500;
/** After Windows drops reports, the whole vault is scanned once they stop being dropped. */
const LOST_QUIET_MS = 1000;
/** Waits before reading again a note that another program was holding. */
const RETRY_MS: readonly number[] = [200, 1000, 5000];
/** File times can be a little behind the clock. */
const CLOCK_SLACK_MS = 2000;

export interface VaultWatchOptions {
  /**
   * Opens the index; the watcher closes it. With `damaged`, the file (closed by then) is
   * deleted first. If it fails, only the index is lost.
   */
  openDb(damaged?: boolean): Promise<Database.Database>;
  /** Changes made outside the app. Never called after `close`. */
  emit(events: VaultEvent[]): void;
  /** Replaced in tests to hold the first sync. */
  sync?: typeof syncIndex;
}

export interface VaultWatch {
  /** The first index sync. Changes seen while it runs reach the index after it. */
  indexed: Promise<SyncReport>;
  getTree(): Promise<TreeEntry[]>;
  /**
   * The app's own write of a note: atomic, indexed, and reported by no event, except
   * `created` for what it adds to the tree. Writes only over `base` (`null`: no note), and
   * never over a note that is not UTF-8. The folder must exist. The caller validates `path`.
   */
  write(path: string, content: string, base: string | null): Promise<WriteResult>;
  /**
   * `renameNote` of the contract, in one batch: moves the file, rewrites links, emits the
   * events and updates the index once. Rewrites are link-only. Validates both paths.
   * Callers must have saved their own edits first.
   */
  rename(from: string, to: string): Promise<RenameResult>;
  /** `renameFolder` of the contract: the same batch, for a folder and all in it. */
  renameFolder(from: string, to: string): Promise<FolderRenameResult>;
  /** `createFolder` of the contract: its `created` event is sent before it resolves. */
  createFolder(path: string): Promise<void>;
  /** `deleteInfo` of the contract. */
  deleteInfo(path: string, kind: Kind): Promise<DeleteInfo>;
  /**
   * `deleteItem` of the contract: `trash` moves the validated OS path to the Recycle Bin.
   * No write or rename runs meanwhile.
   */
  remove(path: string, kind: Kind, trash: (path: string) => Promise<void>): Promise<string[]>;
  close(): Promise<void>;
}

type Kind = TreeEntry['kind'];

/**
 * What is under the folder `path` (`dir` on disk): the notes the tree shows, and how many
 * files it does not. Links are counted, never followed.
 */
async function contentsOf(dir: string, path: string, hidden = false): Promise<{ notes: string[]; otherFiles: number }> {
  const total = { notes: [] as string[], otherFiles: 0 };
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const concealed = hidden || entry.name.startsWith('.');
    // As the scan does: Windows `readdir` calls cloud placeholders links; `lstat` does not.
    const stats = entry.isSymbolicLink() ? await lstat(join(dir, entry.name)) : entry;
    if (stats.isDirectory()) {
      const inside = await contentsOf(join(dir, entry.name), `${path}/${entry.name}`, concealed);
      total.notes.push(...inside.notes);
      total.otherFiles += inside.otherFiles;
    } else if (!concealed && stats.isFile() && /\.md$/i.test(entry.name)) {
      total.notes.push(`${path}/${entry.name}`);
    } else {
      total.otherFiles++;
    }
  }
  return total;
}

/** The disk did not hold what a write expected. */
class Conflict extends Error {
  readonly disk: string | null;
  constructor(disk: string | null) {
    super('the note changed on disk');
    this.disk = disk;
  }
}

/** The note's bytes, `null` if there is none. */
async function readBytes(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Throws unless the disk holds `base`. `true`: it already holds `content`, so there is
 * nothing to write.
 */
async function checkBase(file: string, content: string, base: string | null): Promise<boolean> {
  const bytes = await readBytes(file);
  if (bytes?.equals(Buffer.from(content, 'utf8'))) return true;
  // Its text cannot be written back byte by byte: writing would destroy it.
  if (bytes && !isUtf8(bytes)) throw new Error('this file is not UTF-8 text, so Myelin does not overwrite it');
  const holds = base === null ? bytes === null : bytes?.equals(Buffer.from(base, 'utf8')) === true;
  if (!holds) throw new Conflict(bytes?.toString('utf8') ?? null);
  return false;
}

/** Write deps that replace `file` only while the disk holds `base`. */
function onlyOver(file: string, content: string, base: string | null): AtomicWriteDeps {
  return {
    // Checked again right before each rename attempt: another program may write while
    // the temp file is flushed, or while the note is held.
    async rename(from, to) {
      if (await checkBase(file, content, base)) return rm(from);
      await rename(from, to);
    },
    sleep,
  };
}

/** `true` if something other than the file at `from` is at `to`. A change of case is not. */
async function isTaken(from: string, to: string): Promise<boolean> {
  const target = await stat(to, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!target) return false;
  const source = await stat(from, { bigint: true });
  return source.ino !== target.ino || source.dev !== target.dev;
}

/** A folder on the way to `path` that exists spelled in another case, as the disk spells it. */
function folderInOtherCase(tree: TreeEntry[], path: string): string | null {
  let entries = tree;
  for (const segment of path.split('/').slice(0, -1)) {
    const folders = entries.filter((entry) => entry.kind === 'folder');
    const exact = folders.find((entry) => entry.name === segment);
    if (!exact) return folders.find((entry) => entry.name.toLowerCase() === segment.toLowerCase())?.path ?? null;
    entries = exact.children;
  }
  return null;
}

/** A name as links compare it: composition and case ignored. */
const foldName = (name: string) => name.normalize('NFC').toLowerCase();
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const join2 = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const depth = (path: string) => (path ? path.split('/').length : 0);
const isHidden = (path: string) => path.split('/').some((segment) => segment.startsWith('.'));

export function watchVault(root: string, { openDb, emit, sync = syncIndex }: VaultWatchOptions): VaultWatch {
  const cancel = new AbortController();
  const { signal } = cancel;
  const started = Date.now();
  const send = (events: VaultEvent[]) => {
    if (!signal.aborted && events.length > 0) emit(events);
  };
  const report = (what: string) => (error: unknown) => {
    if (!signal.aborted) console.error(`[vault-watcher] ${what} failed:`, error);
  };

  // The tree as last reported: each folder (`''` is the root) with its entries by name on
  // disk. `null` until the first scan.
  let known: Map<string, Map<string, Kind>> | null = null;
  /** Hints waiting for the next batch. */
  const hintedDirs = new Set<string>();
  const hintedNotes = new Set<string>();
  /** Notes waiting for the index. */
  const stale = new Set<string>();
  /** Hashes of the app's own writes not seen back yet, oldest first. */
  const expected = new Map<string, string[]>();
  /** Paths whose next index update is a rename's link-only rewrite. */
  const linkOnly = new Set<string>();
  /** Notes hinted during the first sync, and notes it indexed. */
  let hintedInSync: Set<string> | null = new Set();
  const syncRead = new Set<string>();

  const exists = (path: string) => known?.get(parentOf(path))?.get(nameOf(path)) === 'note';

  // Everything that reads or changes `known` runs here, one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(() => {
      signal.throwIfAborted();
      return task();
    });
    queue = result.catch(() => {});
    return result;
  }

  function forget(path: string, kind: Kind, events: VaultEvent[]): void {
    if (kind === 'folder') {
      for (const [name, child] of known!.get(path) ?? []) forget(join2(path, name), child, events);
      known!.delete(path);
    } else {
      stale.add(path);
    }
    known!.get(parentOf(path))?.delete(nameOf(path));
    events.push({ type: 'deleted', kind, path });
  }

  function learn(entry: TreeEntry, events: VaultEvent[] | null): void {
    known!.get(parentOf(entry.path))!.set(nameOf(entry.path), entry.kind);
    events?.push({ type: 'created', kind: entry.kind, path: entry.path });
    if (entry.kind === 'folder') {
      known!.set(entry.path, new Map());
      for (const child of entry.children) learn(child, events);
    } else if (events) {
      stale.add(entry.path);
    }
  }

  /** Forgets what is in `dir` and not in `found`. */
  function prune(dir: string, found: Map<string, Kind>, events: VaultEvent[]): void {
    for (const [name, kind] of known!.get(dir)!) {
      if (found.get(name) !== kind) forget(join2(dir, name), kind, events);
    }
  }

  function compareTree(dir: string, entries: TreeEntry[], events: VaultEvent[]): void {
    prune(dir, new Map(entries.map((entry) => [nameOf(entry.path), entry.kind])), events);
    for (const entry of entries) {
      if (!known!.get(dir)!.has(nameOf(entry.path))) learn(entry, events);
      else if (entry.kind === 'folder') compareTree(entry.path, entry.children, events);
    }
  }

  /** Scans the whole vault and reports how it differs from what was known. */
  async function rescan(): Promise<TreeEntry[]> {
    const tree = await scanVault(root);
    signal.throwIfAborted();
    const events: VaultEvent[] = [];
    if (known) {
      compareTree('', tree, events);
    } else {
      known = new Map([['', new Map()]]);
      for (const entry of tree) learn(entry, null);
    }
    send(events);
    return tree;
  }

  /** Compares one folder's listing with what was known; new folders are walked in full. */
  async function compareFolder(dir: string, events: VaultEvent[]): Promise<void> {
    while (dir && !known!.has(dir)) dir = parentOf(dir);
    let listed = await listFolder(root, dir);
    while (!listed && dir) {
      dir = parentOf(dir);
      listed = await listFolder(root, dir);
    }
    signal.throwIfAborted();
    // The vault folder itself is unreachable (drive gone): nothing says its notes were deleted.
    if (!listed) return;
    prune(dir, new Map(listed.map(({ name, kind }) => [name, kind])), events);
    for (const { name, kind } of listed) {
      if (known!.get(dir)!.has(name)) continue;
      const path = join2(dir, name);
      if (kind === 'note') {
        learn({ kind, name: name.slice(0, -'.md'.length), path }, events);
      } else {
        const children = await scanFolder(root, path);
        signal.throwIfAborted();
        if (children) learn({ kind, name, path, children }, events);
      }
    }
  }

  let quiet: NodeJS.Timeout | undefined;
  let deadline: NodeJS.Timeout | undefined;
  function stopBatchTimers(): void {
    clearTimeout(quiet);
    clearTimeout(deadline);
    quiet = deadline = undefined;
  }

  function flush(): void {
    stopBatchTimers();
    serial(async () => {
      const dirs = [...hintedDirs].sort((a, b) => depth(a) - depth(b));
      const notes = [...hintedNotes];
      hintedDirs.clear();
      const events: VaultEvent[] = [];
      // Before the first scan there is nothing to compare: that scan sees the disk as it is.
      if (known) for (const dir of dirs) await compareFolder(dir, events);
      send(events);
      // Only now do these reach the index: it must see what the comparison found.
      for (const path of notes) {
        hintedNotes.delete(path);
        stale.add(path);
      }
      scheduleUpdate();
    }).catch(report('reading changes'));
  }

  /** `path` (relative, `/`) may have been created, changed or deleted. */
  function hint(path: string): void {
    if (signal.aborted || isHidden(path)) return;
    hintedDirs.add(parentOf(path));
    if (known?.has(path)) hintedDirs.add(path);
    if (/\.md$/i.test(path)) {
      hintedNotes.add(path);
      hintedInSync?.add(path);
    }
    clearTimeout(quiet);
    quiet = setTimeout(flush, QUIET_MS);
    deadline ??= setTimeout(flush, MAX_WAIT_MS);
  }

  // Windows drops reports when they come faster than they are read, and says so each time:
  // hundreds of times while the first sync of an old vault moves last-access times. chokidar
  // finds what really changed meanwhile; one scan then covers what it cannot see.
  let lost: NodeJS.Timeout | undefined;
  function scanAfterLoss(): void {
    clearTimeout(lost);
    lost = setTimeout(() => {
      serial(rescan).then(scheduleUpdate).catch(report('rescanning'));
    }, LOST_QUIET_MS);
  }

  const toRelative = (path: string) => relative(root, path).split(sep).join('/');

  const watcher = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    ignorePermissionErrors: true,
    atomic: false,
    // Dot entries and files other than notes, `*.tmp` included.
    ignored(path, stats) {
      const inside = toRelative(path);
      if (inside === '' || inside.startsWith('../')) return false;
      return isHidden(inside) || (stats?.isFile() === true && !/\.md$/i.test(inside));
    },
  });
  watcher.on('all', (_event, path) => hint(toRelative(path)));
  // chokidar says nothing about some changes (a case-only rename back and forth on
  // Windows), but the native reports behind it always arrive.
  watcher.on('raw', (_event, path, details) => {
    // No path means reports were lost.
    if (!path) {
      if (!signal.aborted) scanAfterLoss();
      return;
    }
    if (/\.tmp$/i.test(path)) return;
    const { watchedPath } = details as { watchedPath: string };
    hint(toRelative(join(watchedPath, path)));
  });
  watcher.on('error', report('watching'));
  const watching = new Promise<void>((resolve, reject) => {
    watcher.once('ready', () => resolve());
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });

  let db: Database.Database | null = null;
  let rebuilt = false;

  /**
   * Damage SQLite finds only when it reaches the page: replaces the index with a new one,
   * synced in full. Once per open; damage that comes back is thrown, like any other error.
   */
  async function rebuild(error: unknown, onIndexed?: (path: string) => void): Promise<SyncReport> {
    if (signal.aborted || rebuilt || !isDamaged(error)) throw error;
    rebuilt = true;
    console.error('[vault-watcher] index.db is damaged, rebuilding it:', error);
    db!.close();
    db = null;
    db = await openDb(true);
    signal.throwIfAborted();
    return sync(db, root, signal, { onIndexed });
  }

  const indexed = (async () => {
    // The scan comes after the watcher is listening: no change can fall between them.
    await watching;
    const tree = await serial(rescan);
    db = await openDb();
    signal.throwIfAborted();
    const onIndexed = (path: string) => void syncRead.add(path);
    // The rebuild scans again: this tree may be old by then.
    return sync(db, root, signal, { tree, onIndexed }).catch((error: unknown) => rebuild(error, onIndexed));
  })();
  indexed.catch(report('indexing'));
  /** The first sync finished: only then does the index know every link. */
  let synced = false;
  void indexed.then(
    () => (synced = true),
    () => {},
  );

  /** True if `hash` is one the app wrote; forgets it and the older ones. */
  function isOwnWrite(path: string, hash: string): boolean {
    const hashes = expected.get(path);
    const found = hashes?.indexOf(hash) ?? -1;
    if (found === -1) return false;
    hashes!.splice(0, found + 1);
    if (hashes!.length === 0) expected.delete(path);
    return true;
  }

  const failures = new Map<string, number>();
  const retries = new Set<NodeJS.Timeout>();
  function retry(path: string): void {
    const count = failures.get(path) ?? 0;
    const wait = RETRY_MS[count];
    if (wait === undefined || !exists(path)) {
      failures.delete(path);
      return;
    }
    failures.set(path, count + 1);
    const timer = setTimeout(() => {
      retries.delete(timer);
      stale.add(path);
      scheduleUpdate();
    }, wait);
    retries.add(timer);
  }

  async function update(ready: boolean): Promise<void> {
    if (signal.aborted || stale.size === 0) return;
    const paths = [...stale];
    stale.clear();
    // Without an index there are no hashes: every touched note counts as changed.
    if (!ready) {
      send(paths.filter((path) => exists(path) && !expected.delete(path)).map((path) => ({ type: 'changed', path })));
      return;
    }
    const events: VaultEvent[] = [];
    const onNote = ({ path, hash, previous, mtimeMs }: NoteUpdate) => {
      linkOnly.delete(path);
      failures.delete(path);
      const differs = hash !== previous;
      // The first sync may have read a change before this could compare it.
      const readBySync =
        hintedInSync?.has(path) === true && syncRead.has(path) && mtimeMs >= started - CLOCK_SLACK_MS;
      if (isOwnWrite(path, hash)) return;
      if (differs) expected.delete(path);
      // A note new to the index was reported as `created`.
      if ((differs && previous !== null) || readBySync) events.push({ type: 'changed', path });
    };
    // While the first sync reads the vault, Windows reports each note whose last-access
    // time that moved. Reading all of them again would double the cost of the sync.
    const trustStamp = hintedInSync !== null;
    let failed: string[];
    try {
      failed = await updateIndex(db!, root, paths, exists, signal, onNote, { trustStamp, linkOnly });
    } catch (error) {
      if (!isDamaged(error)) throw error;
      await replaceIndex(error, paths);
      return;
    }
    for (const path of failed) retry(path);
    send(events);
  }

  /** Rebuilds an index an update found damaged. If it cannot, the vault goes on without one. */
  async function replaceIndex(error: unknown, paths: string[]): Promise<void> {
    try {
      await rebuild(error);
    } catch (failure) {
      ready = false;
      throw failure;
    } finally {
      // The hashes that told what changed are gone, and the new ones may already hold what
      // is still waiting: all of it counts as changed. The renderer compares content.
      const waiting = new Set([...paths, ...stale, ...hintedNotes]);
      for (const path of waiting) expected.delete(path);
      send([...waiting].filter(exists).map((path) => ({ type: 'changed', path })));
    }
  }

  // Index updates wait for the first sync, then run one at a time.
  let ready = false;
  let updates: Promise<void> = indexed.then(
    () => {
      ready = true;
    },
    () => {},
  );
  function scheduleUpdate(): void {
    updates = updates.then(async () => {
      await update(ready);
      // What the first sync read matters only to the first update after it.
      if (hintedInSync && hintedNotes.size === 0) {
        hintedInSync = null;
        syncRead.clear();
      }
    }).catch(report('updating the index'));
  }
  // Changes seen during the sync, even if no more arrive.
  scheduleUpdate();

  async function renameNow(from: string, to: string): Promise<RenameResult> {
    const fromFile = await existingNotePath(root, from).catch((error: NodeJS.ErrnoException) => {
      throw error.code === 'ENOENT' ? new Error(`no such note: ${from}`) : error;
    });
    const toFile = await writableNotePath(root, to);
    if (from === to) return { notUpdated: [] };
    const problem = noteNameProblem(to);
    if (problem) throw new Error(problem);

    const tree = await scanVault(root);
    signal.throwIfAborted();
    const paths = notePaths(tree);
    if (!paths.includes(from)) throw new Error(`no such note: ${from}`);
    const taken = `a note already exists at ${to}`;
    if (paths.includes(to) || (await isTaken(fromFile, toFile))) throw new Error(taken);
    // Another spelling of the same accented name: links could not tell the two apart.
    if (paths.some((path) => path !== from && foldName(path) === foldName(to))) throw new Error(taken);
    // Windows would put the note in that folder, under a path the app does not know.
    const folder = folderInOtherCase(tree, to);
    if (folder !== null) throw new Error(`the folder is named ${folder}`);

    const { notUpdated } = await moveBatch(paths, new Map([[from, to]]), {
      from: fromFile,
      to: toFile,
      taken,
      folders: [parentOf(from), parentOf(to)],
    });
    return { notUpdated };
  }

  async function renameFolderNow(from: string, to: string): Promise<FolderRenameResult> {
    const fromFolder = await existingExactPath(root, from, 'folder');
    if (from === to) return { notUpdated: [], moved: [] };
    if (typeof to === 'string' && to.toLowerCase().startsWith(`${from.toLowerCase()}/`)) {
      throw new Error('a folder cannot move into itself');
    }
    const toFolder = await newFolderPath(root, to);
    // Only the new name: the folders above it exist, however they are named.
    const problem = folderNameProblem(nameOf(to));
    if (problem) throw new Error(problem);
    const taken = `something is already named ${to}`;
    if (await isTaken(fromFolder, toFolder)) throw new Error(taken);
    // NTFS keeps two spellings of an accented name apart; links do not.
    const siblings = await readdir(dirname(toFolder));
    const twin = siblings.some(
      (name) => foldName(name) === foldName(nameOf(to)) && !(parentOf(from) === parentOf(to) && name === nameOf(from)),
    );
    if (twin) throw new Error(taken);
    const other = await folderOnDiskInOtherCase(root, to);
    if (other !== null) throw new Error(`the folder is named ${other}`);

    const tree = await scanVault(root);
    signal.throwIfAborted();
    const moves = new Map(
      (await contentsOf(fromFolder, from)).notes.map((path) => [path, `${to}${path.slice(from.length)}`]),
    );
    const { notUpdated } = await moveBatch(notePaths(tree), moves, {
      from: fromFolder,
      to: toFolder,
      taken,
      folders: [parentOf(from), parentOf(to)],
    });
    return { notUpdated, moved: [...moves] };
  }

  /**
   * Moves one file or folder, which takes the notes in `moves` along, and rewrites the
   * links of the vault to match: one batch, with one report and one index update.
   * `disk`: the OS paths, why a taken destination is refused, and the folders to compare.
   */
  async function moveBatch(
    paths: string[],
    moves: ReadonlyMap<string, string>,
    disk: { from: string; to: string; taken: string; folders: string[] },
  ): Promise<RenameResult> {
    const oldResolve = createLinkResolver(paths);
    const newResolve = createLinkResolver(paths.map((path) => moves.get(path) ?? path));

    // Without a usable index, every note is read.
    await updates;
    let candidates = paths;
    if (ready) {
      try {
        candidates = renameCandidates(db!, root, paths, moves);
      } catch (error) {
        console.error('[vault-watcher] the index cannot tell which notes to read:', error);
      }
    }

    // Every rewrite is computed before the disk is touched. Files that are not UTF-8 are
    // never overwritten.
    const rewrites: { path: string; base: string; content: string }[] = [];
    const unwritable: string[] = [];
    for (const path of candidates) {
      const bytes = await readFile(join(root, path));
      if (!bytes.includes('[[')) continue;
      // Decoded with losses if it is not UTF-8: enough to tell whether a link has to change.
      const base = bytes.toString('utf8');
      const bom = base.startsWith('\uFEFF') ? '\uFEFF' : '';
      const { text, count } = rewriteLinksForMoves(base.slice(bom.length), path, moves, oldResolve, newResolve);
      if (count === 0) continue;
      if (isUtf8(bytes)) rewrites.push({ path: moves.get(path) ?? path, base, content: bom + text });
      else unwritable.push(moves.get(path) ?? path);
    }
    signal.throwIfAborted();

    await mkdir(dirname(disk.to), { recursive: true });
    await renameWithRetry(disk.from, disk.to, {
      // Checked right before moving: what another program just made is not replaced.
      async rename(source, target) {
        if (await isTaken(source, target)) throw new Error(disk.taken);
        await rename(source, target);
      },
      sleep,
    });

    // From here on the notes have moved: a link that cannot be rewritten is reported, not thrown.
    const notUpdated: string[] = [...unwritable];
    const rewritten: string[] = [];
    for (const { path, base, content } of rewrites) {
      const file = join(root, path);
      const hashes = expected.get(path) ?? [];
      expected.set(path, [...hashes, contentHash(content)]);
      try {
        await writeFileAtomic(file, content, onlyOver(file, content, base));
        rewritten.push(path);
      } catch (error) {
        expected.set(path, hashes);
        notUpdated.push(path);
        console.error(`[vault-watcher] updating the links in ${path} failed:`, error);
      }
    }

    // One batch, sent before the result: the tree, then the notes whose text changed. The
    // renderer reads the moved notes itself.
    const events: VaultEvent[] = [];
    if (known) for (const folder of new Set(disk.folders)) await compareFolder(folder, events);
    const destinations = new Set(moves.values());
    for (const path of rewritten) if (!destinations.has(path)) events.push({ type: 'changed', path });
    send(events);

    // One index update, in the same chain as every other. Link-only rewrites are not
    // content changes for the heavy path.
    for (const path of rewritten) linkOnly.add(path);
    for (const path of [...[...moves].flat(), ...rewritten, ...notUpdated]) stale.add(path);
    scheduleUpdate();
    await updates;
    return { notUpdated };
  }

  return {
    indexed,
    getTree: () => serial(async () => {
      const tree = await rescan();
      scheduleUpdate();
      return tree;
    }),
    write: (path, content, base) =>
      serial(async (): Promise<WriteResult> => {
        const file = join(root, path);
        const hashes = expected.get(path) ?? [];
        try {
          if (await checkBase(file, content, base)) return { status: 'saved' };
          expected.set(path, [...hashes, contentHash(content)]);
          await writeFileAtomic(file, content, onlyOver(file, content, base));
        } catch (error) {
          expected.set(path, hashes);
          if (error instanceof Conflict) return { status: 'conflict', disk: error.disk };
          throw error;
        }
        if (known && !exists(path)) {
          // New to the tree, maybe with its folders: reported like any other.
          const events: VaultEvent[] = [];
          await compareFolder(parentOf(path), events);
          send(events);
        }
        stale.add(path);
        scheduleUpdate();
        return { status: 'saved' };
      }),
    async deleteInfo(path, kind) {
      const file = await serial(() => existingItemPath(root, path, kind));
      let counted = { notes: 1, otherFiles: 0 };
      if (kind === 'folder') {
        const inside = await contentsOf(file, path);
        counted = { notes: inside.notes.length, otherFiles: inside.otherFiles };
      }
      // Before the whole vault is indexed a count would be too low: unknown, never 0.
      let linkedFrom: number | null = null;
      if (synced) {
        await updates;
        try {
          if (db) linkedFrom = countLinkingNotes(db, path, kind);
        } catch (error) {
          console.error('[vault-watcher] counting the linking notes failed:', error);
        }
      }
      return { ...counted, linkedFrom };
    },
    remove: (path, kind, trash) =>
      serial(async () => {
        const file = await existingItemPath(root, path, kind);
        // Listed right before the move: only these notes are in the bin afterwards.
        const notes = kind === 'note' ? [path] : (await contentsOf(file, path)).notes;
        try {
          await trash(file);
        } catch (error) {
          const part = kind === 'folder' ? ' Part of it may be there already.' : '';
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`could not move ${path} to the Recycle Bin: ${reason}.${part}`);
        } finally {
          // Whatever happened, the tree and the index show what is left. A full scan: part
          // of a folder may have gone.
          if (known) await rescan();
          scheduleUpdate();
        }
        return notes;
      }),
    createFolder: (path) =>
      serial(async () => {
        const folder = await newFolderPath(root, path);
        // Only the new name: the folders above it exist, however they are named.
        const problem = folderNameProblem(path.slice(path.lastIndexOf('/') + 1));
        if (problem) throw new Error(problem);
        const other = await folderOnDiskInOtherCase(root, path);
        if (other !== null) throw new Error(`the folder is named ${other}`);
        // Not recursive: anything already there, in any case, refuses it.
        await mkdir(folder).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
          throw new Error(`something is already named ${path}`);
        });
        if (!known) return;
        const events: VaultEvent[] = [];
        await compareFolder(parentOf(path), events);
        send(events);
      }),
    async renameFolder(from, to) {
      // As `rename`: waits for the first sync outside the queue.
      await indexed.catch(() => {});
      return serial(() => renameFolderNow(from, to));
    },
    async rename(from, to) {
      // Waits outside the queue: the first sync itself needs a turn in it, and saves must
      // not wait for the whole sync.
      await indexed.catch(() => {});
      return serial(() => renameNow(from, to));
    },
    async close() {
      cancel.abort(new Error('indexing was cancelled'));
      stopBatchTimers();
      clearTimeout(lost);
      for (const timer of retries) clearTimeout(timer);
      await watcher.close();
      await indexed.catch(() => {});
      await queue;
      await updates;
      db?.close();
      db = null;
    },
  };
}
