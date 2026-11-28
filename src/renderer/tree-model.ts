// The logic behind FileTree.svelte, in plain TS: visible rows, watcher events, keyboard.
// Only `import type` from other files: scripts/tree-order.test.ts also loads this in Node.
import type { TreeEntry, VaultEvent } from '../shared/ipc';

// Same order as the scan (`main/vault-scan.ts`); scripts/tree-order.test.ts keeps them equal.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function compareEntries(a: TreeEntry, b: TreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

type Folder = Extract<TreeEntry, { kind: 'folder' }>;

/** Dot entries are never listed, and the only files listed are `.md` notes. */
function isListed(kind: TreeEntry['kind'], path: string): boolean {
  if (path.split('/').some((segment) => segment === '' || segment.startsWith('.'))) return false;
  return kind === 'folder' || /\.md$/i.test(path);
}

function newEntry(kind: TreeEntry['kind'], name: string, path: string): TreeEntry {
  return kind === 'folder'
    ? { kind, name, path, children: [] }
    : { kind, name: name.slice(0, -'.md'.length), path };
}

/** One folder's content while a batch is applied: built once however many events touch it. */
interface Listing {
  original: TreeEntry[];
  /** What the folder holds now, by `kind:path`. */
  current: Map<string, TreeEntry>;
  /** Keys of `original` entries that are gone. */
  removed: Set<string>;
  added: Map<string, TreeEntry>;
  /** Child folders an event went into, by key. */
  open: Map<string, Listing>;
}

const keyOf = (kind: TreeEntry['kind'], path: string) => `${kind}:${path}`;

function listing(entries: TreeEntry[]): Listing {
  const current = new Map(entries.map((entry) => [keyOf(entry.kind, entry.path), entry]));
  return { original: entries, current, removed: new Set(), added: new Map(), open: new Map() };
}

function add(into: Listing, key: string, entry: TreeEntry): void {
  into.current.set(key, entry);
  into.added.set(key, entry);
}

function remove(from: Listing, key: string): void {
  from.current.delete(key);
  from.open.delete(key);
  if (!from.added.delete(key)) from.removed.add(key);
}

function applyOne(root: Listing, type: 'created' | 'deleted', kind: TreeEntry['kind'], segments: string[]): void {
  let folder = root;
  for (let depth = 0; depth < segments.length - 1; depth++) {
    const path = segments.slice(0, depth + 1).join('/');
    const key = keyOf('folder', path);
    let child = folder.open.get(key);
    if (!child) {
      let entry = folder.current.get(key) as Folder | undefined;
      if (!entry) {
        // A watcher may report a nested entry before its folder: the missing parents are created.
        if (type === 'deleted') return;
        entry = newEntry('folder', segments[depth]!, path) as Folder;
        add(folder, key, entry);
      }
      child = listing(entry.children);
      folder.open.set(key, child);
    }
    folder = child;
  }
  const path = segments.join('/');
  const key = keyOf(kind, path);
  if (type === 'deleted') {
    if (folder.current.has(key)) remove(folder, key);
  } else if (!folder.current.has(key)) add(folder, key, newEntry(kind, segments.at(-1)!, path));
}

/** The folder's content after the batch: the same array if nothing changed. */
function close({ original, removed, added, open }: Listing): TreeEntry[] {
  const replaced = new Map<string, TreeEntry>();
  for (const [key, child] of open) {
    const entry = (added.get(key) ?? original.find((candidate) => keyOf(candidate.kind, candidate.path) === key)) as Folder;
    const children = close(child);
    if (children === entry.children) continue;
    const next: Folder = { ...entry, children };
    if (added.has(key)) added.set(key, next);
    else replaced.set(key, next);
  }
  if (removed.size === 0 && added.size === 0 && replaced.size === 0) return original;
  const kept: TreeEntry[] = [];
  for (const entry of original) {
    const key = keyOf(entry.kind, entry.path);
    if (!removed.has(key)) kept.push(replaced.get(key) ?? entry);
  }
  if (added.size === 0) return kept;
  // Both in order: merged in one pass.
  const fresh = [...added.values()].sort(compareEntries);
  const result: TreeEntry[] = [];
  let at = 0;
  for (const entry of fresh) {
    while (at < kept.length && compareEntries(kept[at]!, entry) < 0) result.push(kept[at++]!);
    result.push(entry);
  }
  while (at < kept.length) result.push(kept[at++]!);
  return result;
}

/**
 * The tree after a batch of watcher events. Never mutates: unchanged parts keep their identity,
 * and the same array comes back if nothing changed. Applying a batch twice is harmless.
 * Each folder is rebuilt once, so a large batch stays linear. `changed` is about content,
 * which the tree does not show.
 */
export function applyEvents(tree: TreeEntry[], events: VaultEvent[]): TreeEntry[] {
  let root: Listing | null = null;
  for (const event of events) {
    if (event.type === 'changed' || !isListed(event.kind, event.path)) continue;
    root ??= listing(tree);
    applyOne(root, event.type, event.kind, event.path.split('/'));
  }
  return root ? close(root) : tree;
}

/** Forgets the expanded state of deleted folders, so one created later starts collapsed. */
export function pruneExpanded(expanded: ReadonlySet<string>, events: VaultEvent[]): ReadonlySet<string> {
  const gone = events.flatMap((event) =>
    event.type === 'deleted' && event.kind === 'folder' ? [event.path] : [],
  );
  if (gone.length === 0) return expanded;
  return new Set(
    [...expanded].filter((path) => !gone.some((folder) => path === folder || path.startsWith(`${folder}/`))),
  );
}

/**
 * The tree of the open vault, kept up to date. It subscribes before asking for the tree, and
 * holds the batches that arrive meanwhile: they may or may not be in the reply already.
 * Returns the function that stops it.
 */
export function watchTree(
  api: {
    getTree(): Promise<TreeEntry[]>;
    onVaultEvents(listener: (events: VaultEvent[]) => void): () => void;
  },
  listener: {
    tree(tree: TreeEntry[], events: VaultEvent[]): void;
    error(reason: unknown): void;
  },
): () => void {
  let tree: TreeEntry[] | null = null;
  let early: VaultEvent[] = [];
  let stopped = false;

  const unsubscribe = api.onVaultEvents((events) => {
    if (!tree) {
      early = early.concat(events);
      return;
    }
    const next = applyEvents(tree, events);
    if (next === tree) return;
    tree = next;
    listener.tree(tree, events);
  });

  api.getTree().then(
    (loaded) => {
      if (stopped) return;
      tree = applyEvents(loaded, early);
      listener.tree(tree, early);
      early = [];
    },
    (reason: unknown) => {
      if (!stopped) listener.error(reason);
    },
  );

  return () => {
    stopped = true;
    unsubscribe();
  };
}

export interface TreeRow {
  entry: TreeEntry;
  /** 1 at the vault root (`aria-level`). */
  level: number;
  /** 1-based position among its siblings, and how many they are. */
  position: number;
  siblings: number;
}

/** The visible rows, top to bottom: everything not inside a collapsed folder. */
export function flatten(tree: TreeEntry[], expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (entries: TreeEntry[], level: number) => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      rows.push({ entry, level, position: i + 1, siblings: entries.length });
      if (entry.kind === 'folder' && expanded.has(entry.path)) walk(entry.children, level + 1);
    }
  };
  walk(tree, 1);
  return rows;
}

/** Rows to put in the DOM, `[start, end)`: those in view plus `overscan` on each side. */
export function visibleRange(
  scrollTop: number,
  viewHeight: number,
  rowHeight: number,
  count: number,
  overscan: number,
): { start: number; end: number } {
  const first = Math.floor(scrollTop / rowHeight);
  const last = Math.ceil((scrollTop + viewHeight) / rowHeight);
  // `scrollTop` may be past the end for one frame, right after the list shrinks.
  return {
    start: Math.max(0, Math.min(first, count - Math.ceil(viewHeight / rowHeight)) - overscan),
    end: Math.min(count, last + overscan),
  };
}

/** The folders of `paths` that the tree has. */
export function existingFolders(tree: TreeEntry[], paths: ReadonlySet<string>): ReadonlySet<string> {
  const found = new Set<string>();
  const walk = (entries: TreeEntry[]) => {
    for (const entry of entries) {
      if (entry.kind !== 'folder') continue;
      if (paths.has(entry.path)) found.add(entry.path);
      walk(entry.children);
    }
  };
  walk(tree);
  return found;
}

/**
 * Where the keyboard cursor goes when the tree changes: it stays on its row, or, if that
 * row is gone, takes the one now in its place. Never jumps to the top, where `Delete`
 * would aim at something else.
 */
export function cursorAfter(before: TreeRow[], cursor: string | null, after: TreeRow[]): string | null {
  const at = before.findIndex((row) => row.entry.path === cursor);
  if (at === -1 || after.some((row) => row.entry.path === cursor)) return cursor;
  // The first row that followed it and is still there, else the last one that preceded it.
  const kept = new Set(after.map((row) => row.entry.path));
  const next = before.slice(at + 1).find((row) => kept.has(row.entry.path));
  const previous = before.slice(0, at).findLast((row) => kept.has(row.entry.path));
  return (next ?? previous)?.entry.path ?? null;
}

/** The `scrollTop` that shows a row, moving as little as possible. */
export function scrollToShow(index: number, scrollTop: number, viewHeight: number, rowHeight: number): number {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  return Math.max(scrollTop, top + rowHeight - viewHeight);
}

export type KeyAction =
  | { type: 'move'; index: number }
  | { type: 'toggle'; path: string }
  | { type: 'open'; path: string }
  | { type: 'rename'; path: string }
  | { type: 'delete'; path: string };

/** The ARIA tree keys, with the cursor on `rows[index]`. `null`: nothing to do. */
export function keyAction(
  rows: TreeRow[],
  index: number,
  key: string,
  expanded: ReadonlySet<string>,
): KeyAction | null {
  const row = rows[index];
  if (!row) return null;
  const { entry, level } = row;
  const open = entry.kind === 'folder' && expanded.has(entry.path);
  const move = (to: number): KeyAction | null =>
    to === index || to < 0 || to >= rows.length ? null : { type: 'move', index: to };

  switch (key) {
    case 'ArrowDown':
      return move(index + 1);
    case 'ArrowUp':
      return move(index - 1);
    case 'Home':
      return move(0);
    case 'End':
      return move(rows.length - 1);
    case 'ArrowRight':
      if (entry.kind !== 'folder') return null;
      if (!open) return { type: 'toggle', path: entry.path };
      return entry.children.length > 0 ? move(index + 1) : null;
    case 'ArrowLeft': {
      if (open) return { type: 'toggle', path: entry.path };
      let parent = index - 1;
      while (parent >= 0 && rows[parent]!.level >= level) parent--;
      return move(parent);
    }
    case 'Enter':
    case ' ':
      return { type: entry.kind === 'folder' ? 'toggle' : 'open', path: entry.path };
    case 'Delete':
      return { type: 'delete', path: entry.path };
    case 'F2':
      return { type: 'rename', path: entry.path };
    default:
      return null;
  }
}
