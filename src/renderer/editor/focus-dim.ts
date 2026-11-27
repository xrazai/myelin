// Optional iA Writer-inspired paragraph focus dimming for deep reading & writing.
// Zero cost when off (returns Decoration.none); when on, decorates only active paragraph
// lines inside `view.visibleRanges`.
import { StateEffect, StateField, type EditorSelection, type Extension, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';

/** Dispatched on `window` (e.g. by the command palette) to toggle paragraph focus dimming. */
export const TOGGLE_PARAGRAPH_FOCUS_EVENT = 'myelin:toggle-paragraph-focus';

export const setFocusDimEffect = StateEffect.define<boolean>();

export const focusDimEnabled = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFocusDimEffect)) return effect.value;
    }
    return value;
  },
});

const activeLine = Decoration.line({ class: 'cm-focus-active' });
const isBlank = (text: string) => text.trim().length === 0;

/**
 * Returns the `[startLine, endLine]` (1-based, inclusive) of the contiguous non-blank
 * paragraph containing `lineNumber`. A blank line highlights only itself.
 */
export function paragraphBounds(doc: Text, lineNumber: number): [number, number] {
  const current = doc.line(lineNumber);
  if (isBlank(current.text)) return [lineNumber, lineNumber];
  let start = lineNumber;
  while (start > 1 && !isBlank(doc.line(start - 1).text)) start--;
  let end = lineNumber;
  while (end < doc.lines && !isBlank(doc.line(end + 1).text)) end++;
  return [start, end];
}

/** Computes active-paragraph line decorations clamped to `ranges`. */
export function focusDimDecorations(
  doc: Text,
  selection: EditorSelection,
  ranges: readonly { from: number; to: number }[],
): DecorationSet {
  const activeLines = new Set<number>();
  for (const sel of selection.ranges) {
    const firstSelLine = doc.lineAt(sel.from).number;
    const lastSelLine = doc.lineAt(sel.to).number;
    const [start] = paragraphBounds(doc, firstSelLine);
    const [, end] = paragraphBounds(doc, lastSelLine);
    for (const range of ranges) {
      const visibleStart = Math.max(start, doc.lineAt(range.from).number);
      const visibleEnd = Math.min(end, doc.lineAt(range.to).number);
      for (let n = visibleStart; n <= visibleEnd; n++) activeLines.add(n);
    }
  }
  const sorted = [...activeLines].sort((a, b) => a - b);
  return Decoration.set(sorted.map((n) => activeLine.range(doc.line(n).from)));
}

const focusDimPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = view.state.field(focusDimEnabled)
        ? focusDimDecorations(view.state.doc, view.state.selection, view.visibleRanges)
        : Decoration.none;
    }

    update(update: ViewUpdate) {
      const on = update.state.field(focusDimEnabled);
      if (!on) {
        this.decorations = Decoration.none;
        return;
      }
      const toggled = update.startState.field(focusDimEnabled) !== on;
      if (toggled || update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = focusDimDecorations(update.state.doc, update.state.selection, update.view.visibleRanges);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const focusDim: Extension = [focusDimEnabled, focusDimPlugin];
