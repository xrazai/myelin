import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadVaultConfig } from './vault-config';

const ID = '3f2b8c1a-9d4e-4f6a-8b2c-1e5d7a9c0b34';

let root: string;
const file = () => join(root, '.myelin', 'vault.json');
const read = () => readFile(file(), 'utf8');

async function put(text: string): Promise<void> {
  await mkdir(join(root, '.myelin'), { recursive: true });
  await writeFile(file(), text, 'utf8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'myelin-config-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test('creates vault.json with a new id and the format version', async () => {
  const config = await loadVaultConfig(root);
  expect(config.formatVersion).toBe(1);
  expect(config.id).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  expect(await read()).toBe(`${JSON.stringify(config, null, 2)}\n`);
});

test('creates the file when .myelin/ exists without it', async () => {
  await mkdir(join(root, '.myelin'));
  const config = await loadVaultConfig(root);
  expect(JSON.parse(await read())).toEqual(config);
});

test('keeps an existing file byte for byte, extra fields and BOM included', async () => {
  const text = `﻿{"formatVersion":1,"id":"${ID}","extra":true}`;
  await put(text);
  expect(await loadVaultConfig(root)).toEqual({ id: ID, formatVersion: 1 });
  expect(await read()).toBe(text);
});

test('concurrent first opens end with one id', async () => {
  const [first, second] = await Promise.allSettled([loadVaultConfig(root), loadVaultConfig(root)]);
  const stored = JSON.parse(await read()) as { id: string };
  // The loser may read before the winner finished writing; it must never replace the file.
  for (const result of [first, second]) {
    if (result.status === 'fulfilled') expect(result.value.id).toBe(stored.id);
  }
  expect([first.status, second.status]).toContain('fulfilled');
});

test.each([
  ['', 'is not valid JSON'],
  ['{ broken', 'is not valid JSON'],
  ['null', 'has no format version'],
  [`{"id":"${ID}"}`, 'has no format version'],
  [`{"id":"${ID}","formatVersion":2}`, 'has format version 2. This version of Myelin supports format version 1'],
  [`{"id":"${ID}","formatVersion":"1"}`, 'has format version "1"'],
  ['{"formatVersion":1}', 'has no valid vault id'],
  ['{"formatVersion":1,"id":7}', 'has no valid vault id'],
  ['{"formatVersion":1,"id":"../../elsewhere"}', 'has no valid vault id'],
])('rejects %j and leaves it untouched', async (text, message) => {
  await put(text);
  await expect(loadVaultConfig(root)).rejects.toThrow(message);
  expect(await read()).toBe(text);
});
