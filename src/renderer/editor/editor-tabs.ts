// Glue between the tabs and the editor, in plain TS: opens a note the first time its tab is
// shown, keeps the editor on the active tab, and saves the note being left.
import { errorMessage } from '../error-message';
import type { Tabs } from '../tabs-model';
import type { NoteEditor } from './cm-editor';
import type { NoteSaver } from './note-saver';

/** What the editor area has to say. `ready`: the active note is on screen. */
export type EditorStatus =
  | { kind: 'empty' | 'loading' | 'ready' }
  | { kind: 'error'; message: string };

export function connectEditor(
  editor: Pick<NoteEditor, 'has' | 'show' | 'keep'>,
  saver: Pick<NoteSaver, 'open' | 'save' | 'keep'>,
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

  const isOpen = (path: string) => current?.list.some((tab) => tab.path === path) === true;

  async function read(path: string) {
    if (reading.has(path)) return;
    reading.add(path);
    let loaded: boolean;
    try {
      loaded = await saver.open(path, () => isOpen(path));
    } catch (error) {
      reading.delete(path);
      if (current?.active === path) onStatus({ kind: 'error', message: errorMessage(error) });
      return;
    }
    reading.delete(path);
    if (current?.active !== path) return;
    // Not loaded although on screen: its tab was closed and opened again during the read.
    if (loaded) show(path);
    else void read(path);
  }

  return {
    sync(tabs) {
      const left = current?.active ?? null;
      current = tabs;
      if (left !== null && left !== tabs.active && isOpen(left)) void saver.save(left);
      const paths = tabs.list.map((tab) => tab.path);
      // A closed tab was saved, or its text given up, before it left the list.
      saver.keep(paths);
      editor.keep(paths);
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
