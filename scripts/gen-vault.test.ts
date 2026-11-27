import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { generateVault } from './gen-vault';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'myelin-gen-vault-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readVault(dir: string): Promise<Map<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = new Map<string, string>();
  for (const entry of entries.filter((e) => e.isFile())) {
    const path = join(entry.parentPath, entry.name);
    files.set(path.slice(dir.length + 1), await readFile(path, 'utf8'));
  }
  return files;
}

test('same seed gives the same vault, another seed does not', async () => {
  const a = await generateVault({ notes: 600, seed: 7, out: join(root, 'a') });
  const b = await generateVault({ notes: 600, seed: 7, out: join(root, 'b') });
  const c = await generateVault({ notes: 600, seed: 8, out: join(root, 'c') });
  expect(b.hash).toBe(a.hash);
  expect(c.hash).not.toBe(a.hash);
  expect(await readVault(b.out)).toEqual(await readVault(a.out));
}, 60_000);

test('has the requested notes, unique names, resolvable links and accented text', async () => {
  const summary = await generateVault({ notes: 2000, seed: 1, out: join(root, 'shape') });
  const files = await readVault(summary.out);
  const names = new Set([...files.keys()].map((p) => basename(p, '.md').toLowerCase()));
  expect(files.size).toBe(2000);
  expect(names.size).toBe(2000);

  const targets = [...files.values()].flatMap((text) =>
    [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]!.toLowerCase()),
  );
  const unresolved = targets.filter((t) => !names.has(t));
  expect(targets.length).toBe(summary.links);
  expect(unresolved.length).toBeGreaterThan(0);
  expect(unresolved.length / targets.length).toBeLessThan(0.02);
  expect([...files.values()].join('')).toMatch(/[ãçéíóúâêô]/);
}, 60_000);

test('refuses a folder inside the repo or a non-empty one', async () => {
  const inRepo = fileURLToPath(new URL('../vault-dev', import.meta.url));
  await expect(generateVault({ notes: 20, seed: 1, out: inRepo })).rejects.toThrow('outside the repo');
  await generateVault({ notes: 20, seed: 1, out: join(root, 'used') });
  await expect(generateVault({ notes: 20, seed: 1, out: join(root, 'used') })).rejects.toThrow('not empty');
});
