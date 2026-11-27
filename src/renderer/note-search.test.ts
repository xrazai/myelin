import { describe, expect, test } from 'vitest';
import { createNoteSearch, normalizeNewNotePath } from './note-search';

describe('createNoteSearch', () => {
  const paths = [
    'Home.md',
    'notes/Café.md',
    'projects/GPU Architecture.md',
    'projects/sub/Myelin.md',
    'archive/Myelin.md',
  ];

  test('matches note names and paths, ignoring case and accents', () => {
    const search = createNoteSearch(paths);

    expect(search('cafe', 10).map((m) => m.path)).toEqual(['notes/Café.md']);
    expect(search('gpu', 10).map((m) => m.path)).toEqual(['projects/GPU Architecture.md']);
    expect(search('projects/sub', 10).map((m) => m.path)).toEqual(['projects/sub/Myelin.md']);
    // Path match without `/` when name does not match.
    expect(search('archive', 10).map((m) => m.path)).toEqual(['archive/Myelin.md']);
  });

  test('ranks name matches ahead of path-only matches and marks duplicates', () => {
    const search = createNoteSearch(paths);
    const matches = search('myelin', 10);

    expect(matches.map((m) => m.path)).toEqual(['archive/Myelin.md', 'projects/sub/Myelin.md']);
    expect(matches.every((m) => m.duplicate)).toBe(true);
  });

  test('lists recent notes first when query is empty', () => {
    const search = createNoteSearch(paths);
    const matches = search('', 4, ['projects/GPU Architecture.md', 'missing.md', 'notes/Café.md']);

    expect(matches.map((m) => m.path)).toEqual([
      'projects/GPU Architecture.md',
      'notes/Café.md',
      'Home.md',
      'archive/Myelin.md',
    ]);
  });

  test('searches 100k note paths in under 16 ms per keystroke', () => {
    const large: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      large.push(`folder-${i % 100}/Note-${i}.md`);
    }
    const search = createNoteSearch(large);

    // Warm up JIT once, then measure a keystroke query.
    search('note-9999', 20);
    const start = performance.now();
    const hits = search('note-99999', 20);
    const elapsedMs = performance.now() - start;

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe('folder-99/Note-99999.md');
    expect(elapsedMs).toBeLessThan(16);
  });
});

test('normalizeNewNotePath normalizes .md extension and rejects empty input', () => {
  expect(normalizeNewNotePath('')).toBeNull();
  expect(normalizeNewNotePath('   /  ')).toBeNull();
  expect(normalizeNewNotePath('Ideas')).toBe('Ideas.md');
  expect(normalizeNewNotePath('notes/Ideas.MD')).toBe('notes/Ideas.MD');
  expect(normalizeNewNotePath('/notes/Ideas/')).toBe('notes/Ideas.md');
});
