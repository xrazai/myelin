import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { TreeEntry } from '../shared/ipc';
import { scanVault } from './vault-scan';

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'myelin-scan-'));
  root = join(base, 'vault');
  await mkdir(root);
});

afterEach(() => rm(base, { recursive: true, force: true }));

async function file(path: string, at = root): Promise<void> {
  await mkdir(dirname(join(at, path)), { recursive: true });
  await writeFile(join(at, path), '', 'utf8');
}

const note = (name: string, path: string): TreeEntry => ({ kind: 'note', name, path });
const folder = (name: string, path: string, children: TreeEntry[]): TreeEntry => ({
  kind: 'folder',
  name,
  path,
  children,
});

test('lists folders and notes with vault-relative paths', async () => {
  await file('Home.md');
  await file('Projetos/Ótica/Reflexão.MD');
  expect(await scanVault(root)).toEqual([
    folder('Projetos', 'Projetos', [
      folder('Ótica', 'Projetos/Ótica', [note('Reflexão', 'Projetos/Ótica/Reflexão.MD')]),
    ]),
    note('Home', 'Home.md'),
  ]);
});

test('hides dot entries and non-.md files, keeps folders left empty', async () => {
  for (const path of [
    '.myelin/vault.json',
    '.myelin/inside.md',
    '.git/readme.md',
    '.hidden.md',
    'sub/.obsidian/a.md',
    'image.png',
    'Note.md.tmp',
    'notes.mdx',
    'assets/photo.jpg',
  ]) {
    await file(path);
  }
  await mkdir(join(root, 'empty'));
  await mkdir(join(root, 'folder.md'));
  expect(await scanVault(root)).toEqual([
    folder('assets', 'assets', []),
    folder('empty', 'empty', []),
    folder('folder.md', 'folder.md', []),
    folder('sub', 'sub', []),
  ]);
});

test('orders folders first, then by name ignoring case and accents, numbers by value', async () => {
  for (const path of ['nota 10.md', 'nota 2.md', 'Zebra.md', 'árvore.md', 'Bola.md', 'zz/a.md']) {
    await file(path);
  }
  expect((await scanVault(root)).map((entry) => entry.name)).toEqual([
    'zz',
    'árvore',
    'Bola',
    'nota 2',
    'nota 10',
    'Zebra',
  ]);
});

// A junction needs no privileges on Windows; elsewhere the type argument is ignored.
test('does not follow links: no cycles, nothing outside the vault', async () => {
  const outside = join(base, 'outside');
  await file('secret.md', outside);
  await symlink(outside, join(root, 'out'), 'junction');
  await symlink(root, join(root, 'loop'), 'junction');
  await file('Home.md');
  expect(await scanVault(root)).toEqual([note('Home', 'Home.md')]);
});

test('rejects when the root cannot be read', async () => {
  await expect(scanVault(join(base, 'missing'))).rejects.toThrow('ENOENT');
});
