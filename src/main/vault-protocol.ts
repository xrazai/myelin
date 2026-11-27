// Messages between main and vault-worker (worker thread, not Electron IPC).
// A new request is a line here and a handler in `vault-worker.ts`.
import type { TreeEntry } from '../shared/ipc';

export interface VaultRequests {
  /** Makes the folder at this absolute path the current vault. */
  open(root: string): void;
  getTree(): TreeEntry[];
}

export type VaultRequest = {
  [M in keyof VaultRequests]: { id: number; method: M; args: Parameters<VaultRequests[M]> };
}[keyof VaultRequests];

export type WorkerMessage =
  | { type: 'ready'; sqliteVersion: string }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string };
