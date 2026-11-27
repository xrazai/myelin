import { expect, test } from 'vitest';
import { computeNoteMetrics, formatLinkSummary, formatWordSummary } from './note-metrics';

test('counts words, reading time and wiki-links including Portuguese diacritics', () => {
  const note = '# Conexões neurais\n\nEstudo sobre [[ForceAtlas2]] e [[Barnes-Hut|quadtree]].\n';
  expect(computeNoteMetrics(note)).toEqual({
    words: 8,
    readMinutes: 1,
    links: 2,
  });
});

test('empty or whitespace-only notes have zero metrics', () => {
  expect(computeNoteMetrics('')).toEqual({ words: 0, readMinutes: 0, links: 0 });
  expect(computeNoteMetrics('   \n\t  ')).toEqual({ words: 0, readMinutes: 0, links: 0 });
  expect(formatWordSummary({ words: 0, readMinutes: 0, links: 0 })).toBe('0 words');
});

test('estimates reading time at 220 wpm and formats singular/plural labels', () => {
  const longNote = Array.from({ length: 440 }, () => 'myelin').join(' ');
  const metrics = computeNoteMetrics(longNote);
  expect(metrics.words).toBe(440);
  expect(metrics.readMinutes).toBe(2);
  expect(formatWordSummary(metrics)).toBe('440 words · 2 min read');
  expect(formatWordSummary({ words: 1, readMinutes: 1, links: 1 })).toBe('1 word · 1 min read');
  expect(formatLinkSummary(1)).toBe('1 link');
  expect(formatLinkSummary(4)).toBe('4 links');
});

test('ignores links inside fenced or inline code', () => {
  expect(computeNoteMetrics('Real [[Note]] and `[[Fake]]`').links).toBe(1);
});
