import Database from 'better-sqlite3';
import { expect, test } from 'vitest';

// The same Node-API binary serves Node and Electron, so tests can use the real module.
test('SQLite has FTS5 with the diacritics-insensitive tokenizer', () => {
  const db = new Database(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')");
  db.prepare('INSERT INTO t (body) VALUES (?)').run('memória');
  expect(db.prepare('SELECT count(*) FROM t WHERE t MATCH ?').pluck().get('memoria')).toBe(1);
  db.close();
});
