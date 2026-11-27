// Owner of all vault file I/O, the watcher, parsing and SQLite (AGENTS.md, rule 1).
// Tests start this file directly in Node (type stripping): erasable TypeScript only, and
// project imports other than `import type` carry the `.ts` extension.
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { VaultRequest, VaultRequests, VaultWorkerData, WorkerMessage } from './vault-protocol';
import { loadVaultConfig } from './vault-config.ts';
import { deleteIndex, indexPath, notePaths, openIndex } from './vault-index.ts';
import { readNotePreview } from './note-preview.ts';
import { existingNotePath, folderOnDiskInOtherCase, writableNotePath } from './vault-path.ts';
import { appendUsageEvent } from './vault-usage.ts';
import { watchVault, type VaultWatch } from './vault-watcher.ts';

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

interface Session {
  root: string;
  watch: VaultWatch;
}

let session: Session | null = null;

function openSession(): Session {
  if (session === null) throw new Error('no vault is open');
  return session;
}

/** Watches the vault; its index opens once `after` settles. */
function startSession(root: string, id: string, after: Promise<void>): Session {
  const watch = watchVault(root, {
    async openDb(damaged) {
      await after;
      const { userData } = workerData as VaultWorkerData;
      const file = indexPath(userData, id);
      if (damaged) deleteIndex(file);
      return openIndex(file);
    },
    emit: (events) => post({ type: 'events', events }),
  });
  return { root, watch };
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
    // The old session lets go of its database before the new one opens: it may be the same file.
    session = startSession(root, id, session?.watch.close() ?? Promise.resolve());
    // A drive root has no folder name.
    return { id, name: basename(root) || root, root };
  },
  async getTree() {
    return openSession().watch.getTree();
  },
  async listNotes() {
    return notePaths(await openSession().watch.getTree());
  },
  async readNote(path) {
    return readFile(await existingNotePath(openSession().root, path), 'utf8');
  },
  async getPreviews(paths) {
    if (!Array.isArray(paths)) throw new Error('paths must be an array');
    const { root } = openSession();
    return Promise.all(
      paths.map(async (path) => {
        try {
          return await readNotePreview(await existingNotePath(root, path), path);
        } catch {
          return null;
        }
      }),
    );
  },
  async writeNote(path, content, base) {
    if (typeof content !== 'string' || (base !== null && typeof base !== 'string')) {
      throw new Error('the note text must be a string');
    }
    const { root, watch } = openSession();
    const file = await writableNotePath(root, path);
    if (base === null) {
      const folder = await folderOnDiskInOtherCase(root, path);
      if (folder !== null) throw new Error(`the folder is named ${folder}`);
      // A note saved again after its folder was deleted.
      await mkdir(dirname(file), { recursive: true });
    }
    return watch.write(path, content, base);
  },
  async renameNote(from, to) {
    if (typeof from !== 'string' || typeof to !== 'string') throw new Error('both paths must be strings');
    const { root, watch } = openSession();
    const result = await watch.rename(from, to);
    // The note has moved by now: failing to log it must not report the rename as failed.
    if (from !== to) {
      await appendUsageEvent(root, { type: 'renamed', from, to, at: new Date().toISOString() }).catch(
        (error: unknown) => console.error('[vault-worker] logging a rename failed:', error),
      );
    }
    return result;
  },
  async whenIndexed() {
    return openSession().watch.indexed;
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
