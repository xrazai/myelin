import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorState } from '@codemirror/state';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { writableNotePath } from '../../main/vault-path';
import { watchVault } from '../../main/vault-watcher';
import { createLinkResolver } from '../../shared/links';
import { markdownSupport } from './cm-editor';
import { linkDestination, newNotePath } from './link-follow';
import { linkAt } from './link-syntax';

function at(text: string, edges = true) {
  const pos = text.indexOf('‸');
  const state = EditorState.create({ doc: text.replace('‸', ''), extensions: [markdownSupport] });
  return linkAt(state, pos, edges)?.target ?? null;
}

test.each([
  ['see [[No‸te]] there', 'Note'],
  ['see ‸[[Note|alias]]', 'Note'],
  ['see [[Note|alias]]‸', 'Note'],
  ['[[a]]‸[[b]]', 'b'],
  ['| [[Note|ali‸as]] | x |\n', 'Note'],
  ['| a |\n| - |\n| [[Note|ali‸as]] |', 'Note'],
  ['## [[Head‸ing]]', 'Heading'],
  ['plain ‸text [[Note]]', null],
  ['`[[No‸te]]`', null],
  ['```\n[[No‸te]]\n```', null],
  ['\\[[No‸te]]', null],
  ['[[ ‸ ]]', null],
])('the link at the cursor in %j', (text, target) => {
  expect(at(text)).toBe(target);
});

test('a click does not take the edges of a link', () => {
  expect(at('see [[Note]]‸', false)).toBeNull();
  expect(at('‸[[Note]]', false)).toBeNull();
  expect(at('[[N‸ote]]', false)).toBe('Note');
});

test.each(['a//b', '/a', 'a/', '../a', 'a/../b', '.hidden', 'c:/a', 'a\\..\\b', 'what?', 'dir./a', 'dir /a', 'a.'])(
  'refuses to create a note named %j',
  (name) => {
    expect(() => newNotePath(name)).toThrow('cannot be a note name');
  },
);

test.each(['Note', 'folder/Sub folder/Note', 'v1.2 plan', 'Ação'])('%j resolves to the note created for it', (name) => {
  expect(createLinkResolver([newNotePath(name)])(name, 'Home.md').path).toBe(`${name}.md`);
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'myelin-follow-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The write of the worker, on a real folder. */
async function onDisk() {
  const watch = watchVault(root, { openDb: () => Promise.reject(new Error('no index')), emit: () => {} });
  await watch.getTree();
  return {
    watch,
    writeNote: vi.fn(async (path: string, content: string, base: string | null) => {
      const file = await writableNotePath(root, path);
      if (base === null) await mkdir(join(file, '..'), { recursive: true });
      return watch.write(path, content, base);
    }),
  };
}

test('creates the missing note, with its folders, and writes nothing for a resolved one', async () => {
  const disk = await onDisk();
  const notes = { ready: Promise.resolve(), resolve: createLinkResolver(['deep/Known.md']) };
  expect(await linkDestination(notes, disk, 'known', 'Home.md')).toBe('deep/Known.md');
  expect(await linkDestination(notes, disk, '', 'Home.md')).toBe('Home.md');
  expect(disk.writeNote).not.toHaveBeenCalled();
  expect(await linkDestination(notes, disk, 'new/folder/Idea', 'Home.md')).toBe('new/folder/Idea.md');
  expect(await readFile(join(root, 'new/folder/Idea.md'), 'utf8')).toBe('');
  await disk.watch.close();
});

test('never replaces a file the list did not know about', async () => {
  await writeFile(join(root, 'There.md'), 'keep me', 'utf8');
  const disk = await onDisk();
  const notes = { ready: Promise.resolve(), resolve: createLinkResolver([]) };
  expect(await linkDestination(notes, disk, 'There', 'Home.md')).toBe('There.md');
  expect(await readFile(join(root, 'There.md'), 'utf8')).toBe('keep me');
  await disk.watch.close();
});

test('creates nothing outside the vault, nor without the list', async () => {
  const disk = await onDisk();
  const notes = { ready: Promise.resolve(), resolve: createLinkResolver([]) };
  await expect(linkDestination(notes, disk, '../outside-of-vault', 'Home.md')).rejects.toThrow();
  await expect(stat(join(root, '..', 'outside-of-vault.md'))).rejects.toThrow('ENOENT');
  const broken = { ...notes, ready: Promise.reject(new Error('no list')) };
  broken.ready.catch(() => {});
  await expect(linkDestination(broken, disk, 'Note', 'Home.md')).rejects.toThrow('no list');
  expect(disk.writeNote).not.toHaveBeenCalled();
  await disk.watch.close();
});
