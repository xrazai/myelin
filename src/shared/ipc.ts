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

/**
 * The tree has folders and `.md` notes only; `.myelin/` is never listed, nor is any other
 * dot entry. Symlinks and junctions are not listed. A folder is listed even if empty.
 * A note's `name` has no `.md`. Order: folders first, then by name (case and accents
 * ignored, numbers by value).
 */
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

/** Short preview of a note for hover tooltips. */
export interface NotePreview {
  path: string;
  title: string;
  /** First ~500 chars of the note, plain text. */
  excerpt: string;
}

/**
 * What `writeNote` did. `conflict`: the disk did not hold `base`, so nothing was written;
 * `disk` is what it holds (`null`: there is no note).
 */
export type WriteResult = { status: 'saved' } | { status: 'conflict'; disk: string | null };

/**
 * A change on disk made outside the app (the watcher drops the app's own writes). One
 * exception: a note, or folder, that an app write creates is reported as `created`.
 */
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
  /** The path of every note in the tree, in tree order. No content. */
  listNotes(): Promise<string[]>;
  /** Full text of a note. */
  readNote(path: string): Promise<string>;
  /** Short previews for a batch of note paths; `null` for missing or unreadable notes. */
  getPreviews(paths: string[]): Promise<(NotePreview | null)[]>;
  /**
   * Atomically replaces the note's text, only if the disk still holds `base`: the text
   * `readNote` returned or the last one written. `null` creates the note (and its folders),
   * only if there is none. `content` is written as is, BOM and line endings included.
   */
  writeNote(path: string, content: string, base: string | null): Promise<WriteResult>;
  /** Renames a note, rewriting every link to it. Rejects if `to` already exists. */
  renameNote(from: string, to: string): Promise<void>;
  /**
   * Does the close or reload that the page held back (`beforeunload`) to save first. The
   * page cannot tell which one it was.
   */
  resumeUnload(): Promise<void>;
  /** Cards ordered by relevance. */
  search(query: string): Promise<SearchCard[]>;
  /** Watcher events, in batches. Returns the unsubscribe function. */
  onVaultEvents(listener: (events: VaultEvent[]) => void): () => void;
  /**
   * `true` when the index sync of a vault starts, `false` when it ends, failed or not.
   * The first one is sent before `createVault`/`openVault` resolve. Returns the
   * unsubscribe function.
   */
  onIndexing(listener: (active: boolean) => void): () => void;
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
  listNotes: 'note:list',
  readNote: 'note:read',
  getPreviews: 'note:previews',
  writeNote: 'note:write',
  renameNote: 'note:rename',
  search: 'brain:search',
  resumeUnload: 'window:resume-unload',
} as const satisfies Record<CallName, string>;

/** Push channels, main -> renderer, with their payloads. */
export interface EventPayloads {
  'vault:events': VaultEvent[];
  'vault:indexing': boolean;
}

export const EVENT_CHANNELS = {
  vaultEvents: 'vault:events',
  indexing: 'vault:indexing',
} as const satisfies Record<string, keyof EventPayloads>;
