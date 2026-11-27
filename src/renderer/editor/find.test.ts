import { EditorState, Text } from '@codemirror/state';
import { expect, test } from 'vitest';
import {
  closeFindEffect,
  countLabel,
  findField,
  findInNote,
  findMatches,
  openFindEffect,
  queryEffect,
  stepEffect,
} from './find';

const doc = (text: string) => Text.of(text.split('\n'));

test('finds every occurrence, ignoring case, across lines and without overlaps', () => {
  expect(findMatches(doc('Ana ana\nANA'), 'ana')).toEqual([
    { from: 0, to: 3 },
    { from: 4, to: 7 },
    { from: 8, to: 11 },
  ]);
  expect(findMatches(doc('aaaa'), 'aa')).toHaveLength(2);
  expect(findMatches(doc('AÇÃO ação'), 'ação')).toHaveLength(2);
  expect(findMatches(doc('abc'), '')).toEqual([]);
});

test('takes the query literally and keeps offsets when lowercasing would change lengths', () => {
  expect(findMatches(doc('a.b axb [[x]] (y)'), 'a.b')).toEqual([{ from: 0, to: 3 }]);
  expect(findMatches(doc('[[x]]'), '[[x')).toEqual([{ from: 0, to: 3 }]);
  expect(findMatches(doc('İİ abc'), 'abc')).toEqual([{ from: 3, to: 6 }]);
});

test('starts from the cursor, steps around both ends and follows edits', () => {
  let state = EditorState.create({ doc: 'one two one two one', selection: { anchor: 5 }, extensions: findInNote });
  const value = () => state.field(findField)!;
  const apply = (effect: ReturnType<typeof stepEffect.of> | ReturnType<typeof queryEffect.of> | ReturnType<typeof openFindEffect.of>) =>
    (state = state.update({ effects: effect }).state);
  expect(state.field(findField)).toBeNull();
  apply(openFindEffect.of(null));
  apply(queryEffect.of('o'));
  apply(queryEffect.of('one'));
  expect(countLabel(value())).toBe('2 of 3');
  apply(stepEffect.of(1));
  apply(stepEffect.of(1));
  expect(countLabel(value())).toBe('1 of 3');
  apply(stepEffect.of(-1));
  expect(countLabel(value())).toBe('3 of 3');
  state = state.update({ changes: { from: 0, to: 3 } }).state;
  expect(value().matches).toHaveLength(2);
  apply(queryEffect.of('zzz'));
  expect(countLabel(value())).toBe('No matches');
  state = state.update({ effects: closeFindEffect.of(null) }).state;
  expect(state.field(findField)).toBeNull();
});
