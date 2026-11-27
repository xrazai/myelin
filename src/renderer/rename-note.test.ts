import { expect, test } from 'vitest';
import { renamedPath, renameNote, type RenameDisk, type RenameState } from './rename-note';

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
