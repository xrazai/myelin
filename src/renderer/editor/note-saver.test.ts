import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { VaultEvent, WriteResult } from '../../shared/ipc';
import { createNoteSaver, SAVE_DELAY_MS, type NoteProblems } from './note-saver';

/** An editor, and a disk that behaves as `writeNote` of the contract. */
function setup(files: Record<string, string> = { 'a.md': 'one' }) {
  const disk = new Map(Object.entries(files));
  const texts = new Map<string, string>();
  const undoable: boolean[] = [];
  const writes: string[] = [];
  /** Set to make writes fail, or to hold them. */
  const faults: { fail: string | null; hold: Promise<void> | null } = { fail: null, hold: null };
  const editor = {
    load: (path: string, text: string) => void texts.set(path, text),
    text: (path: string) => texts.get(path)!,
    replace: (path: string, text: string, undo: boolean) => {
      undoable.push(undo);
      texts.set(path, text);
    },
  };
  const api = {
    async readNote(path: string) {
      const raw = disk.get(path);
      if (raw === undefined) throw new Error("Error invoking remote method 'note:read': Error: ENOENT: no such file");
      return raw;
    },
    async writeNote(path: string, content: string, base: string | null): Promise<WriteResult> {
      await faults.hold;
      if (faults.fail) throw new Error(`Error invoking remote method 'note:write': Error: ${faults.fail}`);
      const now = disk.get(path) ?? null;
      if (now !== content && now !== base) return { status: 'conflict', disk: now };
      disk.set(path, content);
      writes.push(content);
      return { status: 'saved' };
    },
  };
  const saved: [string, string, string][] = [];
  const saver = createNoteSaver(editor, api, (...args) => void saved.push(args));
  let problems: NoteProblems = new Map();
  saver.subscribe((next) => (problems = next));

  return {
    disk,
    texts,
    writes,
    saved,
    faults,
    undoable,
    saver,
    open: (path = 'a.md') => saver.open(path, () => true),
    type(text: string, path = 'a.md') {
      texts.set(path, text);
      saver.edited(path);
    },
    /** Another program writes (`null`: deletes), without the app hearing of it yet. */
    other(text: string | null, path = 'a.md') {
      if (text === null) disk.delete(path);
      else disk.set(path, text);
    },
    /** The watcher's report arrives. */
    async report(type: VaultEvent['type'] = 'changed', path = 'a.md') {
      saver.external([type === 'changed' ? { type, path } : { type, kind: 'note', path }]);
      await vi.advanceTimersByTimeAsync(0);
    },
    problem: (path = 'a.md') => problems.get(path),
  };
}

const pause = (ms = SAVE_DELAY_MS) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('auto-save', () => {
  test('tells what each write replaced, and nothing for a write that did not happen', async () => {
    const t = setup({ 'a.md': '\uFEFFone\r\n' });
    await t.open();
    t.type('two\n');
    await pause();
    t.type('three\n');
    t.faults.fail = 'disk full';
    await pause();
    t.faults.fail = null;
    await t.saver.save('a.md');
    expect(t.saved).toEqual([
      ['a.md', 'one\n', 'two\n'],
      ['a.md', 'two\n', 'three\n'],
    ]);
  });

  test('writes once typing stops', async () => {
    const t = setup();
    await t.open();
    t.type('one t');
    await pause(SAVE_DELAY_MS - 1);
    t.type('one two');
    await pause(SAVE_DELAY_MS - 1);
    expect(t.writes).toEqual([]);
    await pause(1);
    expect(t.writes).toEqual(['one two']);
    expect(t.saver.unsaved()).toEqual([]);
  });

  test('save writes at once, and the debounce does not write again', async () => {
    const t = setup();
    await t.open();
    t.type('two');
    expect(await t.saver.save('a.md')).toBe(true);
    await pause();
    expect(t.writes).toEqual(['two']);
  });

  test('a note not edited is never written, whatever its bytes', async () => {
    const t = setup({ 'a.md': '﻿x\r\ny\nz\r' });
    await t.open();
    expect(await t.saver.saveAll()).toBe(true);
    // Typed and undone: still nothing to write.
    t.type('x\ny\nz\n!');
    t.type('x\ny\nz\n');
    await pause();
    expect(t.writes).toEqual([]);
  });

  test('keeps the BOM and line endings of the note', async () => {
    const t = setup({ 'a.md': '﻿x\r\ny\r\n' });
    await t.open();
    expect(t.texts.get('a.md')).toBe('x\ny\n');
    t.type('x\ny\nz\n');
    await pause();
    expect(t.disk.get('a.md')).toBe('﻿x\r\ny\r\nz\r\n');
  });

  test('save waits for text typed while a write was under way', async () => {
    const t = setup();
    await t.open();
    let release!: () => void;
    t.faults.hold = new Promise((resolve) => (release = resolve));
    t.type('two');
    await pause();
    expect(t.saver.unsaved()).toEqual(['a.md']);
    t.type('three');
    // Back to what the disk had before the write: still not saved while it runs.
    t.type('one');
    expect(t.saver.unsaved()).toEqual(['a.md']);
    const saved = t.saver.save('a.md');
    t.faults.hold = null;
    release();
    expect(await saved).toBe(true);
    expect(t.writes).toEqual(['two', 'one']);
    expect(t.saver.unsaved()).toEqual([]);
  });

  test('a failed write keeps the text, says why, and is tried again', async () => {
    const t = setup();
    await t.open();
    t.faults.fail = 'EPERM: operation not permitted';
    t.type('two');
    await pause();
    expect(t.problem()).toEqual({ kind: 'error', message: 'EPERM: operation not permitted' });
    expect(t.texts.get('a.md')).toBe('two');
    expect(await t.saver.save('a.md')).toBe(false);
    expect(t.saver.unsaved()).toEqual(['a.md']);
    // No retry loop on its own.
    const attempts = vi.getTimerCount();
    expect(attempts).toBe(0);

    t.faults.fail = null;
    t.type('two!');
    await pause();
    expect(t.disk.get('a.md')).toBe('two!');
    expect(t.problem()).toBeUndefined();
  });

  test('a note whose edits were all undone after a failure can be closed', async () => {
    const t = setup();
    await t.open();
    t.faults.fail = 'EBUSY';
    t.type('two');
    await pause();
    t.type('one');
    expect(await t.saver.save('a.md')).toBe(true);
    expect(t.problem()).toBeUndefined();
  });
});

describe('another program changes the note', () => {
  test('a clean editor reloads, outside the undo history, and writes nothing', async () => {
    const t = setup();
    await t.open();
    t.other('﻿theirs\r\n');
    await t.report();
    expect(t.texts.get('a.md')).toBe('theirs\n');
    expect(t.undoable).toEqual([false]);
    await pause();
    expect(t.writes).toEqual([]);
    // The new format is the one kept.
    t.type('theirs\nmine\n');
    await pause();
    expect(t.disk.get('a.md')).toBe('﻿theirs\r\nmine\r\n');
  });

  test('the report of what the editor already has changes nothing', async () => {
    const t = setup();
    await t.open();
    t.type('two');
    await pause();
    await t.report();
    expect(t.undoable).toEqual([]);
    expect(t.problem()).toBeUndefined();
  });

  test('a dirty editor keeps its text and stops saving', async () => {
    const t = setup();
    await t.open();
    t.type('mine');
    t.other('theirs');
    await t.report();
    expect(t.problem()).toEqual({ kind: 'changed', message: null });
    t.type('mine, more');
    await pause();
    expect(await t.saver.save('a.md')).toBe(false);
    expect(await t.saver.saveAll()).toBe(false);
    expect(t.disk.get('a.md')).toBe('theirs');
    expect(t.texts.get('a.md')).toBe('mine, more');
    expect(t.saver.unsaved()).toEqual(['a.md']);
  });

  test('undoing every edit while asked takes the disk version', async () => {
    const t = setup();
    await t.open();
    t.type('mine');
    t.other('theirs');
    await t.report();
    t.type('one');
    await pause();
    expect(t.texts.get('a.md')).toBe('theirs');
    expect(t.problem()).toBeUndefined();
    expect(t.writes).toEqual([]);
  });

  test('auto-save firing before the report does not overwrite the change', async () => {
    const t = setup();
    await t.open();
    t.type('mine');
    t.other('theirs');
    await pause();
    expect(t.disk.get('a.md')).toBe('theirs');
    expect(t.problem()?.kind).toBe('changed');
    // The report arrives late.
    await t.report();
    expect(t.texts.get('a.md')).toBe('mine');
    expect(t.problem()?.kind).toBe('changed');
  });

  test('keep mine writes the editor over the disk', async () => {
    const t = setup();
    await t.open();
    t.type('mine');
    t.other('theirs');
    await pause();
    expect(await t.saver.keepMine('a.md')).toBe(true);
    expect(t.disk.get('a.md')).toBe('mine');
    expect(t.problem()).toBeUndefined();
  });

  test('keep mine asks again if the disk changed once more', async () => {
    const t = setup();
    await t.open();
    t.type('mine');
    t.other('theirs');
    await pause();
    t.other('newer');
    expect(await t.saver.keepMine('a.md')).toBe(false);
    expect(t.disk.get('a.md')).toBe('newer');
    expect(t.problem()?.kind).toBe('changed');
    expect(await t.saver.keepMine('a.md')).toBe(true);
    expect(t.disk.get('a.md')).toBe('mine');
  });

  test('load disk takes the disk version, and undo can bring the edits back', async () => {
    const t = setup();
    await t.open();
    t.type('mine');
    t.other('theirs');
    await pause();
    await t.saver.loadDisk('a.md');
    expect(t.texts.get('a.md')).toBe('theirs');
    expect(t.undoable).toEqual([true]);
    expect(t.problem()).toBeUndefined();
    expect(t.writes).toEqual([]);
    t.type('mine');
    await pause();
    expect(t.disk.get('a.md')).toBe('mine');
  });

  test('a change of line endings only does not stop the edits', async () => {
    const t = setup({ 'a.md': 'x\ny' });
    await t.open();
    t.type('x\ny!');
    t.other('x\r\ny');
    await t.report();
    await pause();
    expect(t.disk.get('a.md')).toBe('x\r\ny!');
    expect(t.problem()).toBeUndefined();
  });

  test('a disk that goes back to what it was settles the choice', async () => {
    const t = setup();
    await t.open();
    t.type('mine');
    t.other('theirs');
    await t.report();
    t.other('one');
    await t.report();
    await pause();
    expect(t.disk.get('a.md')).toBe('mine');
    expect(t.problem()).toBeUndefined();
  });

  test('a change reported while the note is being read is not missed', async () => {
    const t = setup();
    const opening = t.open();
    t.saver.external([{ type: 'changed', path: 'a.md' }]);
    await opening;
    t.other('theirs');
    await vi.advanceTimersByTimeAsync(0);
    expect(t.texts.get('a.md')).toBe('theirs');
  });
});

describe('another program deletes the note', () => {
  test('a clean note can be closed, and stays deleted', async () => {
    const t = setup();
    await t.open();
    t.other(null);
    await t.report('deleted');
    expect(t.problem()).toBeUndefined();
    expect(await t.saver.save('a.md')).toBe(true);
    expect(t.disk.has('a.md')).toBe(false);
  });

  test('pending edits are kept, and nothing is recreated without asking', async () => {
    const t = setup();
    await t.open();
    t.type('mine');
    t.other(null);
    await t.report('deleted');
    await pause();
    t.type('mine, more');
    await pause();
    expect(await t.saver.saveAll()).toBe(false);
    expect(t.disk.has('a.md')).toBe(false);
    expect(t.problem()).toEqual({ kind: 'deleted' });

    expect(await t.saver.keepMine('a.md')).toBe(true);
    expect(t.disk.get('a.md')).toBe('mine, more');
    expect(t.problem()).toBeUndefined();
  });

  test('auto-save firing before the report does not recreate it', async () => {
    const t = setup();
    await t.open();
    t.type('mine');
    t.other(null);
    await pause();
    expect(t.disk.has('a.md')).toBe(false);
    expect(t.problem()).toEqual({ kind: 'deleted' });
  });

  test('editing a deleted note asks; saving it again works even with the old text', async () => {
    const t = setup();
    await t.open();
    t.other(null);
    await t.report('deleted');
    t.type('one more');
    expect(t.problem()).toEqual({ kind: 'deleted' });
    expect(await t.saver.keepMine('a.md')).toBe(true);
    expect(t.disk.get('a.md')).toBe('one more');
  });

  test('a note that comes back is reloaded if clean', async () => {
    const t = setup();
    await t.open();
    t.other(null);
    await t.report('deleted');
    t.other('back');
    await t.report('created');
    expect(t.texts.get('a.md')).toBe('back');
    t.type('back!');
    await pause();
    expect(t.disk.get('a.md')).toBe('back!');
  });

  test('a note that comes back unchanged takes the pending edits', async () => {
    const t = setup();
    await t.open();
    t.type('mine');
    t.other(null);
    await t.report('deleted');
    t.other('one');
    await t.report('created');
    await pause();
    expect(t.disk.get('a.md')).toBe('mine');
  });

  test('a deletion is believed although the old path still reads (case-only rename)', async () => {
    const t = setup();
    await t.open();
    await t.report('deleted');
    t.type('mine');
    await pause();
    expect(t.writes).toEqual([]);
    expect(t.problem()).toEqual({ kind: 'deleted' });
  });
});

describe('closing', () => {
  test('keep forgets closed notes, with their timers', async () => {
    const t = setup({ 'a.md': 'one', 'b.md': 'two' });
    await t.open('a.md');
    await t.open('b.md');
    t.type('discarded', 'a.md');
    t.saver.keep(['b.md']);
    await pause();
    expect(t.writes).toEqual([]);
    expect(t.saver.unsaved()).toEqual([]);
  });

  test('a note no longer wanted when read is not loaded', async () => {
    const t = setup();
    expect(await t.saver.open('a.md', () => false)).toBe(false);
    expect(t.texts.size).toBe(0);
  });
});
