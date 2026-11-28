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
  /** The `[from, to)` ranges of `excerpt` that matched, for highlighting. */
  matches: [number, number][];
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
 * exceptions: what an app write creates is reported as `created`, and a rename or a
 * deletion asked of the app is reported like an outside one.
 */
export type VaultEvent =
  | { type: 'created' | 'deleted'; kind: TreeEntry['kind']; path: string }
  /** Note content changed. An external rename arrives as `deleted` + `created`. */
  | { type: 'changed'; path: string };

/**
 * `window.myelin`. Calls reject on failure. All calls except `createVault` and
 * `openVault` need an open vault.
 */
export interface FolderRenameResult extends RenameResult {
  /** The notes that moved, as `[old path, new path]`. */
  moved: [string, string][];
}

export interface Backlink {
  /** The note holding the link. */
  path: string;
  /** Line of the link, from 1, and its offset in that line (UTF-16 units). */
  line: number;
  column: number;
  /** That line, cut around the link if long. Plain text. */
  text: string;
}

export interface DeleteInfo {
  /** Notes that would go. */
  notes: number;
  /** Files of a folder that the tree does not show: they go with it. */
  otherFiles: number;
  /** Other notes with a link to something that would go; `null`: not indexed yet. */
  linkedFrom: number | null;
}

/** The notes and links of the index, as the graph takes them. */
export interface GraphSnapshot {
  paths: string[];
  /** `[source0, target0, ...]` as indices into `paths`: one pair per two linked notes. */
  edges: Uint32Array;
  /** The saved `[x0, y0, ...]` of each note; NaN where there is none. */
  positions: Float32Array;
  /** When each note's file last changed, ms since the epoch; 0 where unknown. */
  edited: Float64Array;
  /**
   * The saved community of each note, one array per level, the finest first. `null`
   * unless every note has one, with as many levels: they are then computed again.
   */
  communities: Uint32Array[] | null;
}

/** What changed in the graph since it was last asked for. Everything is by note path. */
export interface GraphDelta {
  removed: string[];
  /** New notes; `positions` holds their saved `[x0, y0, ...]`, NaN where there is none. */
  added: string[];
  positions: Float32Array;
  /** Pairs of linked notes. */
  removedEdges: [string, string][];
  addedEdges: [string, string][];
  /** Notes new or changed since, with when their files changed. */
  edited: [string, number][];
}

export interface RenameResult {
  /** Notes whose links could not be rewritten: held, changed meanwhile or not UTF-8. */
  notUpdated: string[];
}

export interface MyelinApi {
  /** Shows the folder dialog and creates a vault there. `null` if canceled. */
  createVault(): Promise<VaultInfo | null>;
  /** Shows the folder dialog and opens that vault. `null` if canceled. */
  openVault(): Promise<VaultInfo | null>;
  /**
   * Opens the vault opened last, without a dialog. `null` if there was none. Rejects if
   * its folder is gone or cannot be used.
   */
  reopenVault(): Promise<VaultInfo | null>;
  /** Entries at the vault root. */
  getTree(): Promise<TreeEntry[]>;
  /** The path of every note in the tree, in tree order. No content. */
  listNotes(): Promise<string[]>;
  /** Full text of a note. */
  readNote(path: string): Promise<string>;
  /**
   * The links of other notes that lead to the note at `path`, in path then text order.
   * `null` while the vault is first being indexed.
   */
  getBacklinks(path: string): Promise<Backlink[] | null>;
  /** Short previews for a batch of note paths; `null` for missing or unreadable notes. */
  getPreviews(paths: string[]): Promise<(NotePreview | null)[]>;
  /**
   * Atomically replaces the note's text, only if the disk still holds `base`: the text
   * `readNote` returned or the last one written. `null` creates the note (and its folders),
   * only if there is none. `content` is written as is, BOM and line endings included.
   */
  writeNote(path: string, content: string, base: string | null): Promise<WriteResult>;
  /**
   * Renames a note and rewrites the links that would stop leading where they did. Each
   * rewritten note, the renamed one apart, is reported `changed`. Rejects, with the vault
   * untouched, if `to` is taken or cannot be a note name.
   */
  renameNote(from: string, to: string): Promise<RenameResult>;
  /**
   * Renames a folder with everything in it, in one batch, and rewrites the links that
   * would stop leading where they did, with the rules of `renameNote`. Rejects, with the
   * vault untouched, if `to` is taken, inside `from` or cannot be a folder name.
   */
  renameFolder(from: string, to: string): Promise<FolderRenameResult>;
  /**
   * Creates the folder at `path`, inside a folder that exists. It is reported `created`
   * before the call resolves. Rejects, with the vault untouched, if anything is there or
   * the name cannot be used.
   */
  createFolder(path: string): Promise<void>;
  /** What deleting the note or folder at `path` would take, for the confirmation. */
  deleteInfo(path: string, kind: TreeEntry['kind']): Promise<DeleteInfo>;
  /**
   * Moves the note or folder at `path` to the Recycle Bin, never deleting for good. Its
   * events are sent before the call settles. Resolves with the notes that are in the bin.
   * Rejects if it cannot be moved; of a folder, part may be there by then, and the events
   * say what is left.
   */
  deleteItem(path: string, kind: TreeEntry['kind']): Promise<string[]>;
  /**
   * Does the close or reload that the page held back (`beforeunload`) to save first. The
   * page cannot tell which one it was.
   */
  resumeUnload(): Promise<void>;
  /** Every note and the links between them. `null` while the vault is first indexed. */
  getGraph(): Promise<GraphSnapshot | null>;
  /**
   * What changed since the last `getGraph` or `getGraphChanges`. `null` if there is
   * nothing to compare with: ask `getGraph` again.
   */
  getGraphChanges(): Promise<GraphDelta | null>;
  /**
   * Saves where the graph put these notes (`[x0, y0, ...]`), to start there next time.
   * Paths the index does not have are ignored. A rename takes its positions along.
   */
  saveGraphPositions(paths: string[], positions: Float32Array): Promise<void>;
  /**
   * Saves which communities these notes are in: `levels[l][i]` is that of `paths[i]` at
   * level `l`. Paths the index does not have are ignored. A rename takes them along.
   */
  saveGraphCommunities(paths: string[], levels: Uint32Array[]): Promise<void>;
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
  /** Notes or links may have changed in the index. Returns the unsubscribe function. */
  onGraphChange(listener: () => void): () => void;
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
  reopenVault: 'vault:reopen',
  getTree: 'vault:tree',
  listNotes: 'note:list',
  readNote: 'note:read',
  getPreviews: 'note:previews',
  getBacklinks: 'note:backlinks',
  writeNote: 'note:write',
  renameNote: 'note:rename',
  renameFolder: 'folder:rename',
  createFolder: 'folder:create',
  deleteInfo: 'item:delete-info',
  deleteItem: 'item:delete',
  search: 'brain:search',
  getGraph: 'graph:get',
  getGraphChanges: 'graph:changes',
  saveGraphPositions: 'graph:save-positions',
  saveGraphCommunities: 'graph:save-communities',
  resumeUnload: 'window:resume-unload',
} as const satisfies Record<CallName, string>;

/** Push channels, main -> renderer, with their payloads. */
export interface EventPayloads {
  'vault:events': VaultEvent[];
  'vault:indexing': boolean;
  'graph:changed': null;
}

export const EVENT_CHANNELS = {
  vaultEvents: 'vault:events',
  indexing: 'vault:indexing',
  graphChange: 'graph:changed',
} as const satisfies Record<string, keyof EventPayloads>;
