// Bounded LRU cache of short note previews for hover tooltips.
// Never holds full note texts; invalidated by `vault:events`.
import type { MyelinApi, NotePreview, VaultEvent } from '../shared/ipc';

export const DEFAULT_CACHE_SIZE = 500;

export interface NoteCache {
  /** Synchronous O(1) lookup. Returns `undefined` on a cache miss, `null` for a known missing note. */
  peek(path: string): NotePreview | null | undefined;
  /** Fetches a single preview on a cold miss (or returns the cached/in-flight one). */
  fetch(path: string): Promise<NotePreview | null>;
  /** Batched prefetch for paths not yet cached or in-flight. */
  prefetch(paths: readonly string[]): Promise<void>;
  /** Current number of entries in the cache. */
  size(): number;
  stop(): void;
}

export function createNoteCache(
  api: Pick<MyelinApi, 'getPreviews' | 'onVaultEvents'>,
  maxEntries = DEFAULT_CACHE_SIZE,
): NoteCache {
  const cache = new Map<string, NotePreview | null>();
  const inflight = new Map<string, Promise<NotePreview | null>>();

  function touch(path: string, value: NotePreview | null): NotePreview | null {
    cache.delete(path);
    cache.set(path, value);
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return value;
  }

  function applyEvents(events: VaultEvent[]): void {
    for (const event of events) {
      if (event.type === 'changed') {
        cache.delete(event.path);
      } else if (event.kind === 'note') {
        // `deleted` removes stale previews; `created` clears cached `null` misses.
        cache.delete(event.path);
      }
    }
  }

  const unsubscribe = api.onVaultEvents(applyEvents);

  async function prefetch(paths: readonly string[]): Promise<void> {
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      if (seen.has(path) || cache.has(path) || inflight.has(path)) continue;
      seen.add(path);
      missing.push(path);
    }
    if (missing.length === 0) return;

    const batch = api.getPreviews(missing).catch(() => missing.map(() => null));
    for (let i = 0; i < missing.length; i++) {
      const path = missing[i];
      const promise = batch.then((results) => {
        const preview = results[i] ?? null;
        touch(path, preview);
        return preview;
      }).finally(() => {
        inflight.delete(path);
      });
      inflight.set(path, promise);
    }
    await batch;
  }

  async function fetch(path: string): Promise<NotePreview | null> {
    if (cache.has(path)) return touch(path, cache.get(path)!);
    const pending = inflight.get(path);
    if (pending) return pending;
    await prefetch([path]);
    return cache.get(path) ?? null;
  }

  return {
    peek(path) {
      if (!cache.has(path)) return undefined;
      return touch(path, cache.get(path)!);
    },
    fetch,
    prefetch,
    size: () => cache.size,
    stop: unsubscribe,
  };
}
