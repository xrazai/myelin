// `.myelin/vault.json`: the vault's identity. Runs inside vault-worker only.
// Loaded by Node as-is in tests (type stripping): erasable TypeScript, only `import type`
// from other project files.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FORMAT_VERSION = 1;

export interface VaultConfig {
  id: string;
  formatVersion: typeof FORMAT_VERSION;
}

// The id names a folder under userData, and the file may arrive through sync or Git:
// nothing but a UUID is accepted.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NAME = '.myelin/vault.json';

function parse(text: string): VaultConfig {
  let data: unknown;
  try {
    // Some Windows editors add a BOM.
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error(`${NAME} is not valid JSON.`);
  }
  const { id, formatVersion } = (data ?? {}) as Record<string, unknown>;
  // Version first: a newer format may keep the id somewhere else.
  if (formatVersion !== FORMAT_VERSION) {
    const found = formatVersion === undefined ? 'no format version' : `format version ${JSON.stringify(formatVersion)}`;
    throw new Error(`${NAME} has ${found}. This version of Myelin supports format version ${FORMAT_VERSION}.`);
  }
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error(`${NAME} has no valid vault id.`);
  return { id, formatVersion };
}

/**
 * Reads the vault's `vault.json`, creating it first if it is missing. An existing file is
 * never written to, valid or not.
 */
export async function loadVaultConfig(root: string): Promise<VaultConfig> {
  const folder = join(root, '.myelin');
  const file = join(folder, 'vault.json');
  await mkdir(folder, { recursive: true });
  const config: VaultConfig = { id: randomUUID(), formatVersion: FORMAT_VERSION };
  try {
    // `wx` fails if the file exists, so there is no window in which it could be replaced.
    await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', flush: true });
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return parse(await readFile(file, 'utf8'));
}
