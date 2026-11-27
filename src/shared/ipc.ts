// The whole IPC contract: every call and event between the renderer and main/vault-worker.
// No IPC channel exists outside this file. Imported by main, preload and renderer,
// so it must not import `electron`, `node:*` or the DOM.
//
// Every `path` is relative to the vault root, uses `/` on every OS, has no leading slash,
// and keeps the `.md` extension on notes (e.g. `Projects/Myelin.md`). The note path is
// the key of a note everywhere. Paths coming from the renderer are untrusted: the
// handler must reject any path that resolves outside the vault.

export interface VaultInfo {
  /** Id stored in `.myelin/vault.json`. */
  id: string;
  /** Folder name, for display. */
  name: string;
  /** Absolute OS path of the vault root, for display only. */
  root: string;
}

/** The tree has folders and `.md` notes only; `.myelin/` is never listed. */
export type TreeEntry =
  | { kind: 'folder'; name: string; path: string; children: TreeEntry[] }
  | { kind: 'note'; name: string; path: string };

/** One search result; same shape as `brain-adapter.search()`. */
export interface SearchCard {
  path: string;
  title: string;
  /** Plain text, never HTML. */
  excerpt: string;
  /** Higher is more relevant. Only comparable within one result list. */
  score: number;
}

/** A change on disk made outside the app (the watcher drops the app's own writes). */
export type VaultEvent =
  | { type: 'created' | 'deleted'; kind: TreeEntry['kind']; path: string }
  /** Note content changed. An external rename arrives as `deleted` + `created`. */
  | { type: 'changed'; path: string };

/**
 * `window.myelin`. Calls reject on failure. All calls except `createVault` and
 * `openVault` need an open vault.
 */
export interface MyelinApi {
  /** Shows the folder dialog and creates a vault there. `null` if canceled. */
  createVault(): Promise<VaultInfo | null>;
  /** Shows the folder dialog and opens that vault. `null` if canceled. */
  openVault(): Promise<VaultInfo | null>;
  /** Entries at the vault root. */
  getTree(): Promise<TreeEntry[]>;
  /** Full text of a note. */
  readNote(path: string): Promise<string>;
  /** Atomically replaces the note's text; creates the note if it does not exist. */
  writeNote(path: string, content: string): Promise<void>;
  /** Cards ordered by relevance. */
  search(query: string): Promise<SearchCard[]>;
  /** Watcher events, in batches. Returns the unsubscribe function. */
  onVaultEvents(listener: (events: VaultEvent[]) => void): () => void;
}

/** Methods answered by main (request/response); the rest are subscriptions. */
export type CallName = Exclude<keyof MyelinApi, `on${string}`>;

/** What main implements, one handler per request/response channel. */
export type CallHandlers = {
  [K in CallName]: (
    ...args: Parameters<MyelinApi[K]>
  ) => ReturnType<MyelinApi[K]> | Awaited<ReturnType<MyelinApi[K]>>;
};

/** Request/response channels, renderer -> main. */
export const CALL_CHANNELS = {
  createVault: 'vault:create',
  openVault: 'vault:open',
  getTree: 'vault:tree',
  readNote: 'note:read',
  writeNote: 'note:write',
  search: 'brain:search',
} as const satisfies Record<CallName, string>;

/** Push channels, main -> renderer, with their payloads. */
export interface EventPayloads {
  'vault:events': VaultEvent[];
}

export const EVENT_CHANNELS = {
  vaultEvents: 'vault:events',
} as const satisfies Record<string, keyof EventPayloads>;
