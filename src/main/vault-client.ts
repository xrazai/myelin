// Main side of vault-worker: sends requests and settles them with its replies. No file I/O.
import type { Worker } from 'node:worker_threads';
import type { VaultEvent } from '../shared/ipc';
import type { TrashReply, VaultRequests, WorkerMessage } from './vault-protocol';

export interface VaultClient {
  call<M extends keyof VaultRequests>(
    method: M,
    ...args: Parameters<VaultRequests[M]>
  ): Promise<ReturnType<VaultRequests[M]>>;
}

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

export function createVaultClient(
  worker: Worker,
  onEvents?: (events: VaultEvent[]) => void,
  /** Moves a path to the Recycle Bin; without it, the worker is told it cannot. */
  trash: (path: string) => Promise<void> = () => Promise.reject(new Error('no Recycle Bin here')),
  onGraphChange?: () => void,
): VaultClient {
  const pending = new Map<number, Pending>();
  let lastId = 0;
  let dead: Error | null = null;

  const fail = (error: Error) => {
    dead ??= error;
    for (const request of pending.values()) request.reject(dead);
    pending.clear();
  };

  worker.on('message', (message: WorkerMessage) => {
    if (message.type === 'ready') {
      console.log(`[vault-worker] ready, SQLite ${message.sqliteVersion} with FTS5`);
      return;
    }
    if (message.type === 'events') {
      onEvents?.(message.events);
      return;
    }
    if (message.type === 'graph') {
      onGraphChange?.();
      return;
    }
    if (message.type === 'trash') {
      const { id, path } = message;
      const reply = (error: string | null) => worker.postMessage({ type: 'trashed', id, error } satisfies TrashReply);
      void trash(path).then(
        () => reply(null),
        (error: unknown) => reply(error instanceof Error ? error.message : String(error)),
      );
      return;
    }
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.type === 'result') request?.resolve(message.result);
    else request?.reject(new Error(message.message));
  });
  worker.on('error', (error: Error) => {
    console.error('[vault-worker] error:', error);
    fail(error);
  });
  worker.on('exit', (code) => fail(new Error(`vault-worker exited with code ${code}`)));

  return {
    call<M extends keyof VaultRequests>(method: M, ...args: Parameters<VaultRequests[M]>) {
      return new Promise<ReturnType<VaultRequests[M]>>((resolve, reject) => {
        if (dead) return reject(dead);
        const id = ++lastId;
        pending.set(id, { resolve: resolve as Pending['resolve'], reject });
        worker.postMessage({ id, method, args });
      });
    },
  };
}
