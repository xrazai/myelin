// The CodeMirror 6 editor, in plain TS: Svelte only mounts its container (AGENTS.md,
// rule 4). One view; each open tab keeps its own state (text, cursor, undo history) and
// scroll position. Nothing is saved to disk yet.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type Extension, type StateEffect } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { livePreview } from './live-preview';
import { theme } from './theme';
import { wikiLink } from './wiki-link';

export const markdownSupport: Extension = markdown({
  base: markdownLanguage,
  extensions: [wikiLink],
  completeHTMLTags: false,
});

const extensions: Extension = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  markdownSupport,
  EditorView.lineWrapping,
  EditorView.contentAttributes.of({ 'aria-label': 'Note text' }),
  livePreview,
  theme,
];

export interface NoteEditor {
  /** `true` if the editor holds this note's text. */
  has(path: string): boolean;
  /** Adds a note read from disk. It does not show it. */
  load(path: string, text: string): void;
  /** Shows a loaded note, or nothing. */
  show(path: string | null): void;
  /** Forgets every note not in `paths`. */
  keep(paths: readonly string[]): void;
  destroy(): void;
}

interface Note {
  state: EditorState;
  scroll: StateEffect<unknown> | null;
}

/** A leading byte order mark is not part of the text. */
export const createNoteState = (text: string): EditorState =>
  EditorState.create({ doc: text.replace(/^﻿/, ''), extensions });

export function createNoteEditor(parent: HTMLElement): NoteEditor {
  const view = new EditorView({ parent });
  const notes = new Map<string, Note>();
  let shown: string | null = null;
  view.dom.hidden = true;

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
      notes.set(path, { state: createNoteState(text), scroll: null });
    },
    show(path) {
      if (path === shown) return;
      stash();
      const note = path === null ? undefined : notes.get(path);
      shown = note ? path : null;
      view.dom.hidden = !note;
      if (!note) return;
      view.setState(note.state);
      view.dispatch({ effects: note.scroll ?? EditorView.scrollIntoView(0, { y: 'start' }) });
      view.focus();
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
    destroy: () => view.destroy(),
  };
}
