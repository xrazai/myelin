import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { existingNotePath, resolveNotePath } from './vault-path';

let base: string;
let root: string;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'myelin-path-'));
  root = join(base, 'vault');
  await mkdir(join(root, 'folder'), { recursive: true });
  await mkdir(join(root, 'dir.md'));
  await mkdir(join(base, 'outside'));
  await writeFile(join(root, 'folder', 'Note.md'), 'x', 'utf8');
  await writeFile(join(base, 'outside', 'Secret.md'), 'x', 'utf8');
  // A junction needs no privilege on Windows; elsewhere the type is ignored.
  await symlink(join(base, 'outside'), join(root, 'link'), 'junction');
});

afterAll(() => rm(base, { recursive: true, force: true }));

test('accepts a note path of the contract', () => {
  expect(resolveNotePath(root, 'folder/Note.md')).toBe(join(root, 'folder', 'Note.md'));
  expect(resolveNotePath(root, 'Referências/a..b.MD')).toBe(join(root, 'Referências', 'a..b.MD'));
});

test.each([
  '../outside/Secret.md',
  'folder/../../outside/Secret.md',
  './Note.md',
  '/etc/Note.md',
  'C:/Users/Note.md',
  'C:Note.md',
  '//server/share/Note.md',
  'folder\\..\\..\\Note.md',
  'folder//Note.md',
  '.myelin/vault.md',
  'folder/.hidden.md',
  'Note.md:stream.md',
  'Note.md\0.md',
  '.myelin/vault.json',
  'folder',
  '',
  42,
  null,
])('refuses %j', (path) => {
  expect(() => resolveNotePath(root, path)).toThrow('not a note path');
});

test('an existing note passes', async () => {
  expect(await existingNotePath(root, 'folder/Note.md')).toBe(join(root, 'folder', 'Note.md'));
});

test('refuses a path through a junction or symlink', async () => {
  await expect(existingNotePath(root, 'link/Secret.md')).rejects.toThrow('not a note');
});

test('refuses a folder and a missing note', async () => {
  await expect(existingNotePath(root, 'dir.md')).rejects.toThrow('not a note');
  await expect(existingNotePath(root, 'missing.md')).rejects.toThrow('ENOENT');
});
