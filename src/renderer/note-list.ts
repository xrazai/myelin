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
  stop(): void;
}

export function watchNoteList(api: Pick<MyelinApi, 'listNotes' | 'onVaultEvents'>): NoteList {
  const paths = new Set<string>();
  /** Events that arrived before the list: it may or may not have them already. */
  let early: VaultEvent[] | null = [];
  // Built when first needed after a change: both take a while on a large vault.
  let resolver: LinkResolver | null = null;
  let search: NoteSearch | null = null;

  function apply(events: VaultEvent[]): void {
    for (const event of events) {
      // A deleted or created folder also reports each of its notes.
      if (event.type === 'changed' || event.kind !== 'note') continue;
      if (event.type === 'created') {
        if (paths.has(event.path)) continue;
        paths.add(event.path);
      } else if (!paths.delete(event.path)) continue;
      resolver = search = null;
    }
  }

  // Subscribed before asking, so that nothing falls between the two.
  const unsubscribe = api.onVaultEvents((events) => {
    if (early) early.push(...events);
    else apply(events);
  });

  const ready = api.listNotes().then((list) => {
    for (const path of list) paths.add(path);
    apply(early!);
    early = null;
    resolver = search = null;
  });
  ready.catch((error: unknown) => console.error('[note-list] listing the notes failed:', error));

  return {
    ready,
    isLoaded: () => early === null,
    resolve: (target, source) => (resolver ??= createLinkResolver(paths))(target, source),
    search: (query, limit) => (search ??= createNoteSearch(paths))(query, limit),
    stop: unsubscribe,
  };
}
