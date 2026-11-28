// Messages between main and vault-worker (worker thread, not Electron IPC).
// A new request is a line here and a handler in `vault-worker.ts`.
import type {
  Backlink,
  DeleteInfo,
  FolderRenameResult,
  GraphSnapshot,
  NotePreview,
  RenameResult,
  SearchCard,
  TreeEntry,
  VaultEvent,
  VaultInfo,
  WriteResult,
} from '../shared/ipc';
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
  /** The folder of the vault opened last, or `null`. */
  lastVault(): string | null;
  getTree(): TreeEntry[];
  /** `listNotes` of the contract, on the current vault. */
  listNotes(): string[];
  /** Full text of a note of the current vault. Rejects a path outside the contract. */
  readNote(path: string): string;
  search(query: string): SearchCard[];
  getGraph(): GraphSnapshot | null;
  saveGraphPositions(paths: string[], positions: Float32Array): void;
  getBacklinks(path: string): Backlink[] | null;
  /** Short previews for a batch of note paths; `null` for missing or unreadable notes. */
  getPreviews(paths: string[]): (NotePreview | null)[];
  /** `writeNote` of the contract, on the current vault. */
  writeNote(path: string, content: string, base: string | null): WriteResult;
  /** `renameNote` of the contract: one batch, including link rewrites and one reindex. */
  renameNote(from: string, to: string): RenameResult;
  /** `createFolder` of the contract, on the current vault. */
  createFolder(path: string): void;
  renameFolder(from: string, to: string): FolderRenameResult;
  deleteInfo(path: string, kind: TreeEntry['kind']): DeleteInfo;
  /** `deleteItem` of the contract; asks main for the move with a `trash` message. */
  deleteItem(path: string, kind: TreeEntry['kind']): string[];
  /**
   * Settles when the current vault's index sync ends. Rejects if the index cannot be
   * opened or synced, or if another `open` cancels it.
   */
  whenIndexed(): SyncReport;
}

export type VaultRequest = {
  [M in keyof VaultRequests]: { id: number; method: M; args: Parameters<VaultRequests[M]> };
}[keyof VaultRequests];

/** Main's answer to a `trash` message. `error`: why nothing, or not all, was moved. */
export interface TrashReply {
  type: 'trashed';
  id: number;
  error: string | null;
}

export type WorkerMessage =
  /** Move the file or folder at this absolute path to the Recycle Bin. */
  | { type: 'trash'; id: number; path: string }
  | { type: 'ready'; sqliteVersion: string }
  /** External changes in the current vault, not tied to any request. */
  | { type: 'events'; events: VaultEvent[] }
  /** The index of the current vault changed. */
  | { type: 'graph' }
  | { type: 'result'; id: number; result: unknown }
  | { type: 'error'; id: number; message: string };
