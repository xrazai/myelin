import { expect, test } from 'vitest';
import type { VaultEvent } from '../shared/ipc';
import { watchNoteList } from './note-list';

test('NoteList.has checks exact and case-insensitive paths and updates on events', async () => {
  let emit: (events: VaultEvent[]) => void = () => {};
  const list = watchNoteList({
    listNotes: async () => ['Home.md', 'notes/Ideas.md'],
    onVaultEvents: (cb) => {
      emit = cb;
      return () => {};
    },
  });
  await list.ready;

  expect(list.has('Home.md')).toBe(true);
  expect(list.has('home.md')).toBe(true);
  expect(list.has('NOTES/ideas.MD')).toBe(true);
  expect(list.has('Missing.md')).toBe(false);

  emit([{ type: 'created', kind: 'note', path: 'New.md' }]);
  expect(list.has('new.md')).toBe(true);

  emit([{ type: 'deleted', kind: 'note', path: 'New.md' }]);
  expect(list.has('New.md')).toBe(false);
  list.stop();
});
