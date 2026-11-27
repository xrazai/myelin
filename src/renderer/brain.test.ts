import { expect, test } from 'vitest';
import { highlightParts } from './highlight';
import { locateExcerpt } from './locate-excerpt';

test('cuts an excerpt at its matches', () => {
  expect(highlightParts('a bc de', [[2, 4], [5, 7]])).toEqual([
    { text: 'a ', match: false },
    { text: 'bc', match: true },
    { text: ' ', match: false },
    { text: 'de', match: true },
  ]);
  expect(highlightParts('plain', [])).toEqual([{ text: 'plain', match: false }]);
});

test('finds the excerpt in the note, across line breaks and the cut mark', () => {
  const text = 'memória antiga\n\nsobre a memória\nde longo prazo (a*b)';
  // CRLF in the file reached the excerpt as two spaces.
  const card = { excerpt: '…sobre a memória  de longo prazo…', matches: [[9, 16]] as [number, number][] };
  expect(locateExcerpt(text, card)).toBe(text.indexOf('memória\nde'));
  expect(locateExcerpt('other memória', card)).toBe(6);
  expect(locateExcerpt('nothing here', card)).toBe(0);
  expect(locateExcerpt(text, { excerpt: 'x', matches: [] })).toBe(0);
});
