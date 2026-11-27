import { expect, test } from 'vitest';
import type { TreeEntry } from '../shared/ipc';
import { foldersAbove, menuItems, newItem, targetFolder } from './new-item';

const idea: TreeEntry = { kind: 'note', name: 'Idea', path: 'Notes/Idea.md' };
const deep: TreeEntry = { kind: 'folder', name: 'Deep', path: 'Notes/Deep', children: [] };
const notes: TreeEntry = { kind: 'folder', name: 'Notes', path: 'Notes', children: [deep, idea] };
// A folder made outside the app with a name the app would refuse.
const odd: TreeEntry = { kind: 'folder', name: 'C#', path: 'C#', children: [] };
const tree: TreeEntry[] = [odd, notes, { kind: 'note', name: 'Home', path: 'Home.md' }];

test('the item goes into the chosen folder, the folder of the chosen note, or the root', () => {
  expect(targetFolder(notes)).toBe('Notes');
  expect(targetFolder(deep)).toBe('Notes/Deep');
  expect(targetFolder(idea)).toBe('Notes');
  expect(targetFolder(tree[2]!)).toBe('');
  expect(targetFolder(null)).toBe('');
});

test('builds the path, adding .md to a note once', () => {
  expect(newItem(tree, '', 'note', '  Plan ')).toEqual({ path: 'Plan.md', problem: null });
  expect(newItem(tree, 'Notes/Deep', 'note', 'Plan.md')).toEqual({ path: 'Notes/Deep/Plan.md', problem: null });
  expect(newItem(tree, 'Notes', 'folder', 'Anotações 2026')).toEqual({ path: 'Notes/Anotações 2026', problem: null });
  expect(newItem(tree, 'C#', 'note', 'Plan')?.problem).toBeNull();
  expect(newItem(tree, 'C#', 'folder', 'Sub')?.problem).toBeNull();
});

test('nothing typed is no item', () => {
  for (const typed of ['', '   ', '.md']) expect(newItem(tree, '', 'note', typed)).toBeNull();
  expect(newItem(tree, '', 'folder', ' ')).toBeNull();
});

test('refuses unusable names and says why', () => {
  for (const kind of ['note', 'folder'] as const) {
    for (const typed of ['a/b', '.hidden', 'C# notes', '[x]', 'a|b', 'why?', 'a\\b', 'end.']) {
      expect(newItem(tree, '', kind, typed)?.problem, `${kind} ${typed}`).toEqual(expect.any(String));
    }
  }
  expect(newItem(tree, '', 'folder', 'x.md')?.problem).toContain('.md');
});

test('never offers to replace: same name in any case, per kind', () => {
  expect(newItem(tree, 'Notes', 'note', 'idea')?.problem).toBe('a note named Idea already exists');
  expect(newItem(tree, '', 'folder', 'NOTES')?.problem).toBe('a folder named Notes already exists');
  expect(newItem(tree, 'Notes', 'folder', 'Idea')?.problem).toBeNull();
  expect(newItem(tree, '', 'note', 'Notes')?.problem).toBeNull();
  expect(newItem(tree, '', 'note', 'Idea')?.problem).toBeNull();
});

test('lists the folders to expand', () => {
  expect(foldersAbove('Notes/Deep/Plan.md')).toEqual(['Notes', 'Notes/Deep']);
  expect(foldersAbove('Plan.md')).toEqual([]);
});

test('an entry can be renamed and deleted; blank space cannot', () => {
  const ids = (entry: TreeEntry | null) => menuItems(entry).map((item) => item.id);
  expect(ids(idea)).toEqual(['new-note', 'new-folder', 'rename', 'delete']);
  expect(ids(notes)).toEqual(['new-note', 'new-folder', 'rename', 'delete']);
  expect(ids(null)).toEqual(['new-note', 'new-folder']);
});
