import { EditorSelection, EditorState } from '@codemirror/state';
import { expect, test } from 'vitest';
import { focusDimDecorations, focusDimEnabled, paragraphBounds, setFocusDimEffect } from './focus-dim';

function activeLineNumbers(docText: string, selection: EditorSelection, ranges?: { from: number; to: number }[]) {
  const state = EditorState.create({ doc: docText, selection, extensions: [focusDimEnabled] });
  const viewRanges = ranges ?? [{ from: 0, to: docText.length }];
  const found: number[] = [];
  focusDimDecorations(state.doc, state.selection, viewRanges).between(0, docText.length, (from) => {
    found.push(state.doc.lineAt(from).number);
  });
  return found;
}

test('paragraphBounds spans contiguous non-blank lines and isolates blank lines', () => {
  const state = EditorState.create({ doc: 'a1\na2\n\nb1\nb2\nb3\n\nc1' });
  expect(paragraphBounds(state.doc, 1)).toEqual([1, 2]);
  expect(paragraphBounds(state.doc, 2)).toEqual([1, 2]);
  expect(paragraphBounds(state.doc, 3)).toEqual([3, 3]);
  expect(paragraphBounds(state.doc, 5)).toEqual([4, 6]);
  expect(paragraphBounds(state.doc, 8)).toEqual([8, 8]);
});

test('marks only the active paragraph lines and clamps to visible ranges', () => {
  const doc = 'one\ntwo\n\nthree\nfour\nfive\n\nsix';
  const posInFour = doc.indexOf('four');
  expect(activeLineNumbers(doc, EditorSelection.single(posInFour))).toEqual([4, 5, 6]);

  // Visible range covers only line 5.
  expect(
    activeLineNumbers(doc, EditorSelection.single(posInFour), [{ from: posInFour, to: posInFour + 4 }]),
  ).toEqual([5]);
});

test('focusDimEnabled defaults to false and toggles via state effect', () => {
  let state = EditorState.create({ doc: 'hello', extensions: [focusDimEnabled] });
  expect(state.field(focusDimEnabled)).toBe(false);
  state = state.update({ effects: setFocusDimEffect.of(true) }).state;
  expect(state.field(focusDimEnabled)).toBe(true);
  state = state.update({ effects: setFocusDimEffect.of(false) }).state;
  expect(state.field(focusDimEnabled)).toBe(false);
});
