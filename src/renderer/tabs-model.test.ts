import { expect, test } from 'vitest';
import { applyTabEvents, closeTab, cycleTab, dropIndex, moveTab, NO_TABS, openTab, tabName, type Tabs } from './tabs-model';

const open = (...paths: string[]) => paths.reduce(openTab, NO_TABS);
const paths = (tabs: Tabs) => tabs.list.map((tab) => tab.path);

test('a tab name is the file name without .md', () => {
  expect(tabName('Projects/Myelin.md')).toBe('Myelin');
  expect(tabName('v1.2 notes.MD')).toBe('v1.2 notes');
});

test('opening adds right of the active tab, or activates the one already there', () => {
  let tabs = open('a', 'b', 'c');
  expect(paths(tabs)).toEqual(['a', 'b', 'c']);
  tabs = openTab(tabs, 'a');
  expect(paths(tabs)).toEqual(['a', 'b', 'c']);
  expect(tabs.active).toBe('a');
  tabs = openTab(tabs, 'd');
  expect(paths(tabs)).toEqual(['a', 'd', 'b', 'c']);
  expect(openTab(tabs, 'd')).toBe(tabs);
});

test('closing the active tab goes right, then left, then to nothing', () => {
  let tabs = openTab(open('a', 'b', 'c'), 'b');
  tabs = closeTab(tabs, 'b');
  expect(tabs.active).toBe('c');
  tabs = closeTab(tabs, 'c');
  expect(tabs.active).toBe('a');
  expect(closeTab(tabs, 'a')).toEqual(NO_TABS);
});

test('closing another tab keeps the active one', () => {
  const tabs = open('a', 'b', 'c');
  expect(closeTab(tabs, 'a').active).toBe('c');
  expect(closeTab(tabs, 'missing')).toBe(tabs);
});

test('cycling follows the strip order and wraps', () => {
  const tabs = open('a', 'b', 'c');
  expect(cycleTab(tabs, 1).active).toBe('a');
  expect(cycleTab(tabs, -1).active).toBe('b');
  expect(cycleTab(cycleTab(tabs, 1), -1).active).toBe('c');
  expect(cycleTab(NO_TABS, 1)).toBe(NO_TABS);
});

test('moving reorders without changing the active tab', () => {
  const tabs = open('a', 'b', 'c');
  expect(paths(moveTab(tabs, 'a', 2))).toEqual(['b', 'c', 'a']);
  expect(paths(moveTab(tabs, 'c', 0))).toEqual(['c', 'a', 'b']);
  expect(paths(moveTab(tabs, 'a', 99))).toEqual(['b', 'c', 'a']);
  expect(moveTab(tabs, 'a', 2).active).toBe('c');
  expect(moveTab(tabs, 'a', -1)).toBe(tabs);
});

test('deleted notes keep their tab, marked, until they come back', () => {
  const tabs = open('a.md', 'dir/b.md', 'dir2/c.md');
  const marked = (next: Tabs) => next.list.filter((tab) => tab.deleted).map((tab) => tab.path);

  const gone = applyTabEvents(tabs, [{ type: 'deleted', kind: 'folder', path: 'dir' }]);
  expect(paths(gone)).toEqual(paths(tabs));
  expect(marked(gone)).toEqual(['dir/b.md']);
  expect(gone.active).toBe(tabs.active);

  // The folder coming back says nothing about its notes: each one is reported.
  expect(applyTabEvents(gone, [{ type: 'created', kind: 'folder', path: 'dir' }])).toBe(gone);
  expect(marked(applyTabEvents(gone, [{ type: 'created', kind: 'note', path: 'dir/b.md' }]))).toEqual([]);

  expect(marked(applyTabEvents(tabs, [{ type: 'deleted', kind: 'note', path: 'a.md' }]))).toEqual(['a.md']);
  expect(applyTabEvents(tabs, [{ type: 'changed', path: 'a.md' }])).toBe(tabs);
});

test('the drop index follows the middle of the tabs', () => {
  const middles = [50, 150, 250];
  // Dragging the first tab: nothing happens until the pointer passes the second one's middle.
  expect([0, 149, 151, 999].map((x) => dropIndex(middles, x, 0))).toEqual([0, 0, 1, 2]);
  expect([0, 51, 249, 251].map((x) => dropIndex(middles, x, 2))).toEqual([0, 1, 2, 2]);
});
