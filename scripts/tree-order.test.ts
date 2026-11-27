// A tree built from watcher events must equal the scan of the same folder. Lives here because
// it needs both sides: the scan (main, Node) and the tree model (renderer).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { scanVault } from '../src/main/vault-scan';
import { applyEvents } from '../src/renderer/tree-model';
import type { TreeEntry, VaultEvent } from '../src/shared/ipc';

const FOLDERS = ['10', '9', 'Álbum', 'album', 'Zeta/inner', 'Empty'];
const NOTES = [
  'Home.md',
  'Note 10.md',
  'Note 9.md',
  'note 11.md',
  'Éden.md',
  'edital.MD',
  'resume.md',
  'résumé.md',
  '10/a.md',
  'Zeta/inner/deep.md',
  'Zeta/Beta.md',
  'Zeta/alpha.md',
];

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'myelin-tree-order-'));
  for (const folder of FOLDERS) await mkdir(join(root, folder), { recursive: true });
  for (const note of NOTES) await writeFile(join(root, note), '', 'utf8');
});

afterAll(() => rm(root, { recursive: true, force: true }));

function events(tree: TreeEntry[]): VaultEvent[] {
  return tree.flatMap((entry) => [
    { type: 'created' as const, kind: entry.kind, path: entry.path },
    ...(entry.kind === 'folder' ? events(entry.children) : []),
  ]);
}

test('applying created events in any order gives the same tree as the scan', async () => {
  const scanned = await scanVault(root);
  const all = events(scanned);
  expect(all.length).toBeGreaterThanOrEqual(FOLDERS.length + NOTES.length);
  // Scan order, reversed (children before their folders), and a fixed shuffle.
  const shuffled = all.map((_, i) => all[(i * 7) % all.length]!);
  expect(new Set(shuffled).size).toBe(all.length);
  for (const order of [all, all.toReversed(), shuffled]) {
    expect(applyEvents([], order)).toEqual(scanned);
  }
});
