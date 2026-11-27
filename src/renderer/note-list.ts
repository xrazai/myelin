// The path of every note of the open vault, kept up to date by the watcher's events (the
// app's own new notes arrive as `created` too). No content. Plain TS.
import type { MyelinApi, VaultEvent } from '../shared/ipc';
import { createLinkResolver, type LinkResolver } from '../shared/links';
import { createNoteSearch, type NoteSearch } from './note-search';

export interface NoteList {
  /** Settles when the list is loaded. Rejects if it cannot be. */
  ready: Promise<void>;
  isLoaded(): boolean;
  /** The one resolution rule (`shared/links.ts`) over the notes now in the list. */
  resolve: LinkResolver;
  search: NoteSearch;
  has(path: string): boolean;
  /**
   * The folder of a note that `path` writes in another case, or `null`. Windows would put
   * the new note in it, under a path the app does not know.
   */
  folderInOtherCase(path: string): string | null;
  stop(): void;
}

export function watchNoteList(api: Pick<MyelinApi, 'listNotes' | 'onVaultEvents'>): NoteList {
  const paths = new Set<string>();
  const lowerCounts = new Map<string, number>();
  /** Events that arrived before the list: it may or may not have them already. */
  let early: VaultEvent[] | null = [];
  // Built when first needed after a change: both take a while on a large vault.
  let resolver: LinkResolver | null = null;
  let search: NoteSearch | null = null;
  let folders: { exact: Set<string>; lower: Map<string, string> } | null = null;

  function readFolders() {
    const exact = new Set<string>();
    const lower = new Map<string, string>();
    for (const path of paths) {
      // Innermost first: a folder already seen brought its parents.
      for (let end = path.lastIndexOf('/'); end > 0; end = path.lastIndexOf('/', end - 1)) {
        const folder = path.slice(0, end);
        if (exact.has(folder)) break;
        exact.add(folder);
        lower.set(folder.toLowerCase(), folder);
      }
    }
    return { exact, lower };
  }

  function folderInOtherCase(path: string): string | null {
    const { exact, lower } = (folders ??= readFolders());
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const folder = segments.slice(0, depth).join('/');
      if (!exact.has(folder)) return lower.get(folder.toLowerCase()) ?? null;
    }
    return null;
  }

  function addPath(path: string): boolean {
    if (paths.has(path)) return false;
    paths.add(path);
    const lower = path.toLowerCase();
    lowerCounts.set(lower, (lowerCounts.get(lower) ?? 0) + 1);
    return true;
  }

  function removePath(path: string): boolean {
    if (!paths.delete(path)) return false;
    const lower = path.toLowerCase();
    const count = (lowerCounts.get(lower) ?? 0) - 1;
    if (count <= 0) lowerCounts.delete(lower);
    else lowerCounts.set(lower, count);
    return true;
  }

  function apply(events: VaultEvent[]): void {
    for (const event of events) {
      // A deleted or created folder also reports each of its notes.
      if (event.type === 'changed' || event.kind !== 'note') continue;
      if (event.type === 'created') {
        if (!addPath(event.path)) continue;
      } else if (!removePath(event.path)) continue;
      resolver = search = folders = null;
    }
  }

  // Subscribed before asking, so that nothing falls between the two.
  const unsubscribe = api.onVaultEvents((events) => {
    if (early) early.push(...events);
    else apply(events);
  });

  const ready = api.listNotes().then((list) => {
    for (const path of list) addPath(path);
    apply(early!);
    early = null;
    resolver = search = folders = null;
  });
  ready.catch((error: unknown) => console.error('[note-list] listing the notes failed:', error));

  return {
    ready,
    isLoaded: () => early === null,
    resolve: (target, source) => (resolver ??= createLinkResolver(paths))(target, source),
    search: (query, limit, recent) => (search ??= createNoteSearch(paths))(query, limit, recent),
    has: (path) => (lowerCounts.get(path.toLowerCase()) ?? 0) > 0,
    folderInOtherCase,
    stop: unsubscribe,
  };
}
