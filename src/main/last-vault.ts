// The vault to reopen on start, in `userData`. Runs inside vault-worker only. Loaded by
// Node as-is in tests (type stripping): erasable TypeScript.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const NAME = 'last-vault.json';

export async function rememberVault(userData: string, root: string): Promise<void> {
  await writeFile(join(userData, NAME), `${JSON.stringify({ root })}\n`, 'utf8');
}

/** `null` if none was remembered, or the file cannot be used. */
export async function lastVault(userData: string): Promise<string | null> {
  try {
    const { root } = JSON.parse(await readFile(join(userData, NAME), 'utf8')) as { root?: unknown };
    return typeof root === 'string' && root !== '' ? root : null;
  } catch {
    return null;
  }
}
