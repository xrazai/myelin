import { expect, test } from 'vitest';
import type { VaultEvent } from '../shared/ipc';
import { watchNoteList } from './note-list';

function setup() {
  let listener: (events: VaultEvent[]) => void = () => {};
  let answer: (paths: string[]) => void = () => {};
  let unsubscribed = false;
  const list = watchNoteList({
    listNotes: () => new Promise<string[]>((resolve) => (answer = resolve)),
    onVaultEvents: (next) => {
      listener = next;
      return () => void (unsubscribed = true);
    },
  });
  return {
    list,
    answer: (paths: string[]) => answer(paths),
    emit: (events: VaultEvent[]) => listener(events),
    names: () => list.search('', 100).map((note) => note.path),
    unsubscribed: () => unsubscribed,
  };
}

test('keeps the events that arrive before the list, then follows them', async () => {
  const { list, answer, emit, names, unsubscribed } = setup();
  emit([
    { type: 'created', kind: 'note', path: 'new.md' },
    { type: 'deleted', kind: 'note', path: 'old.md' },
  ]);
  expect(list.isLoaded()).toBe(false);
  answer(['a.md', 'old.md']);
  await list.ready;
  expect(list.isLoaded()).toBe(true);
  expect(names()).toEqual(['a.md', 'new.md']);
  expect(list.resolve('new', 'a.md').path).toBe('new.md');

  emit([
    { type: 'created', kind: 'folder', path: 'dir.md' },
    { type: 'created', kind: 'note', path: 'dir.md/b.md' },
    { type: 'deleted', kind: 'note', path: 'new.md' },
    { type: 'changed', path: 'a.md' },
  ]);
  expect(names()).toEqual(['a.md', 'dir.md/b.md']);
  expect(list.resolve('new', 'a.md').path).toBeNull();
  expect(list.resolve('b', 'a.md').path).toBe('dir.md/b.md');

  list.stop();
  expect(unsubscribed()).toBe(true);
});

test('marks names that more than one note has, whatever the case', async () => {
  const { list, answer } = setup();
  answer(['x/Same.md', 'y/same.md', 'Other.md']);
  await list.ready;
  expect(list.search('', 10).map((note) => [note.name, note.folder, note.duplicate])).toEqual([
    ['Other', '', false],
    ['Same', 'x', true],
    ['same', 'y', true],
  ]);
});

test('ranks whole name, start, word start, inside, then scattered letters', async () => {
  const { list, answer } = setup();
  answer(['c-a-s-a.md', 'Descasar.md', 'Minha casa.md', 'Casamento.md', 'Casa.md', 'Nada.md']);
  await list.ready;
  expect(list.search('casa', 10).map((note) => note.name)).toEqual([
    'Casa',
    'Casamento',
    'Minha casa',
    'Descasar',
    'c-a-s-a',
  ]);
  expect(list.search('casa', 2)).toHaveLength(2);
});

test('NoteList.has checks exact and case-insensitive paths and updates on events', async () => {
  let emit: (events: import('../shared/ipc').VaultEvent[]) => void = () => {};
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

test('NoteList.folderInOtherCase names the folder a new note would land in', async () => {
  const { list, answer } = setup();
  answer(['Notes/deep/Idea.md', 'Home.md']);
  await list.ready;

  expect(list.folderInOtherCase('Notes/New.md')).toBeNull();
  expect(list.folderInOtherCase('Notes/deep/New.md')).toBeNull();
  expect(list.folderInOtherCase('other/New.md')).toBeNull();
  expect(list.folderInOtherCase('notes/New.md')).toBe('Notes');
  expect(list.folderInOtherCase('Notes/Deep/x/New.md')).toBe('Notes/deep');
});
