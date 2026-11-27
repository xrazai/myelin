import { expect, test } from 'vitest';
import type { TreeEntry } from '../shared/ipc';
import { canMove, destinations, movedInto } from './move-item';

const folder = (path: string, ...children: TreeEntry[]): TreeEntry => ({
  kind: 'folder',
  name: path.slice(path.lastIndexOf('/') + 1),
  path,
  children,
});
const tree = [folder('A', folder('A/B', folder('A/B/C'))), folder('AB'), { kind: 'note', name: 'n', path: 'A/n.md' } as const];

test('an item keeps its name in the new folder', () => {
  expect(movedInto({ path: 'A/n.md', kind: 'note' }, 'AB')).toBe('AB/n.md');
  expect(movedInto({ path: 'A/B', kind: 'folder' }, '')).toBe('B');
});

test('not where it already is, and no folder into itself', () => {
  const b = { path: 'A/B', kind: 'folder' } as const;
  expect(canMove(b, 'A')).toBe(false);
  expect(canMove(b, 'A/B')).toBe(false);
  expect(canMove(b, 'A/B/C')).toBe(false);
  expect(destinations(tree, b)).toEqual(['', 'AB']);
  expect(destinations(tree, { path: 'A', kind: 'folder' })).toEqual(['AB']);
  expect(destinations(tree, { path: 'A/n.md', kind: 'note' })).toEqual(['', 'A/B', 'A/B/C', 'AB']);
});
