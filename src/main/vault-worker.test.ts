// Starts the real vault-worker in a worker thread and talks to it as main does.
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { createVaultClient, type VaultClient } from './vault-client';

let root: string;
let worker: Worker;
let vault: VaultClient;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  root = await mkdtemp(join(tmpdir(), 'myelin-worker-'));
  await writeFile(join(root, 'Home.md'), '# Home\n', 'utf8');
  worker = new Worker(new URL('./vault-worker.ts', import.meta.url));
  vault = createVaultClient(worker);
});

afterAll(async () => {
  await worker.terminate();
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test('rejects the tree while no vault is open', async () => {
  await expect(vault.call('getTree')).rejects.toThrow('no vault is open');
});

test('opens a folder and serves its tree from the worker thread', async () => {
  expect(worker.threadId).toBeGreaterThan(0);
  expect(await vault.call('open', root)).toMatchObject({ name: basename(root), root });
  expect(await vault.call('getTree')).toEqual([{ kind: 'note', name: 'Home', path: 'Home.md' }]);
});

test('a failed open rejects and keeps the current vault', async () => {
  await expect(vault.call('open', join(root, 'Home.md'))).rejects.toThrow('not a folder');
  await expect(vault.call('open', join(root, 'missing'))).rejects.toThrow('ENOENT');
  expect(await vault.call('getTree')).toHaveLength(1);
});

test('open serves the id stored in vault.json', async () => {
  const stored = JSON.parse(readFileSync(join(root, '.myelin', 'vault.json'), 'utf8')) as { id: string };
  expect((await vault.call('open', root)).id).toBe(stored.id);
});

test('a vault.json it cannot use rejects the open and keeps the current vault', async () => {
  const other = await mkdtemp(join(tmpdir(), 'myelin-broken-'));
  try {
    await mkdir(join(other, '.myelin'));
    await writeFile(join(other, '.myelin', 'vault.json'), '{ broken', 'utf8');
    await expect(vault.call('open', other)).rejects.toThrow('is not valid JSON');
    expect(await vault.call('getTree')).toEqual([{ kind: 'note', name: 'Home', path: 'Home.md' }]);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

// Rule 3: main only routes. Scanning code reaches it through no import.
test('main and its vault client do no file I/O', () => {
  for (const name of ['main.ts', 'vault-client.ts']) {
    const source = readFileSync(join(import.meta.dirname, name), 'utf8');
    expect(source).not.toMatch(/['"](node:)?fs(\/promises)?['"]|\.\/vault-(scan|config)|\.\/vault-worker['"]/);
  }
});

test('pending and later calls reject once the worker is gone', async () => {
  const doomed = new Worker(new URL('./vault-worker.ts', import.meta.url));
  const client = createVaultClient(doomed);
  const pending = expect(client.call('getTree')).rejects.toThrow('exited');
  await doomed.terminate();
  await pending;
  await expect(client.call('getTree')).rejects.toThrow('exited');
});
