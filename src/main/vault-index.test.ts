import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { contentHash, openIndex, SCHEMA_VERSION, syncIndex } from './vault-index';
import { writeFileAtomic } from './atomic-write';

let base: string;
let root: string;
let file: string;
let db: Database.Database;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'myelin-index-'));
  root = join(base, 'vault');
  file = join(base, 'userData', 'vaults', 'id', 'index.db');
  await mkdir(root);
  db = openIndex(file);
});

afterEach(async () => {
  db.close();
  await rm(base, { recursive: true, force: true });
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text, 'utf8');
}

const sync = () => syncIndex(db, root, new AbortController().signal);

const links = () =>
  db
    .prepare('SELECT source, target_path AS path, name, key FROM links ORDER BY source, from_pos')
    .all();

const search = (query: string) =>
  db
    .prepare(
      `SELECT notes.path FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid
       WHERE notes_fts MATCH ? ORDER BY notes.path`,
    )
    .pluck()
    .all(query);

const dump = () => ({
  notes: db.prepare('SELECT path, title, hash FROM notes ORDER BY path').all(),
  links: db.prepare('SELECT * FROM links ORDER BY source, from_pos').all(),
  text: db
    .prepare(
      `SELECT notes.path, notes_fts.title, body FROM notes_fts JOIN notes ON notes.id = notes_fts.rowid
       ORDER BY notes.path`,
    )
    .all(),
});

test('uses WAL and creates only the note, link and search tables', () => {
  expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
  expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'notes_fts_%' ORDER BY name")
    .pluck()
    .all();
  expect(tables).toEqual(['links', 'notes', 'notes_fts']);
});

test('indexes notes with their hash', async () => {
  await write('Projects/Myelin.md', 'body');
  expect(await sync()).toMatchObject({ notes: 1, indexed: 1, removed: 0, failed: 0 });
  expect(dump().notes).toEqual([{ path: 'Projects/Myelin.md', title: 'Myelin', hash: contentHash('body') }]);
});

test('the hash matches what writeFileAtomic puts on disk, BOM included', async () => {
  const content = '﻿# Configuração\r\n';
  await writeFileAtomic(join(root, 'A.md'), content);
  await sync();
  expect(dump().notes).toMatchObject([{ hash: contentHash(content) }]);
});

test('stores resolved and unresolved links with their positions', async () => {
  const text = '﻿See [[b|the B]] and [[Missing#Part]].\n`[[not a link]]`\n';
  await write('A.md', text);
  await write('sub/B.md', '[[#Top]]');
  await sync();
  expect(links()).toEqual([
    { source: 'A.md', path: 'sub/B.md', name: null, key: 'b' },
    { source: 'A.md', path: null, name: 'Missing', key: 'missing' },
    { source: 'sub/B.md', path: 'sub/B.md', name: null, key: '' },
  ]);
  const row = db.prepare("SELECT * FROM links WHERE key = 'b'").get() as Record<string, number | string>;
  const plain = text.slice(1); // offsets ignore the BOM
  expect(plain.slice(row['from_pos'] as number, row['to_pos'] as number)).toBe('[[b|the B]]');
  expect(plain.slice(row['target_from'] as number, row['target_to'] as number)).toBe('b');
  expect(row).toMatchObject({ target: 'b', alias: 'the B', subpath: '' });
});

test('search ignores accents, also in decomposed text', async () => {
  await write('A.md', 'A configuração do índice.');
  await write('B.md', 'configuração'.normalize('NFD'));
  await write('Memória.md', 'nada');
  await sync();
  expect(search('configuracao')).toEqual(['A.md', 'B.md']);
  expect(search('configuração')).toEqual(['A.md', 'B.md']);
  expect(search('memoria')).toEqual(['Memória.md']);
});

test('a deleted index is rebuilt in full on the next open', async () => {
  await write('A.md', 'ideia [[B]]');
  await write('B.md', 'outra');
  await sync();
  const before = dump();
  db.close();
  await rm(file);
  db = openIndex(file);
  expect(await sync()).toMatchObject({ indexed: 2 });
  expect(dump()).toEqual(before);
});

test('a damaged index or another schema version starts over', async () => {
  await write('A.md', 'a');
  await sync();
  db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  db.close();
  db = openIndex(file);
  expect(dump().notes).toEqual([]);
  db.close();

  await writeFile(file, 'not a database '.repeat(100), 'utf8');
  db = openIndex(file);
  expect(await sync()).toMatchObject({ indexed: 1 });
});

test('the next sync picks up only what changed while the vault was closed', async () => {
  await write('A.md', 'velho [[B]]');
  await write('B.md', 'b');
  await write('C.md', 'c');
  await sync();
  expect(await sync()).toMatchObject({ indexed: 0, removed: 0 });

  await write('A.md', 'texto novo [[C]]');
  await rm(join(root, 'B.md'));
  expect(await sync()).toMatchObject({ notes: 2, indexed: 1, removed: 1 });
  expect(links()).toEqual([{ source: 'A.md', path: 'C.md', name: null, key: 'c' }]);
  expect(search('velho')).toEqual([]);
  expect(search('novo')).toEqual(['A.md']);
  expect(db.prepare('SELECT count(*) FROM notes_fts').pluck().get()).toBe(2);
});

test('a new mtime with the same content is not reindexed', async () => {
  await write('A.md', 'a');
  await sync();
  const later = new Date((await stat(join(root, 'A.md'))).mtimeMs + 60_000);
  await utimes(join(root, 'A.md'), later, later);
  expect(await sync()).toMatchObject({ indexed: 0 });
  expect(db.prepare('SELECT mtime_ms FROM notes').pluck().get()).toBe(later.getTime());
});

test('links of unchanged notes follow notes that are created and deleted', async () => {
  await write('A.md', '[[Note]] [[folder/Note]]');
  await sync();
  const targets = () => db.prepare('SELECT target_path FROM links ORDER BY from_pos').pluck().all();
  expect(targets()).toEqual([null, null]);

  await write('deep/folder/Note.md', '');
  await sync();
  expect(targets()).toEqual(['deep/folder/Note.md', 'deep/folder/Note.md']);

  // A shorter namesake takes over the bare name only.
  await write('Note.md', '');
  await sync();
  expect(targets()).toEqual(['Note.md', 'deep/folder/Note.md']);

  await rm(join(root, 'Note.md'));
  await rm(join(root, 'deep'), { recursive: true });
  await sync();
  expect(db.prepare('SELECT target_path AS path, name FROM links ORDER BY from_pos').all()).toEqual([
    { path: null, name: 'Note' },
    { path: null, name: 'folder/Note' },
  ]);
});

test('an aborted sync stops, and the next one finishes the job', async () => {
  const count = 400;
  await Promise.all(
    Array.from({ length: count }, (_, i) => write(`n${i}.md`, `texto [[n${(i + 1) % count}]] `.repeat(50))),
  );
  const cancel = new AbortController();
  // Runs between two slices: the sync is under way when it sees the abort.
  const timer = setInterval(() => {
    if (db.prepare('SELECT count(*) FROM notes WHERE hash IS NOT NULL').pluck().get()) {
      cancel.abort(new Error('stop'));
    }
  }, 0);
  await expect(syncIndex(db, root, cancel.signal)).rejects.toThrow('stop');
  clearInterval(timer);
  const done = db.prepare('SELECT count(*) FROM notes WHERE hash IS NOT NULL').pluck().get() as number;
  expect(done).toBeGreaterThan(0);
  expect(done).toBeLessThan(count);

  expect(await sync()).toMatchObject({ indexed: count - done, removed: 0 });
  expect(db.prepare('SELECT count(*) FROM links WHERE target_path IS NOT NULL').pluck().get()).toBe(count * 50);
});
