import { ChangeSet, EditorSelection, Text } from '@codemirror/state';
import { expect, test } from 'vitest';
import { textChanges } from './text-changes';

const doc = (text: string) => Text.of(text.split('\n'));
const apply = (from: string, to: string) =>
  ChangeSet.of(textChanges(from, to), from.length).apply(doc(from)).toString();

/** Where a cursor right before `word` ends up. */
function follow(from: string, to: string, word: string): string {
  const changes = ChangeSet.of(textChanges(from, to), from.length);
  const at = EditorSelection.cursor(from.indexOf(word)).map(changes).head;
  return to.slice(at, at + word.length);
}

test('equal texts have no changes', () => {
  expect(textChanges('a\nb\n', 'a\nb\n')).toEqual([]);
});

test('a cursor between two changed lines does not move off its word', () => {
  const from = 'first\nsecond\nthird cursor here\nfourth\nfifth';
  const to = 'FIRST line\nsecond\nthird cursor here\nfourth\nnew\nfifth!';
  expect(apply(from, to)).toBe(to);
  expect(follow(from, to, 'cursor')).toBe('cursor');
});

test('a cursor in a changed line stays put when the change is elsewhere in it', () => {
  expect(follow('a cursor here, old', 'a cursor here, newer', 'cursor')).toBe('cursor');
  expect(follow('old, then cursor', 'brand new, then cursor', 'cursor')).toBe('cursor');
});

// Pseudo-random, so that a failure repeats.
test('any two texts', () => {
  let seed = 7;
  const random = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
  const text = () =>
    Array.from({ length: random(12) }, () => ['a', 'b', 'c d', '', '😀'][random(5)]!).join(random(4) ? '\n' : '');
  for (let i = 0; i < 3000; i++) {
    const [from, to] = [text(), text()];
    expect(apply(from, to), JSON.stringify([from, to])).toBe(to);
  }
});

test('a rewrite too large to diff is still applied', () => {
  const from = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n');
  const to = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n');
  expect(textChanges(from, to)).toHaveLength(1);
  expect(apply(from, to)).toBe(to);
});
