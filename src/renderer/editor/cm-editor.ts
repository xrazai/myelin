// The CodeMirror 6 editor, in plain TS: Svelte only mounts its container (AGENTS.md,
// rule 4). One view; each open tab keeps its own state (text, cursor, undo history) and
// scroll position. Saving is `note-saver.ts`'s job.
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Annotation, Compartment, EditorState, Transaction, type Extension, type StateEffect } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { livePreview } from './live-preview';
import { notePath } from './note-path';
import type { SaverEditor } from './note-saver';
import { textChanges } from './text-changes';
import { theme } from './theme';
import { wikiLink } from './wiki-link';

export const markdownSupport: Extension = markdown({
  base: markdownLanguage,
  extensions: [wikiLink],
  completeHTMLTags: false,
});

/** Marks a reload from disk, which is not typing. */
const fromDisk = Annotation.define<boolean>();

const extensions: Extension = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  markdownSupport,
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ 'aria-label': 'Note text' }),
  livePreview,
  theme,
];

/** `load` adds a note read from disk, without showing it. */
export interface NoteEditor extends SaverEditor {
  /** `true` if the editor holds this note's text. */
  has(path: string): boolean;
  /** Shows a loaded note, or nothing. */
  show(path: string | null): void;
  /** Forgets every note not in `paths`. */
  keep(paths: readonly string[]): void;
  /** Rekeys a note's state to a new path, preserving text, cursor, scroll and undo history. */
  rename(from: string, to: string): void;
  destroy(): void;
}

interface Note {
  state: EditorState;
  scroll: StateEffect<unknown> | null;
  /** Holds the path facet, so a rename can reconfigure it without a new state. */
  pathField: Compartment;
}

/** `extra` adds the links (and the benchmark's probe); `onEdit` hears the user change a note's text. */
export function createNoteEditor(
  parent: HTMLElement,
  extra: Extension = [],
  onEdit: (path: string) => void = () => {},
): NoteEditor {
  const view = new EditorView({ parent });
  const notes = new Map<string, Note>();
  let shown: string | null = null;
  view.dom.hidden = true;

  const edits = EditorView.updateListener.of((update) => {
    if (shown === null || !update.docChanged) return;
    if (!update.transactions.some((transaction) => transaction.annotation(fromDisk))) onEdit(shown);
  });

  const stateOf = (path: string) => (path === shown ? view.state : notes.get(path)!.state);

  /** Puts aside the state of the note on screen. */
  function stash() {
    const note = shown === null ? undefined : notes.get(shown);
    if (note) {
      note.state = view.state;
      note.scroll = view.scrollSnapshot();
    }
  }

  return {
    has: (path) => notes.has(path),
    load(path, text) {
      const pathField = new Compartment();
      const state = EditorState.create({
        doc: text,
        extensions: [extensions, pathField.of(notePath.of(path)), edits, extra],
      });
      notes.set(path, { state, scroll: null, pathField });
    },
    text: (path) => stateOf(path).doc.toString(),
    replace(path, text, undoable) {
      const state = stateOf(path);
      const changes = state.changes(textChanges(state.doc.toString(), text));
      if (changes.empty) return;
      const annotations = [
        fromDisk.of(true),
        // Not undoable: undo steps over the reload and still undoes the user's own edits.
        undoable ? isolateHistory.of('full') : Transaction.addToHistory.of(false),
      ];
      if (path === shown) {
        const scroll = view.scrollSnapshot().map(changes);
        view.dispatch({ changes, annotations, effects: scroll ? [scroll] : [] });
      } else {
        const note = notes.get(path)!;
        note.state = state.update({ changes, annotations }).state;
        note.scroll = note.scroll?.map(changes) ?? null;
      }
    },
    show(path) {
      if (path === shown) return;
      // Takes the focus only if no control has it: the tree and the tab strip keep theirs.
      const focus = view.hasFocus || document.activeElement === document.body;
      stash();
      const note = path === null ? undefined : notes.get(path);
      shown = note ? path : null;
      view.dom.hidden = !note;
      if (!note) return;
      view.setState(note.state);
      if (note.scroll) view.dispatch({ effects: note.scroll });
      // `setState` keeps the scroll of the note before. 0 also shows the top padding.
      else view.scrollDOM.scrollTop = 0;
      if (focus) view.focus();
    },
    keep(paths) {
      for (const path of notes.keys()) {
        if (paths.includes(path)) continue;
        notes.delete(path);
        if (path === shown) {
          shown = null;
          view.dom.hidden = true;
        }
      }
    },
    rename(from, to) {
      const note = notes.get(from);
      if (!note || notes.has(to)) return;
      stash();
      const reconfigure = note.pathField.reconfigure(notePath.of(to));
      if (from === shown) {
        view.dispatch({ effects: reconfigure });
      } else {
        note.state = note.state.update({ effects: reconfigure }).state;
      }
      notes.delete(from);
      notes.set(to, note);
      if (shown === from) shown = to;
    },
    destroy: () => view.destroy(),
  };
}
