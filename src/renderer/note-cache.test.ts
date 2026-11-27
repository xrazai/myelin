import { describe, expect, test, vi } from 'vitest';
import type { MyelinApi, NotePreview, VaultEvent } from '../shared/ipc';
import { createNoteCache } from './note-cache';

function mockApi(previews: Record<string, NotePreview | null> = {}) {
  let listener: ((events: VaultEvent[]) => void) | null = null;
  const getPreviews = vi.fn(async (paths: string[]) => paths.map((p) => previews[p] ?? null));
  const onVaultEvents = vi.fn((fn: (events: VaultEvent[]) => void) => {
    listener = fn;
    return () => {
      listener = null;
    };
  });
  return {
    api: { getPreviews, onVaultEvents } as Pick<MyelinApi, 'getPreviews' | 'onVaultEvents'>,
    getPreviews,
    emit: (events: VaultEvent[]) => listener?.(events),
  };
}

describe('createNoteCache', () => {
  test('prefetches missing paths in one batch and serves warm peeks synchronously', async () => {
    const { api, getPreviews } = mockApi({
      'A.md': { path: 'A.md', title: 'A', excerpt: 'Alpha' },
      'B.md': { path: 'B.md', title: 'B', excerpt: 'Beta' },
    });
    const cache = createNoteCache(api);

    expect(cache.peek('A.md')).toBeUndefined();
    await cache.prefetch(['A.md', 'B.md', 'A.md', 'Missing.md']);

    expect(getPreviews).toHaveBeenCalledTimes(1);
    expect(getPreviews).toHaveBeenCalledWith(['A.md', 'B.md', 'Missing.md']);
    expect(cache.peek('A.md')).toEqual({ path: 'A.md', title: 'A', excerpt: 'Alpha' });
    expect(cache.peek('Missing.md')).toBeNull();

    // Second prefetch for already-cached paths does not hit IPC.
    await cache.prefetch(['A.md', 'B.md', 'Missing.md']);
    expect(getPreviews).toHaveBeenCalledTimes(1);
    cache.stop();
  });

  test('evicts least recently used entries when exceeding maxEntries', async () => {
    const { api } = mockApi({
      '1.md': { path: '1.md', title: '1', excerpt: 'one' },
      '2.md': { path: '2.md', title: '2', excerpt: 'two' },
      '3.md': { path: '3.md', title: '3', excerpt: 'three' },
    });
    const cache = createNoteCache(api, 2);

    await cache.prefetch(['1.md', '2.md']);
    // Touch 1.md so 2.md becomes LRU.
    expect(cache.peek('1.md')?.title).toBe('1');

    await cache.fetch('3.md');
    expect(cache.size()).toBe(2);
    expect(cache.peek('1.md')).toBeDefined();
    expect(cache.peek('3.md')).toBeDefined();
    expect(cache.peek('2.md')).toBeUndefined();
    cache.stop();
  });

  test('invalidates on changed, deleted, and created note events', async () => {
    const { api, emit } = mockApi({
      'A.md': { path: 'A.md', title: 'A', excerpt: 'old' },
      'B.md': { path: 'B.md', title: 'B', excerpt: 'bee' },
    });
    const cache = createNoteCache(api);

    await cache.prefetch(['A.md', 'B.md', 'New.md']);
    expect(cache.peek('New.md')).toBeNull();

    emit([
      { type: 'changed', path: 'A.md' },
      { type: 'deleted', kind: 'note', path: 'B.md' },
      { type: 'created', kind: 'note', path: 'New.md' },
    ]);

    expect(cache.peek('A.md')).toBeUndefined();
    expect(cache.peek('B.md')).toBeUndefined();
    expect(cache.peek('New.md')).toBeUndefined();
    cache.stop();
  });
});
