// Keeps the editor's notes and the disk together, in plain TS (AGENTS.md, rule 2, light
// path). One rule above the rest: no text is lost, the user's or another program's. A
// write only replaces the text this note was read or written as; anything else on disk
// waits for the user to choose.
import type { VaultEvent, WriteResult } from '../../shared/ipc';
import { errorMessage } from '../error-message';
import { parseNote, serializeNote, type NoteFormat } from './note-text';

/** A note is saved this long after typing stops. */
export const SAVE_DELAY_MS = 500;

/** What holds the notes' text. Texts use `\n` and have no BOM. */
export interface SaverEditor {
  load(path: string, text: string): void;
  /** The current text of a loaded note. */
  text(path: string): string;
  /** Replaces the text without counting as typing. `undoable`: undo brings the old one back. */
  replace(path: string, text: string, undoable: boolean): void;
}

export interface NoteDisk {
  readNote(path: string): Promise<string>;
  writeNote(path: string, content: string, base: string | null): Promise<WriteResult>;
}

/** Why a note's edits are not on disk and will not get there without the user. */
export type NoteProblem =
  /** Another program changed the note while it had unsaved edits. */
  | { kind: 'changed'; message: string | null }
  /** Another program deleted (or renamed) it, and it has edits made on top. */
  | { kind: 'deleted' }
  /** The write failed. It is tried again on the next save. */
  | { kind: 'error'; message: string };

export type NoteProblems = ReadonlyMap<string, NoteProblem>;

interface Note {
  /** The disk's content as last read or written. `null`: the note is not on disk. */
  base: string | null;
  /** The editor text that `base` stands for. */
  saved: string;
  format: NoteFormat;
  /** Gone from disk by another program's doing. It is not recreated without the user. */
  gone: boolean;
  /** The disk's content differs from `base` and the user has not chosen yet. */
  changed: boolean;
  /** The disk's content as last seen. */
  disk: string | null;
  /** The user chose their text over the disk's: write it even if it equals `saved`. */
  force: boolean;
  error: string | null;
}

interface Entry {
  /** `null` while the note is being read. */
  note: Note | null;
  /** Disk work on one note runs one at a time, in call order. */
  queue: Promise<unknown>;
  /** Writes queued or running. */
  writing: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface NoteSaver {
  /** Reads a note into the editor. `false`: no longer wanted once it was read. */
  open(path: string, wanted: () => boolean): Promise<boolean>;
  /** The user changed the note's text. */
  edited(path: string): void;
  /**
   * Saves now. `true`: nothing the user wrote is missing from disk, so the note may be
   * closed. `false`: see its problem.
   */
  save(path: string): Promise<boolean>;
  saveAll(): Promise<boolean>;
  /** Notes with text that is not on disk (yet). */
  unsaved(): string[];
  /** Changes made by other programs. */
  external(events: VaultEvent[]): void;
  /** Writes the editor's text over what is on disk, or recreates a deleted note. */
  keepMine(path: string): Promise<boolean>;
  /** Replaces the editor's text with the disk's; undo brings it back. */
  loadDisk(path: string): Promise<void>;
  /** Drops every note not in `paths`, saved or not: close a tab only after `save`. */
  keep(paths: readonly string[]): void;
  /** Called at once and on each change. Returns the unsubscribe function. */
  subscribe(listener: (problems: NoteProblems) => void): () => void;
  stop(): void;
}

/** `onSaved` hears each write: the text it replaced and the one now on disk. */
export function createNoteSaver(
  editor: SaverEditor,
  disk: NoteDisk,
  onSaved: (path: string, before: string, after: string) => void = () => {},
): NoteSaver {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(problems: NoteProblems) => void>();
  let problems: NoteProblems = new Map();

  const isDirty = (path: string, note: Note) => note.force || editor.text(path) !== note.saved;

  function problemOf(path: string, note: Note): NoteProblem | null {
    // A deleted note without edits of its own has nothing to lose.
    if (note.gone) return isDirty(path, note) ? { kind: 'deleted' } : null;
    // `message`: loading the disk's version failed.
    if (note.changed) return { kind: 'changed', message: note.error };
    return note.error === null ? null : { kind: 'error', message: note.error };
  }

  function notify(): void {
    const next = new Map<string, NoteProblem>();
    for (const [path, { note }] of entries) {
      const problem = note && problemOf(path, note);
      if (problem) next.set(path, problem);
    }
    const same =
      next.size === problems.size &&
      [...next].every(([path, problem]) => JSON.stringify(problems.get(path)) === JSON.stringify(problem));
    if (same) return;
    problems = next;
    for (const listener of listeners) listener(problems);
  }

  function enqueue<T>(entry: Entry, task: () => Promise<T>): Promise<T> {
    const result = entry.queue.then(task);
    entry.queue = result.catch(() => {});
    return result;
  }

  /** The note of an entry still held, once read. */
  const held = (path: string, entry: Entry) => (entries.get(path) === entry ? entry.note : null);

  function stopTimer(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  function schedule(path: string, entry: Entry): void {
    stopTimer(entry);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void write(path, entry, false);
    }, SAVE_DELAY_MS);
  }

  /** The disk's content `raw` is now what the editor's text derives from. */
  function adopt(note: Note, raw: string): void {
    const { text, format } = parseNote(raw);
    Object.assign(note, { base: raw, saved: text, format, disk: raw, gone: false, changed: false, force: false, error: null });
  }

  /**
   * One write. `true`: the disk has the editor's text (or there is nothing of the user's
   * to write). `'again'`: the text changed while it was being written.
   */
  async function writeOnce(path: string, entry: Entry): Promise<boolean | 'again'> {
    const note = held(path, entry);
    if (!note) return true;
    if (!isDirty(path, note)) {
      note.error = null;
      return true;
    }
    if (note.gone || note.changed) return false;
    const text = editor.text(path);
    const content = serializeNote(text, note.format);
    let result: WriteResult;
    try {
      result = await disk.writeNote(path, content, note.base);
    } catch (error) {
      note.error = errorMessage(error);
      return false;
    }
    if (!held(path, entry)) return true;
    if (result.status === 'saved') {
      // A deleted note saved again has no disk text: what it had is what is replaced.
      const before = note.base === null ? note.saved : parseNote(note.base).text;
      try {
        onSaved(path, before, text);
      } catch (error) {
        // A listener must not turn a good save into a failed one.
        console.error(`[note-saver] onSaved for ${path} failed:`, error);
      }
      Object.assign(note, { base: content, saved: text, disk: content, force: false, error: null });
      return isDirty(path, note) ? 'again' : true;
    }
    // Another program got there first; its report has not arrived yet.
    apply(path, entry, note, result.disk);
    if (!isDirty(path, note)) return true;
    return note.gone || note.changed ? false : 'again';
  }

  /** Queues a save; with `all`, writes again until nothing typed meanwhile is left out. */
  function write(path: string, entry: Entry, all: boolean): Promise<boolean> {
    entry.writing++;
    return enqueue(entry, async () => {
      try {
        for (;;) {
          const result = await writeOnce(path, entry);
          if (result !== 'again') return result;
          if (!all) return false;
        }
      } finally {
        entry.writing--;
        notify();
      }
    });
  }

  /** The disk holds `raw` (`null`: no note). Decides by content what that means. */
  function apply(path: string, entry: Entry, note: Note, raw: string | null): void {
    note.disk = raw;
    if (raw === null) {
      stopTimer(entry);
      Object.assign(note, { base: null, gone: true, changed: false, error: null });
      return;
    }
    if (!note.gone && raw === note.base) {
      // Back to what it was: the choice is moot.
      if (note.changed) {
        note.changed = false;
        schedule(path, entry);
      }
      return;
    }
    const { text, format } = parseNote(raw);
    const mine = editor.text(path);
    if (text === mine) {
      adopt(note, raw);
    } else if (!note.force && mine === note.saved) {
      editor.replace(path, text, false);
      adopt(note, raw);
    } else if (!note.force && text === note.saved) {
      // The same text in other bytes, or the note came back: the edits apply to it.
      Object.assign(note, { base: raw, format, gone: false, changed: false });
      schedule(path, entry);
    } else {
      stopTimer(entry);
      Object.assign(note, { gone: false, changed: true, error: null });
    }
  }

  /** `null` if there is no note. */
  async function readDisk(path: string): Promise<string | null> {
    try {
      return await disk.readNote(path);
    } catch (error) {
      if (errorMessage(error).includes('ENOENT')) return null;
      throw error;
    }
  }

  function save(path: string): Promise<boolean> {
    const entry = entries.get(path);
    // A note still being read has no edits.
    if (!entry?.note) return Promise.resolve(true);
    stopTimer(entry);
    return write(path, entry, true);
  }

  function unsaved(): string[] {
    return [...entries]
      .filter(([path, { note, writing }]) => note && (writing > 0 || isDirty(path, note)))
      .map(([path]) => path);
  }

  function forget(path: string): void {
    const entry = entries.get(path);
    if (!entry) return;
    stopTimer(entry);
    entries.delete(path);
  }

  return {
    open(path, wanted) {
      const entry: Entry = { note: null, queue: Promise.resolve(), writing: 0, timer: undefined };
      entries.set(path, entry);
      // First in the queue: a change reported during the read is looked at after it.
      return enqueue(entry, async () => {
        try {
          const raw = await disk.readNote(path);
          if (entries.get(path) !== entry || !wanted()) {
            if (entries.get(path) === entry) entries.delete(path);
            return false;
          }
          const { text, format } = parseNote(raw);
          editor.load(path, text);
          entry.note = {
            base: raw, saved: text, format, disk: raw, gone: false, changed: false, force: false, error: null,
          };
          return true;
        } catch (error) {
          if (entries.get(path) === entry) entries.delete(path);
          throw error;
        }
      });
    },

    edited(path) {
      const entry = entries.get(path);
      const note = entry?.note;
      if (!entry || !note) return;
      if (!note.gone && !note.changed) schedule(path, entry);
      // Undone back to nothing of the user's own: the disk's version can just load. Queued,
      // because the editor cannot be changed while it reports a change.
      if (note.changed && !isDirty(path, note)) {
        void enqueue(entry, async () => {
          if (held(path, entry) !== note || !note.changed || isDirty(path, note)) return;
          apply(path, entry, note, note.disk);
          notify();
        });
      }
      notify();
    },

    save,

    async saveAll() {
      const results = await Promise.all([...entries.keys()].map(save));
      return results.every(Boolean);
    },

    unsaved,

    external(events) {
      for (const event of events) {
        if (event.type !== 'changed' && event.kind !== 'note') continue;
        const { path, type } = event;
        const entry = entries.get(path);
        if (!entry) continue;
        void enqueue(entry, async () => {
          // A deletion is taken as reported: after a case-only rename the old path
          // still reads on Windows.
          const raw = type === 'deleted' ? null : await readDisk(path);
          const note = held(path, entry);
          if (note) apply(path, entry, note, raw);
          notify();
          // If it cannot be read now, the next write still refuses to replace it.
        }).catch((error: unknown) => console.error(`[note-saver] reading ${path} failed:`, error));
      }
    },

    keepMine(path) {
      const entry = entries.get(path);
      if (!entry?.note) return Promise.resolve(true);
      // Queued, to choose over what is on disk after the work already under way.
      void enqueue(entry, async () => {
        const note = held(path, entry);
        if (!note || !(note.gone || note.changed)) return;
        // Only the version the user was told about is replaced; a newer one asks again.
        Object.assign(note, { base: note.disk, gone: false, changed: false, force: true });
      });
      return save(path);
    },

    loadDisk(path) {
      const entry = entries.get(path);
      if (!entry?.note) return Promise.resolve();
      stopTimer(entry);
      return enqueue(entry, async () => {
        try {
          const raw = await readDisk(path);
          const note = held(path, entry);
          if (!note) return;
          if (raw === null) {
            apply(path, entry, note, raw);
          } else {
            editor.replace(path, parseNote(raw).text, true);
            adopt(note, raw);
          }
        } catch (error) {
          const note = held(path, entry);
          if (note) note.error = errorMessage(error);
        } finally {
          notify();
        }
      });
    },

    keep(paths) {
      for (const path of entries.keys()) if (!paths.includes(path)) forget(path);
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(problems);
      return () => {
        listeners.delete(listener);
      };
    },

    stop() {
      for (const path of [...entries.keys()]) forget(path);
    },
  };
}
