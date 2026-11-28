import { expect, test, vi } from 'vitest';
import type { TreeEntry, VaultEvent } from '../shared/ipc';
import { applyEvents, cursorAfter, flatten, keyAction, pruneExpanded, scrollToShow, visibleRange, watchTree } from './tree-model';

const note = (path: string): TreeEntry => ({
  kind: 'note',
  name: path.split('/').at(-1)!.slice(0, -3),
  path,
});
const folder = (path: string, children: TreeEntry[] = []): TreeEntry => ({
  kind: 'folder',
  name: path.split('/').at(-1)!,
  path,
  children,
});
const created = (kind: TreeEntry['kind'], path: string): VaultEvent => ({ type: 'created', kind, path });
const deleted = (kind: TreeEntry['kind'], path: string): VaultEvent => ({ type: 'deleted', kind, path });

const sample = () => [
  folder('Areas', [folder('Areas/Garden', [note('Areas/Garden/Soil.md')]), note('Areas/Index.md')]),
  folder('Empty'),
  note('Home.md'),
];

const paths = (tree: TreeEntry[], open: string[] = []) =>
  flatten(tree, new Set(open)).map((row) => row.entry.path);

test('created entries land in the order of the scan', () => {
  const tree = applyEvents(sample(), [
    created('note', 'Note 10.md'),
    created('note', 'Note 9.md'),
    created('note', 'água.md'),
    created('folder', 'Zeta'),
  ]);
  expect(paths(tree)).toEqual(['Areas', 'Empty', 'Zeta', 'água.md', 'Home.md', 'Note 9.md', 'Note 10.md']);
  expect(tree[3]).toEqual({ kind: 'note', name: 'água', path: 'água.md' });
});

test('missing parent folders are created, whatever the order of the events', () => {
  const tree = applyEvents([], [created('note', 'a/b/c.md'), created('folder', 'a'), created('folder', 'a/b')]);
  expect(tree).toEqual([folder('a', [folder('a/b', [note('a/b/c.md')])])]);
});

test('deleting a folder removes everything under it, and later deletes of its content are harmless', () => {
  const tree = applyEvents(sample(), [deleted('folder', 'Areas'), deleted('note', 'Areas/Index.md')]);
  expect(paths(tree)).toEqual(['Empty', 'Home.md']);
});

test('an external rename (deleted + created) moves the note to its new place', () => {
  const tree = applyEvents(sample(), [deleted('note', 'Home.md'), created('note', 'Areas/Garden/Home.md')]);
  expect(paths(tree, ['Areas', 'Areas/Garden'])).toEqual([
    'Areas',
    'Areas/Garden',
    'Areas/Garden/Home.md',
    'Areas/Garden/Soil.md',
    'Areas/Index.md',
    'Empty',
  ]);
});

test('events that change nothing return the same tree', () => {
  const tree = sample();
  const same = applyEvents(tree, [
    { type: 'changed', path: 'Home.md' },
    created('note', 'Home.md'),
    created('folder', 'Areas'),
    deleted('note', 'Missing.md'),
    deleted('note', 'Nowhere/Missing.md'),
    deleted('folder', 'Home.md'),
    created('note', '.myelin/hidden.md'),
    created('folder', '.obsidian'),
    created('note', 'image.png'),
    created('note', 'Home.md.tmp'),
  ]);
  expect(same).toBe(tree);
});

test('applying a batch never mutates the tree and keeps untouched folders', () => {
  const tree = sample();
  const before = structuredClone(tree);
  const next = applyEvents(tree, [created('note', 'Areas/Garden/Water.md')]);
  expect(tree).toEqual(before);
  expect(next).not.toBe(tree);
  expect(next[1]).toBe(tree[1]);
  expect(applyEvents(next, [created('note', 'Areas/Garden/Water.md')])).toBe(next);
});

test('deleted folders lose their expanded state, with their subfolders', () => {
  const expanded = new Set(['a', 'a/b', 'ab']);
  expect(pruneExpanded(expanded, [deleted('folder', 'a')])).toEqual(new Set(['ab']));
  expect(pruneExpanded(expanded, [deleted('note', 'a'), created('folder', 'z')])).toBe(expanded);
});

test('flatten lists only what open folders show, with the ARIA numbers', () => {
  expect(paths(sample())).toEqual(['Areas', 'Empty', 'Home.md']);
  // A folder marked open inside a closed one stays hidden.
  expect(paths(sample(), ['Areas/Garden'])).toEqual(['Areas', 'Empty', 'Home.md']);
  const rows = flatten(sample(), new Set(['Areas']));
  expect(rows.map((row) => [row.level, row.position, row.siblings])).toEqual([
    [1, 1, 3],
    [2, 1, 2],
    [2, 2, 2],
    [1, 2, 3],
    [1, 3, 3],
  ]);
});

test('visibleRange keeps the DOM small and inside the list', () => {
  expect(visibleRange(0, 240, 24, 10_000, 5)).toEqual({ start: 0, end: 15 });
  expect(visibleRange(2400, 240, 24, 10_000, 5)).toEqual({ start: 95, end: 115 });
  expect(visibleRange(24 * 9990, 240, 24, 10_000, 5)).toEqual({ start: 9985, end: 10_000 });
  expect(visibleRange(0, 240, 24, 3, 5)).toEqual({ start: 0, end: 3 });
  // Stale scroll position right after collapsing a big folder.
  expect(visibleRange(24 * 5000, 240, 24, 20, 5)).toEqual({ start: 5, end: 20 });
});

test('scrollToShow moves only when the row is out of view', () => {
  expect(scrollToShow(5, 0, 240, 24)).toBe(0);
  expect(scrollToShow(10, 0, 240, 24)).toBe(24);
  expect(scrollToShow(2, 240, 240, 24)).toBe(48);
});

test('keyboard follows the ARIA tree pattern', () => {
  const closed = new Set<string>();
  const open = new Set(['Areas', 'Empty']);
  const rows = flatten(sample(), open);
  // 0 Areas, 1 Areas/Garden, 2 Areas/Index.md, 3 Empty, 4 Home.md
  expect(keyAction(rows, 0, 'ArrowDown', open)).toEqual({ type: 'move', index: 1 });
  expect(keyAction(rows, 0, 'ArrowUp', open)).toBeNull();
  expect(keyAction(rows, 0, 'End', open)).toEqual({ type: 'move', index: 4 });
  expect(keyAction(rows, 4, 'Home', open)).toEqual({ type: 'move', index: 0 });
  expect(keyAction(rows, 0, 'ArrowRight', open)).toEqual({ type: 'move', index: 1 });
  expect(keyAction(rows, 1, 'ArrowRight', open)).toEqual({ type: 'toggle', path: 'Areas/Garden' });
  expect(keyAction(rows, 3, 'ArrowRight', open)).toBeNull();
  expect(keyAction(rows, 0, 'ArrowLeft', open)).toEqual({ type: 'toggle', path: 'Areas' });
  expect(keyAction(rows, 2, 'ArrowLeft', open)).toEqual({ type: 'move', index: 0 });
  expect(keyAction(rows, 4, 'ArrowLeft', open)).toBeNull();
  expect(keyAction(rows, 4, 'Enter', open)).toEqual({ type: 'open', path: 'Home.md' });
  expect(keyAction(flatten(sample(), closed), 0, ' ', closed)).toEqual({ type: 'toggle', path: 'Areas' });
  expect(keyAction(rows, 0, 'a', open)).toBeNull();
});

/** `window.myelin` as far as the tree needs it, with a watcher the test drives. */
function fakeApi() {
  let listener: ((events: VaultEvent[]) => void) | null = null;
  let reply!: (tree: TreeEntry[]) => void;
  let refuse!: (reason: Error) => void;
  const loading = new Promise<TreeEntry[]>((resolve, reject) => {
    reply = resolve;
    refuse = reject;
  });
  return {
    api: {
      getTree: () => loading,
      onVaultEvents(next: (events: VaultEvent[]) => void) {
        listener = next;
        return () => {
          listener = null;
        };
      },
    },
    emit: (...events: VaultEvent[]) => listener?.(events),
    subscribed: () => listener !== null,
    reply: async (tree: TreeEntry[]) => {
      reply(tree);
      await loading;
    },
    refuse: async (reason: Error) => {
      refuse(reason);
      await loading.catch(() => {});
    },
  };
}

test('watchTree updates the tree with each batch of watcher events', async () => {
  const vault = fakeApi();
  const tree = vi.fn();
  watchTree(vault.api, { tree, error: vi.fn() });
  await vault.reply([note('Home.md')]);
  expect(paths(tree.mock.lastCall![0])).toEqual(['Home.md']);

  vault.emit(created('folder', 'New'), created('note', 'New/One.md'));
  expect(paths(tree.mock.lastCall![0], ['New'])).toEqual(['New', 'New/One.md', 'Home.md']);

  vault.emit(deleted('note', 'Home.md'));
  expect(paths(tree.mock.lastCall![0])).toEqual(['New']);

  // Content changes do not touch the tree.
  vault.emit({ type: 'changed', path: 'New/One.md' });
  expect(tree).toHaveBeenCalledTimes(3);
});

test('watchTree keeps the events that arrive while the tree loads', async () => {
  const vault = fakeApi();
  const tree = vi.fn();
  watchTree(vault.api, { tree, error: vi.fn() });
  vault.emit(created('note', 'Early.md'));
  vault.emit(deleted('note', 'Gone.md'));
  expect(tree).not.toHaveBeenCalled();
  // The scan already saw `Early.md`, but still lists `Gone.md`.
  await vault.reply([note('Early.md'), note('Gone.md')]);
  expect(tree).toHaveBeenCalledTimes(1);
  expect(paths(tree.mock.lastCall![0])).toEqual(['Early.md']);
});

test('watchTree reports a failed load, and goes quiet once stopped', async () => {
  const failing = fakeApi();
  const error = vi.fn();
  watchTree(failing.api, { tree: vi.fn(), error });
  const reason = new Error('no vault is open');
  await failing.refuse(reason);
  expect(error).toHaveBeenCalledWith(reason);

  const stopped = fakeApi();
  const tree = vi.fn();
  watchTree(stopped.api, { tree, error: vi.fn() })();
  await stopped.reply([]);
  expect(stopped.subscribed()).toBe(false);
  expect(tree).not.toHaveBeenCalled();
});

test('a cursor whose row goes away takes its neighbour, never the top', () => {
  const rows = (...paths: string[]) =>
    flatten(paths.map((path) => ({ kind: 'note' as const, name: path, path })), new Set());
  const before = rows('a', 'b', 'c', 'd');
  expect(cursorAfter(before, 'c', rows('a', 'b', 'd'))).toBe('d');
  expect(cursorAfter(before, 'd', rows('a', 'b', 'c'))).toBe('c');
  expect(cursorAfter(before, 'b', rows('a'))).toBe('a');
  expect(cursorAfter(before, 'b', before)).toBe('b');
  expect(cursorAfter(before, 'a', [])).toBeNull();
  expect(cursorAfter(before, null, before)).toBeNull();
});

// Linear in the batch (#67: 34 ms on an i7-12700KF). The bound is loose for shared CI
// machines; quadratic work takes seconds.
test('a large batch in one folder is applied in one pass', () => {
  const created = Array.from({ length: 30_000 }, (_, i) => ({ type: 'created' as const, kind: 'note' as const, path: `big/n${i}.md` }));
  const start = performance.now();
  const tree = applyEvents([], created);
  applyEvents(tree, created.map((event) => ({ ...event, type: 'deleted' as const })));
  expect(performance.now() - start).toBeLessThan(1500);
});
