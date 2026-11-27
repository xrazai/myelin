import { describe, expect, test } from 'vitest';
import { createNoteSearch, newNoteFor } from './note-search';

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

  test('a short list is the start of the full ranking', () => {
    // Every mix of exact, prefix, word start, inside, scattered, accented and path-only matches.
    const words = ['a', 'ab', 'ba', 'Álbum', 'cab', 'a b', 'b-a', 'xaxb', 'dado', 'Mapa de aba'];
    const mixed: string[] = [];
    for (const folder of ['', 'a/', 'ab/c/', 'zz/']) {
      for (const first of words) {
        mixed.push(`${folder}${first}.md`);
        for (const second of words) mixed.push(`${folder}${first} ${second}.md`);
      }
    }
    const search = createNoteSearch(mixed);

    for (const query of ['a', 'ab', 'b', 'a b', 'alb', 'ba', 'a/', 'ab/c/a', 'z a', 'mapa', 'qq']) {
      // A limit above the number of notes cuts nothing short.
      const full = search(query, mixed.length + 1).map((match) => match.path);
      for (const limit of [1, 2, 5, 20, 100]) {
        expect(search(query, limit).map((match) => match.path), `${query} ${limit}`).toEqual(full.slice(0, limit));
      }
    }
  });

  test('searches 100k note paths', () => {
    const large: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      large.push(`folder-${i % 100}/Note-${i}.md`);
    }
    const search = createNoteSearch(large);

    // Warm up JIT once, then measure 3 realistic keystroke queries.
    search('note-9999', 20);

    const start = performance.now();
    const broad = search('n', 20);
    const specific = search('note-99999', 20);
    const miss = search('zzzz', 20);
    const elapsedMs = performance.now() - start;

    expect(broad.length).toBe(20);
    expect(specific[0]?.path).toBe('folder-99/Note-99999.md');
    expect(miss.length).toBe(0);
    // Only against a gross regression: the suite runs in parallel on shared machines.
    // The budget per keystroke (16 ms) is measured by `scripts/bench.ts` (`palette`).
    expect(elapsedMs).toBeLessThan(750);
  });
});

test('newNoteFor adds .md and follows the name rules of a rename', () => {
  expect(newNoteFor('')).toBeNull();
  expect(newNoteFor('   /  ')).toBeNull();
  expect(newNoteFor('Ideas')).toEqual({ path: 'Ideas.md', problem: null });
  expect(newNoteFor('notes/Ideas.MD')).toEqual({ path: 'notes/Ideas.MD', problem: null });
  expect(newNoteFor('/notes/Ideas/')).toEqual({ path: 'notes/Ideas.md', problem: null });

  const refused = ['a\\b', 'C:foo', 'a\0b', 'a//b', '../secret', '.myelin/vault', 'C# notes', '[x]', 'a|b', 'why?', 'a /b', 'end.', 'x.md.md'];
  for (const query of refused) expect(newNoteFor(query)?.problem, query).toEqual(expect.any(String));
});
