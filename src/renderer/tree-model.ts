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

function insert(entries: TreeEntry[], entry: TreeEntry): TreeEntry[] {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (compareEntries(entries[middle]!, entry) < 0) low = middle + 1;
    else high = middle;
  }
  return entries.toSpliced(low, 0, entry);
}

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

/** `entries` is the content of the folder `segments[0..depth)`. Returns it as is if nothing changes. */
function applyAt(
  entries: TreeEntry[],
  type: 'created' | 'deleted',
  kind: TreeEntry['kind'],
  segments: string[],
  depth: number,
): TreeEntry[] {
  const path = segments.slice(0, depth + 1).join('/');
  const last = depth === segments.length - 1;
  const wanted = last ? kind : 'folder';
  const index = entries.findIndex((entry) => entry.path === path && entry.kind === wanted);
  const found = entries[index];

  if (last) {
    if (type === 'deleted') return found ? entries.toSpliced(index, 1) : entries;
    return found ? entries : insert(entries, newEntry(kind, segments[depth]!, path));
  }

  // A watcher may report a nested entry before its folder: the missing parents are created.
  if (!found && type === 'deleted') return entries;
  const folder = (found ?? newEntry('folder', segments[depth]!, path)) as Folder;
  const children = applyAt(folder.children, type, kind, segments, depth + 1);
  if (found && children === folder.children) return entries;
  const next: Folder = { ...folder, children };
  return found ? entries.with(index, next) : insert(entries, next);
}

/**
 * The tree after a batch of watcher events. Never mutates: unchanged parts keep their identity,
 * and the same array comes back if nothing changed. Applying a batch twice is harmless.
 * `changed` is about content, which the tree does not show.
 */
export function applyEvents(tree: TreeEntry[], events: VaultEvent[]): TreeEntry[] {
  let next = tree;
  for (const event of events) {
    if (event.type === 'changed' || !isListed(event.kind, event.path)) continue;
    next = applyAt(next, event.type, event.kind, event.path.split('/'), 0);
  }
  return next;
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
