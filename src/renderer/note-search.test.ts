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

    // Warm up JIT once, then measure 3 realistic keystroke queries.
    search('note-9999', 20);

    const measure = (q: string) => {
      const start = performance.now();
      const hits = search(q, 20);
      return { hits, elapsedMs: performance.now() - start };
    };

    const broad = measure('n');
    const specific = measure('note-99999');
    const miss = measure('zzzz');

    console.info(
      `[100k-search] broad('n')=${broad.elapsedMs.toFixed(2)}ms, specific('note-99999')=${specific.elapsedMs.toFixed(2)}ms, miss('zzzz')=${miss.elapsedMs.toFixed(2)}ms`,
    );

    expect(broad.hits.length).toBe(20);
    expect(specific.hits[0]?.path).toBe('folder-99/Note-99999.md');
    expect(miss.hits.length).toBe(0);

    expect(broad.elapsedMs).toBeLessThan(16);
    expect(specific.elapsedMs).toBeLessThan(16);
    expect(miss.elapsedMs).toBeLessThan(16);
  });
});

test('normalizeNewNotePath normalizes .md extension and rejects empty or invalid input', () => {
  expect(normalizeNewNotePath('')).toBeNull();
  expect(normalizeNewNotePath('   /  ')).toBeNull();
  expect(normalizeNewNotePath('a\\b')).toBeNull();
  expect(normalizeNewNotePath('C:foo')).toBeNull();
  expect(normalizeNewNotePath('a\0b')).toBeNull();
  expect(normalizeNewNotePath('a//b')).toBeNull();
  expect(normalizeNewNotePath('../secret')).toBeNull();
  expect(normalizeNewNotePath('.myelin/vault')).toBeNull();
  expect(normalizeNewNotePath('Ideas')).toBe('Ideas.md');
  expect(normalizeNewNotePath('notes/Ideas.MD')).toBe('notes/Ideas.MD');
  expect(normalizeNewNotePath('/notes/Ideas/')).toBe('notes/Ideas.md');
});
