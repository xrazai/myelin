// Glue between the tabs and the editor, in plain TS: reads a note the first time its tab is
// shown, and keeps the editor on the active tab.
import { errorMessage } from '../error-message';
import type { Tabs } from '../tabs-model';
import type { NoteEditor } from './cm-editor';

/** What the editor area has to say. `ready`: the active note is on screen. */
export type EditorStatus =
  | { kind: 'empty' | 'loading' | 'ready' }
  | { kind: 'error'; message: string };

export function connectEditor(
  editor: Pick<NoteEditor, 'has' | 'load' | 'show' | 'keep'>,
  readNote: (path: string) => Promise<string>,
  onStatus: (status: EditorStatus) => void,
): { sync(tabs: Tabs): void; stop(): void } {
  /** The tabs as last seen. A read that ends late is checked against them. */
  let current: Tabs | null = null;
  /** Notes being read. */
  const reading = new Set<string>();

  function show(path: string) {
    // First the status: the editor cannot take the focus while its container is hidden.
    onStatus({ kind: 'ready' });
    editor.show(path);
  }

  async function read(path: string) {
    if (reading.has(path)) return;
    reading.add(path);
    try {
      const text = await readNote(path);
      // The tab may have been closed meanwhile.
      if (!current?.list.some((tab) => tab.path === path)) return;
      // A note already held may have edits: never replace it.
      if (!editor.has(path)) editor.load(path, text);
      if (current.active === path) show(path);
    } catch (error) {
      if (current?.active === path) onStatus({ kind: 'error', message: errorMessage(error) });
    } finally {
      reading.delete(path);
    }
  }

  return {
    sync(tabs) {
      current = tabs;
      editor.keep(tabs.list.map((tab) => tab.path));
      const path = tabs.active;
      if (path !== null && editor.has(path)) return show(path);
      editor.show(null);
      onStatus({ kind: path === null ? 'empty' : 'loading' });
      if (path !== null) void read(path);
    },
    stop() {
      current = null;
    },
  };
}
