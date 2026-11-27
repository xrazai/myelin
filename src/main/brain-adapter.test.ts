import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { matchQuery, readSnippet, search } from './brain-adapter.ts';
import { openIndex, syncIndex } from './vault-index';

describe('matchQuery', () => {
  test('quotes every term and makes the last one a prefix', () => {
    expect(matchQuery('memória  de longo')).toBe('"memória" "de" "longo"*');
    expect(matchQuery('say "hi')).toBe('"say" """hi"*');
  });

  test('asks for nothing when there is nothing to look for', () => {
    for (const typed of ['', '   ', '*', '"', '( ) - :']) expect(matchQuery(typed), typed).toBeNull();
  });
});

test('readSnippet keeps where the matches are, on one line', () => {
  expect(readSnippet('a\nbc d')).toEqual({ excerpt: 'a bc d', matches: [[2, 4]] });
});

describe('search', () => {
  let base: string;
  let db: Database.Database;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'myelin-brain-'));
    const root = join(base, 'vault');
    await mkdir(root);
    const notes: Record<string, string> = {
      'Memória.md': 'Como o cérebro guarda lembranças.',
      'Sono.md': `${'texto de enchimento '.repeat(40)}o sono consolida a memória de longo prazo.`,
      'Sinapse.md': 'A mielina acelera a condução. Neurônios que disparam juntos.',
      'Compras.md': 'pão, café e leite',
    };
    for (const [name, text] of Object.entries(notes)) await writeFile(join(root, name), text, 'utf8');
    db = openIndex(join(base, 'index.db'));
    await syncIndex(db, root, new AbortController().signal);
  });

  afterAll(async () => {
    db.close();
    await rm(base, { recursive: true, force: true });
  });

  const paths = (typed: string) => search(db, typed).map((card) => card.path);

  test('ignores accents and case, in Portuguese', () => {
    expect(paths('memoria')).toEqual(['Memória.md', 'Sono.md']);
    expect(paths('NEURONIOS')).toEqual(['Sinapse.md']);
    expect(paths('cafe')).toEqual(['Compras.md']);
    expect(paths('conducao')).toEqual(['Sinapse.md']);
  });

  test('ranks a title above a body, needs every term and completes the last one', () => {
    const cards = search(db, 'memóri');
    expect(cards[0]!.path).toBe('Memória.md');
    expect(cards[0]!.score).toBeGreaterThan(cards[1]!.score);
    expect(paths('sono prazo')).toEqual(['Sono.md']);
    expect(paths('sono leite')).toEqual([]);
  });

  test('gives an excerpt around the match, with its ranges', () => {
    const [card] = search(db, 'longo praz');
    expect(card!.excerpt.startsWith('…')).toBe(true);
    expect(card!.matches.map(([from, to]) => card!.excerpt.slice(from, to))).toEqual(['longo', 'prazo']);
  });

  test('what was typed is never query syntax', () => {
    for (const typed of ['"', 'a OR', 'NOT x', '(', 'title:sono', 'sono AND*', 'NEAR(a b)', "'; DROP TABLE notes;--", '^café', '-leite']) {
      expect(() => search(db, typed), typed).not.toThrow();
    }
    expect(paths('^café')).toEqual(['Compras.md']);
    expect(search(db, 'sono', 1)).toHaveLength(1);
  });
});
