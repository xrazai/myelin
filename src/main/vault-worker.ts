// Owner of all vault file I/O, the watcher, parsing and SQLite (AGENTS.md, rule 1).
// Tests start this file directly in Node (type stripping): erasable TypeScript only, and
// project imports other than `import type` carry the `.ts` extension.
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parentPort } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { VaultRequest, VaultRequests, WorkerMessage } from './vault-protocol';
import { loadVaultConfig } from './vault-config.ts';
import { scanVault } from './vault-scan.ts';

// Startup check: the native module loads in this thread and its SQLite has FTS5.
function checkSqlite(): string {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(body)');
    return db.prepare('SELECT sqlite_version()').pluck().get() as string;
  } finally {
    db.close();
  }
}

let vaultRoot: string | null = null;

function openRoot(): string {
  if (vaultRoot === null) throw new Error('no vault is open');
  return vaultRoot;
}

type Handlers = {
  [M in keyof VaultRequests]: (
    ...args: Parameters<VaultRequests[M]>
  ) => Promise<ReturnType<VaultRequests[M]>>;
};

const handlers: Handlers = {
  async open(path) {
    const root = resolve(path);
    if (!(await stat(root)).isDirectory()) throw new Error(`not a folder: ${root}`);
    const { id } = await loadVaultConfig(root);
    vaultRoot = root;
    // A drive root has no folder name.
    return { id, name: basename(root) || root, root };
  },
  async getTree() {
    return scanVault(openRoot());
  },
};

const post = (message: WorkerMessage) => parentPort?.postMessage(message);

parentPort?.on('message', async ({ id, method, args }: VaultRequest) => {
  try {
    const handler = handlers[method] as (...args: unknown[]) => Promise<unknown>;
    post({ type: 'result', id, result: await handler(...args) });
  } catch (error) {
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  }
});

post({ type: 'ready', sqliteVersion: checkSqlite() });
