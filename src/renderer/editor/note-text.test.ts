import { expect, test } from 'vitest';
import { parseNote, serializeNote } from './note-text';

test.each([
  ['', '', false, '\n'],
  ['one line', 'one line', false, '\n'],
  ['a\nb\n', 'a\nb\n', false, '\n'],
  ['﻿a\r\nb\r\n', 'a\nb\n', true, '\r\n'],
  ['﻿', '', true, '\n'],
  ['a\rb\r', 'a\nb\n', false, '\r'],
  // Only the first byte order mark is one.
  ['﻿﻿a', '﻿a', true, '\n'],
] as const)('%j keeps its format through the editor', (raw, text, bom, eol) => {
  const parsed = parseNote(raw);
  expect(parsed).toEqual({ text, format: { bom, eol } });
  expect(serializeNote(parsed.text, parsed.format)).toBe(raw);
});

test('mixed line endings take the most used one, LF on a tie', () => {
  expect(parseNote('a\r\nb\r\nc\n').format.eol).toBe('\r\n');
  expect(parseNote('a\r\nb\nc\n').format.eol).toBe('\n');
  expect(parseNote('a\r\nb\n').format.eol).toBe('\n');
});
