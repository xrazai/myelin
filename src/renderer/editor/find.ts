// Find in the open note (`Ctrl+F`): a CodeMirror panel in plain TS, find only. The current
// match is the selection, so live preview shows the syntax around it. Closed, it costs
// nothing per keystroke. Each tab's state has its own.
import { StateEffect, StateField, type EditorState, type Extension, type Text } from '@codemirror/state';
import { Decoration, EditorView, showPanel, type DecorationSet, type Panel } from '@codemirror/view';

export interface Match {
  from: number;
  to: number;
}

/** Every occurrence of `query` in the text, ignoring case, without overlaps. */
export function findMatches(doc: Text, query: string): Match[] {
  if (query === '') return [];
  // A regular expression, not lowercased copies: lowercasing can change lengths.
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  return Array.from(doc.toString().matchAll(pattern), (found) => ({
    from: found.index,
    to: found.index + found[0].length,
  }));
}

export interface FindState {
  query: string;
  matches: Match[];
  /** Index in `matches`, `-1` if there is none. */
  current: number;
  /** Where the search starts from: typing more of the query does not run ahead. */
  origin: number;
}

export const openFindEffect = StateEffect.define<string | null>();
export const closeFindEffect = StateEffect.define<null>();
export const queryEffect = StateEffect.define<string>();
export const stepEffect = StateEffect.define<1 | -1>();

/** The first match at or after `position`, or else the first of all. */
function firstFrom(matches: Match[], position: number): number {
  if (matches.length === 0) return -1;
  const index = matches.findIndex((match) => match.from >= position);
  return index === -1 ? 0 : index;
}

function search(doc: Text, query: string, origin: number): FindState {
  const matches = findMatches(doc, query);
  return { query, matches, current: firstFrom(matches, origin), origin };
}

/** `null` while closed. */
export const findField = StateField.define<FindState | null>({
  create: () => null,
  update(value, transaction) {
    let next = value;
    if (next && transaction.docChanged) {
      next = search(transaction.state.doc, next.query, transaction.changes.mapPos(next.origin));
    }
    for (const effect of transaction.effects) {
      if (effect.is(openFindEffect)) {
        const origin = transaction.startState.selection.main.from;
        next = search(transaction.state.doc, effect.value ?? next?.query ?? '', origin);
      } else if (effect.is(closeFindEffect)) next = null;
      else if (next && effect.is(queryEffect)) next = search(transaction.state.doc, effect.value, next.origin);
      else if (next && effect.is(stepEffect) && next.matches.length > 0) {
        const current = (next.current + effect.value + next.matches.length) % next.matches.length;
        next = { ...next, current, origin: next.matches[current]!.from };
      }
    }
    return next;
  },
  provide: (field) => [
    showPanel.from(field, (value) => (value === null ? null : createPanel)),
    EditorView.decorations.from(field, highlights),
  ],
});

const match = Decoration.mark({ class: 'cm-find-match' });
const currentMatch = Decoration.mark({ class: 'cm-find-match cm-find-current' });

function highlights(value: FindState | null): DecorationSet {
  if (!value) return Decoration.none;
  return Decoration.set(value.matches.map(({ from, to }, i) => (i === value.current ? currentMatch : match).range(from, to)));
}

export const countLabel = ({ query, matches, current }: FindState) =>
  query === '' ? '' : matches.length === 0 ? 'No matches' : `${current + 1} of ${matches.length}`;

/** Applies `effect` and brings the current match into view, selected. */
function show(view: EditorView, effect: StateEffect<unknown>): void {
  view.dispatch({ effects: effect });
  const value = view.state.field(findField);
  const found = value?.matches[value.current];
  if (!found) return;
  view.dispatch({
    selection: { anchor: found.from, head: found.to },
    effects: EditorView.scrollIntoView(found.from, { y: 'center' }),
  });
}

function createPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-find';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Find in note';
  input.setAttribute('aria-label', 'Find in note');
  // `showPanel` focuses what carries this attribute when asked to.
  input.setAttribute('main-field', 'true');
  input.spellcheck = false;
  input.value = view.state.field(findField)!.query;
  const count = document.createElement('span');
  count.setAttribute('role', 'status');
  count.textContent = countLabel(view.state.field(findField)!);
  dom.append(input, count);

  input.addEventListener('input', () => show(view, queryEffect.of(input.value)));
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      show(view, stepEffect.of(event.shiftKey ? -1 : 1));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      view.dispatch({ effects: closeFindEffect.of(null) });
      view.focus();
    }
  });

  return {
    dom,
    top: true,
    mount: () => {
      input.focus();
      input.select();
    },
    update(update) {
      const value = update.state.field(findField);
      if (!value) return;
      if (input.value !== value.query) input.value = value.query;
      count.textContent = countLabel(value);
    },
  };
}

/** The selected text, if it can be searched for: one line, not empty. */
function selected(state: EditorState): string | null {
  const { from, to } = state.selection.main;
  const text = state.sliceDoc(from, to);
  return text === '' || text.includes('\n') ? null : text;
}

/** Opens the field, or goes back to it, searching for the selection if there is one. */
export function openFind(view: EditorView): void {
  show(view, openFindEffect.of(selected(view.state)));
  const input = view.dom.querySelector<HTMLInputElement>('.cm-find input');
  input?.focus();
  input?.select();
}

const findTheme = EditorView.baseTheme({
  '.cm-panels': { backgroundColor: 'var(--bg-panel)', color: 'var(--text)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--divider)' },
  '.cm-find': {
    display: 'flex',
    gap: '10px',
    alignItems: 'center',
    justifyContent: 'flex-end',
    padding: '6px 12px',
    fontFamily: 'var(--font-ui)',
    fontSize: '12.8px',
  },
  '.cm-find input': {
    width: 'min(260px, 60%)',
    padding: '3px 8px',
    color: 'var(--text)',
    background: 'var(--bg-editor)',
    border: '1px solid var(--divider)',
    borderRadius: '6px',
    font: 'inherit',
  },
  '.cm-find input:focus': { borderColor: 'var(--accent)', outline: '1px solid transparent' },
  '.cm-find span': { minWidth: '72px', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' },
  '.cm-find-match': { backgroundColor: 'var(--accent-soft)', borderRadius: '2px' },
  '.cm-find-current': { backgroundColor: 'var(--accent-ring)', outline: '1px solid var(--accent)' },
});

export const findInNote: Extension = [findField, findTheme];
