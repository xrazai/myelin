// Messages between main and vault-worker (worker thread, not Electron IPC).
// A new request is a line here and a handler in `vault-worker.ts`.
import type { NotePreview, RenameResult, TreeEntry, VaultEvent, VaultInfo, WriteResult } from '../shared/ipc';
import type { SyncReport } from './vault-index';

/** `workerData` of the worker. */
export interface VaultWorkerData {
  /** Electron's `userData` folder: each vault's `index.db` lives under it. */
  userData: string;
}

export interface VaultRequests {
  /**
   * Makes the folder at this absolute path the current vault, creating `.myelin/vault.json`
   * if it is missing. Rejects, keeping the current vault, if that file cannot be used.
   * Resolves without waiting for the index, which syncs in the background.
   */
  open(root: string): VaultInfo;
  getTree(): TreeEntry[];
  /** `listNotes` of the contract, on the current vault. */
  listNotes(): string[];
  /** Full text of a note of the current vault. Rejects a path outside the contract. */
  readNote(path: string): string;
  /** Short previews for a batch of note paths; `null` for missing or unreadable notes. */
  getPreviews(paths: string[]): (NotePreview | null)[];
  /** `writeNote` of the contract, on the current vault. */
  writeNote(path: string, content: string, base: string | null): WriteResult;
  /** `renameNote` of the contract: one batch, including link rewrites and one reindex. */
  renameNote(from: string, to: string): RenameResult;
  /**
   * Settles when the current vault's index sync ends. Rejects if the index cannot be
   * opened or synced, or if another `open` cancels it.
   */
  whenIndexed(): SyncReport;
}

export type VaultRequest = {
  [M in keyof VaultRequests]: { id: number; method: M; args: Parameters<VaultRequests[M]> };
}[keyof VaultRequests];

export type WorkerMessage =
  | { type: 'ready'; sqliteVersion: string }
  /** External changes in the current vault, not tied to any request. */
  | { type: 'events'; events: VaultEvent[] }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string };
