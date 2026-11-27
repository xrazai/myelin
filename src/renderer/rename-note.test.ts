import { expect, test } from 'vitest';
import {
  movedPath,
  renamedFolderPath,
  renamedPath,
  renameFolder,
  renameNote,
  type FolderRenameState,
  type RenameDisk,
  type RenameState,
} from './rename-note';

function setup(overrides: Partial<RenameDisk & RenameState> = {}) {
  const calls: string[] = [];
  const disk: RenameDisk = {
    async renameNote(from, to) {
      calls.push(`worker:${from}->${to}`);
      return { notUpdated: [] };
    },
  };
  const state: RenameState = {
    hasDeletedTab: () => false,
    async saveAll() {
      calls.push('saveAll');
    },
    async save(from) {
      calls.push(`save:${from}`);
      return true;
    },
    move(from, to) {
      calls.push(`move:${from}->${to}`);
    },
  };
  return { disk: { ...disk, ...overrides }, state: { ...state, ...overrides }, calls };
}

test('saves every open note, renames in the worker, then moves the open state', async () => {
  const { disk, state, calls } = setup();
  expect(await renameNote(disk, state, 'Old.md', 'New.md')).toEqual({ notUpdated: [] });
  expect(calls).toEqual(['saveAll', 'save:Old.md', 'worker:Old.md->New.md', 'move:Old.md->New.md']);
});

test('stops when the note cannot be saved', async () => {
  const { disk, state, calls } = setup({
    async save() {
      return false;
    },
  });
  expect(await renameNote(disk, state, 'Old.md', 'New.md')).toBeNull();
  expect(calls).toEqual(['saveAll']);
});

test('moves nothing when the worker rejects', async () => {
  const { disk, state, calls } = setup({
    async renameNote() {
      throw new Error('destination exists');
    },
  });
  await expect(renameNote(disk, state, 'Old.md', 'New.md')).rejects.toThrow('destination exists');
  expect(calls).toEqual(['saveAll', 'save:Old.md']);
});

test('refuses to move onto the tab of a deleted note', async () => {
  const { disk, state, calls } = setup({ hasDeletedTab: (path) => path === 'New.md' });
  await expect(renameNote(disk, state, 'Old.md', 'New.md')).rejects.toThrow('close the tab');
  expect(calls).toEqual([]);
});

test('renamedPath keeps the folder and takes only a new name', () => {
  expect(renamedPath('Old.md', ' New ')).toBe('New.md');
  expect(renamedPath('a/Old.md', 'New.md')).toBe('a/New.md');
  expect(renamedPath('a/Old.md', 'sub/New')).toBe('a/sub/New.md');
  expect(renamedPath('a/Old.md', 'Old')).toBeNull();
  expect(renamedPath('a/Old.md', '   ')).toBeNull();
});

function folderSetup(open: string[], unsavable: string[] = [], missing: string[] = []) {
  const log: string[] = [];
  let tabs = [...open];
  const disk = {
    async renameFolder(from: string, to: string) {
      log.push(`worker ${from}->${to}`);
      const moved = tabs
        .filter((path) => path.startsWith(`${from}/`) && !missing.includes(path))
        .map((path): [string, string] => [path, movedPath(path, from, to)]);
      return { moved, notUpdated: [] };
    },
  };
  const state: FolderRenameState = {
    openPaths: () => tabs,
    async saveAll() {
      log.push('saveAll');
    },
    async save(path) {
      log.push(`save ${path}`);
      return !unsavable.includes(path);
    },
    move(moves) {
      for (const { from, to, gone } of moves) log.push(`move ${from}->${to}${gone ? ' (gone)' : ''}`);
      tabs = tabs.map((path) => moves.find((move) => move.from === path)?.to ?? path);
    },
  };
  return { disk, state, log };
}

test('a folder rename saves, renames, then moves every tab inside at once', async () => {
  const t = folderSetup(['Dir/a.md', 'Dirt/b.md', 'Dir/sub/c.md', 'Dir/old.md'], [], ['Dir/old.md']);
  expect((await renameFolder(t.disk, t.state, 'Dir', 'New')).status).toBe('renamed');
  expect(t.log).toEqual([
    'saveAll',
    'save Dir/a.md',
    'save Dir/sub/c.md',
    'save Dir/old.md',
    'worker Dir->New',
    'move Dir/a.md->New/a.md',
    'move Dir/sub/c.md->New/sub/c.md',
    // Deleted before: its tab goes with the folder, still deleted, with its text.
    'move Dir/old.md->New/old.md (gone)',
  ]);
});

test('text that cannot be saved stops a folder rename', async () => {
  const t = folderSetup(['Dir/a.md'], ['Dir/a.md']);
  expect(await renameFolder(t.disk, t.state, 'Dir', 'New')).toEqual({ status: 'unsaved', path: 'Dir/a.md' });
  expect(t.log.some((line) => line.startsWith('worker'))).toBe(false);
});

test('a tab at the destination, in any case, refuses it', async () => {
  const t = folderSetup(['Dir/a.md', 'new/kept.md']);
  await expect(renameFolder(t.disk, t.state, 'Dir', 'New')).rejects.toThrow('close the tab of new/kept.md');
  expect(t.log).toEqual([]);
  // A change of case only is not another destination.
  const same = folderSetup(['Dir/a.md']);
  expect((await renameFolder(same.disk, same.state, 'Dir', 'dir')).status).toBe('renamed');
});

test('names a renamed folder beside the old one', () => {
  expect(renamedFolderPath('a/Old', ' New ')).toBe('a/New');
  expect(renamedFolderPath('Old', 'New.md')).toBe('New.md');
  expect(renamedFolderPath('a/Old', 'Old')).toBeNull();
  expect(renamedFolderPath('a/Old', '  ')).toBeNull();
  expect(() => renamedFolderPath('Old', 'x/y')).toThrow('cannot contain /');
});
