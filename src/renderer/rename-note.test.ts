import { expect, test, vi } from 'vitest';
import { NO_TABS, openTab, type Tabs } from './tabs-model';
import { renameNote, type RenameDisk, type RenameState } from './rename-note';

const tabs: Tabs = openTab(openTab(NO_TABS, 'Old.md'), 'Other.md');

function setup(overrides: Partial<RenameDisk & RenameState> = {}) {
  const calls: string[] = [];
  const disk: RenameDisk = {
    async renameNote(from, to) {
      calls.push(`worker:${from}->${to}`);
    },
  };
  const state: RenameState = {
    async save(from) {
      calls.push(`save:${from}`);
      return true;
    },
    async move(from, to) {
      calls.push(`move:${from}->${to}`);
    },
  };
  return { disk: { ...disk, ...overrides }, state: { ...state, ...overrides }, calls };
}

test('saves first, renames in the worker, then rekeys the open tab', async () => {
  const { disk, state, calls } = setup();
  const result = await renameNote(disk, state, tabs, 'Old.md', 'New.md');
  expect(calls).toEqual(['save:Old.md', 'worker:Old.md->New.md', 'move:Old.md->New.md']);
  expect(result?.tabs.active).toBe('Other.md');
  expect(result?.tabs.list.map((tab) => tab.path)).toEqual(['New.md', 'Other.md']);
});

test('stops when the note cannot be saved', async () => {
  const { disk, state, calls } = setup({
    async save() {
      calls.push('save:Old.md');
      return false;
    },
  });
  expect(await renameNote(disk, state, tabs, 'Old.md', 'New.md')).toBeNull();
  expect(calls).toEqual(['save:Old.md']);
});

test('does not rekey when the worker rejects', async () => {
  const { disk, state, calls } = setup({
    async renameNote() {
      calls.push('worker:reject');
      throw new Error('destination exists');
    },
  });
  await expect(renameNote(disk, state, tabs, 'Old.md', 'New.md')).rejects.toThrow('destination exists');
  expect(calls).toEqual(['save:Old.md', 'worker:reject']);
});

test('rejects an invalid destination', async () => {
  const { disk, state } = setup();
  await expect(renameNote(disk, state, tabs, 'Old.md', '../New.md')).rejects.toThrow('not a note path');
  await expect(renameNote(disk, state, tabs, 'Old.md', 'New.txt')).rejects.toThrow('not a note path');
  const spy = vi.fn();
  expect(await renameNote(disk, state, tabs, 'Old.md', 'Old.md')).toBeNull();
  expect(spy).not.toHaveBeenCalled();
});
