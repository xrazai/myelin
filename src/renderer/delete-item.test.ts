import { expect, test } from 'vitest';
import { deleteItem, deleteWarnings, pathsUnder, type DeleteState } from './delete-item';

/** `missing`: open notes that are no longer on disk, so the bin does not get them. */
function setup(open: string[], unsavable: string[] = [], refuse = false, missing: string[] = []) {
  const log: string[] = [];
  let tabs = [...open];
  const disk = {
    async deleteItem(path: string) {
      if (refuse) throw new Error('no bin');
      log.push(`delete ${path}`);
      return tabs.filter((open) => (open === path || open.startsWith(`${path}/`)) && !missing.includes(open));
    },
  };
  const state: DeleteState = {
    openPaths: () => tabs,
    async save(path) {
      log.push(`save ${path}`);
      return !unsavable.includes(path);
    },
    close(paths) {
      log.push(`close ${paths.join(',')}`);
      tabs = tabs.filter((path) => !paths.includes(path));
    },
  };
  return { disk, state, log, tabs: () => tabs };
}

test('only what is under the target is affected, not what merely starts like it', () => {
  const open = ['A.md', 'A/x.md', 'A/deep/y.md', 'AB/z.md', 'A.md.md'];
  expect(pathsUnder(open, { path: 'A', kind: 'folder' })).toEqual(['A/x.md', 'A/deep/y.md']);
  expect(pathsUnder(open, { path: 'A.md', kind: 'note' })).toEqual(['A.md']);
});

test('saves the open notes, deletes, then closes their tabs', async () => {
  const t = setup(['Home.md', 'Dir/a.md', 'Dir/b.md']);
  expect(await deleteItem(t.disk, t.state, { path: 'Dir', kind: 'folder' })).toEqual({ status: 'deleted' });
  expect(t.log).toEqual(['save Dir/a.md', 'save Dir/b.md', 'delete Dir', 'close Dir/a.md,Dir/b.md']);
  expect(t.tabs()).toEqual(['Home.md']);
});

test('a note that cannot be saved stops the deletion until the user decides', async () => {
  const t = setup(['Dir/a.md', 'Dir/b.md'], ['Dir/a.md']);
  const target = { path: 'Dir', kind: 'folder' } as const;
  expect(await deleteItem(t.disk, t.state, target)).toEqual({ status: 'unsaved', paths: ['Dir/a.md'] });
  expect(t.log).toEqual(['save Dir/a.md', 'save Dir/b.md']);
  expect(t.tabs()).toEqual(['Dir/a.md', 'Dir/b.md']);
  // The user gives that text up; what can be saved is saved still.
  expect(await deleteItem(t.disk, t.state, target, ['Dir/a.md'])).toEqual({ status: 'deleted' });
  expect(t.tabs()).toEqual([]);
});

test('a yes covers only the text it named', async () => {
  const t = setup(['Dir/a.md', 'Dir/b.md'], ['Dir/a.md', 'Dir/b.md']);
  const target = { path: 'Dir', kind: 'folder' } as const;
  expect(await deleteItem(t.disk, t.state, target, ['Dir/a.md'])).toEqual({
    status: 'unsaved',
    paths: ['Dir/a.md', 'Dir/b.md'],
  });
  expect(t.log.some((line) => line.startsWith('delete'))).toBe(false);
});

// A clean tab of a note deleted outside the app "saves" fine and may hold the only copy.
test('the tab of a note that did not go to the bin stays open', async () => {
  const t = setup(['Dir/kept.md', 'Dir/b.md'], [], false, ['Dir/kept.md']);
  expect(await deleteItem(t.disk, t.state, { path: 'Dir', kind: 'folder' })).toEqual({ status: 'deleted' });
  expect(t.tabs()).toEqual(['Dir/kept.md']);
});

test('if the move fails, every tab stays', async () => {
  const t = setup(['a.md'], [], true);
  await expect(deleteItem(t.disk, t.state, { path: 'a.md', kind: 'note' })).rejects.toThrow('no bin');
  expect(t.tabs()).toEqual(['a.md']);
});

test('the confirmation says what goes, and never 0 links for an unknown count', () => {
  expect(deleteWarnings('note', { notes: 1, otherFiles: 0, linkedFrom: 0 })).toEqual(['No other note links to this note.']);
  expect(deleteWarnings('note', { notes: 1, otherFiles: 0, linkedFrom: 1 })[0]).toContain('1 other note links to this note');
  expect(deleteWarnings('note', { notes: 1, otherFiles: 0, linkedFrom: null })[0]).toContain('not known yet');
  const folder = deleteWarnings('folder', { notes: 2, otherFiles: 0, linkedFrom: 3 });
  expect(folder[0]).toContain('2 notes');
  expect(folder[0]).toContain('does not show');
  expect(folder[1]).toContain('3 other notes link to a note in this folder');
});
