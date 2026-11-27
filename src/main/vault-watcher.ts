// The open vault, kept up to date: the tree the renderer was told about and the index.
// Runs inside vault-worker only. Loaded by Node as-is in tests (type stripping): erasable
// TypeScript only, value imports of project files carry the `.ts` extension.
//
// What chokidar reports is only a hint that a path may have changed. Events come from
// comparing disk with what is known: folder listings for the tree, content hashes for the
// notes. So repeated, merged or missing reports cannot corrupt either one.
import { join, relative, sep } from 'node:path';
import { watch } from 'chokidar';
import type Database from 'better-sqlite3';
import type { TreeEntry, VaultEvent } from '../shared/ipc';
import { writeFileAtomic } from './atomic-write.ts';
import { contentHash, syncIndex, updateIndex, type NoteUpdate, type SyncReport } from './vault-index.ts';
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
  /** Opens the index; the watcher closes it. If it fails, only the index is lost. */
  openDb(): Promise<Database.Database>;
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
   * The app's own write of a note: atomic, indexed, and reported by no event. The folder
   * must exist. The caller validates `path` and updates its own tree.
   */
  write(path: string, content: string): Promise<void>;
  close(): Promise<void>;
}

type Kind = TreeEntry['kind'];

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

  const indexed = (async () => {
    // The scan comes after the watcher is listening: no change can fall between them.
    await watching;
    const tree = await serial(rescan);
    db = await openDb();
    signal.throwIfAborted();
    return sync(db, root, signal, { tree, onIndexed: (path) => syncRead.add(path) });
  })();
  indexed.catch(report('indexing'));

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
    const failed = await updateIndex(db!, root, paths, exists, signal, onNote, { trustStamp });
    for (const path of failed) retry(path);
    send(events);
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

  return {
    indexed,
    getTree: () => serial(async () => {
      const tree = await rescan();
      scheduleUpdate();
      return tree;
    }),
    write: (path, content) =>
      serial(async () => {
        const hash = contentHash(content);
        const hashes = expected.get(path) ?? [];
        expected.set(path, [...hashes, hash]);
        try {
          await writeFileAtomic(join(root, path), content);
        } catch (error) {
          expected.set(path, hashes);
          throw error;
        }
        // Known before the next batch compares the folder, so no `created` is reported.
        known?.get(parentOf(path))?.set(nameOf(path), 'note');
        stale.add(path);
        scheduleUpdate();
      }),
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
