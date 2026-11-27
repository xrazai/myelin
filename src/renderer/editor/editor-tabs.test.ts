import { expect, test, vi } from 'vitest';
import { closeTab, NO_TABS, openTab } from '../tabs-model';
import { connectEditor, type EditorStatus } from './editor-tabs';

/** An editor and a disk that answer by hand. */
function setup() {
  const notes = new Map<string, string>();
  let shown: string | null = null;
  const editor = {
    has: (path: string) => notes.has(path),
    load: (path: string, text: string) => void notes.set(path, text),
    show: (path: string | null) => void (shown = path),
    keep: (paths: readonly string[]) => {
      for (const path of notes.keys()) if (!paths.includes(path)) notes.delete(path);
    },
  };
  const reads: { resolve(text: string): void; reject(error: Error): void }[] = [];
  const readNote = vi.fn((_path: string) => new Promise<string>((resolve, reject) => reads.push({ resolve, reject })));
  const statuses: EditorStatus[] = [];
  const connection = connectEditor(editor, readNote, (status) => statuses.push(status));
  const settle = () => new Promise((resolve) => setTimeout(resolve));
  return { notes, reads, readNote, connection, settle, shown: () => shown, status: () => statuses.at(-1) };
}

const a = openTab(NO_TABS, 'a.md');
const ab = openTab(a, 'b.md');

test('reads a note once and shows it when its tab is active again', async () => {
  const { reads, readNote, connection, settle, shown, status } = setup();
  connection.sync(a);
  expect(status()).toEqual({ kind: 'loading' });
  reads[0]!.resolve('A');
  await settle();
  expect(shown()).toBe('a.md');
  expect(status()).toEqual({ kind: 'ready' });

  connection.sync(ab);
  expect(shown()).toBeNull();
  reads[1]!.resolve('B');
  await settle();
  expect(shown()).toBe('b.md');
  connection.sync(openTab(ab, 'a.md'));
  expect(shown()).toBe('a.md');
  expect(readNote).toHaveBeenCalledTimes(2);
});

test('a late read does not take the screen from the active tab', async () => {
  const { reads, notes, connection, settle, shown } = setup();
  connection.sync(a);
  connection.sync(ab);
  reads[1]!.resolve('B');
  await settle();
  reads[0]!.resolve('A');
  await settle();
  expect(shown()).toBe('b.md');
  expect(notes.get('a.md')).toBe('A');
});

test('switching back and forth while reading reads each note once', () => {
  const { readNote, connection } = setup();
  connection.sync(a);
  connection.sync(ab);
  connection.sync(openTab(ab, 'a.md'));
  expect(readNote.mock.calls).toEqual([['a.md'], ['b.md']]);
});

test('a read that ends after its tab closed is dropped', async () => {
  const { reads, notes, connection, settle, status } = setup();
  connection.sync(a);
  connection.sync(closeTab(a, 'a.md'));
  reads[0]!.resolve('A');
  await settle();
  expect(notes.size).toBe(0);
  expect(status()).toEqual({ kind: 'empty' });
});

test('a failed read is reported, and tried again on the next change of tabs', async () => {
  const { reads, readNote, connection, settle, status } = setup();
  connection.sync(a);
  reads[0]!.reject(new Error("Error invoking remote method 'note:read': Error: gone"));
  await settle();
  expect(status()).toEqual({ kind: 'error', message: 'gone' });
  connection.sync(a);
  expect(readNote).toHaveBeenCalledTimes(2);
});
