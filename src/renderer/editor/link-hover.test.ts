import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { describe, expect, test } from 'vitest';
import { createLinkResolver } from '../../shared/links';
import { markdownSupport } from './cm-editor';
import { visibleLinkPaths } from './link-hover';
import { notePath } from './note-path';

function mockView(doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [markdownSupport, notePath.of('Home.md')],
  });
  return {
    state,
    visibleRanges: [{ from: 0, to: state.doc.length }],
  } as unknown as EditorView;
}

describe('visibleLinkPaths', () => {
  test('collects and deduplicates resolved links in visibleRanges', () => {
    const view = mockView('See [[Alpha]], [[Beta]], [[Alpha]], and [[Missing]].');
    const notes = {
      ready: Promise.resolve(),
      isLoaded: () => true,
      resolve: createLinkResolver(['Alpha.md', 'Beta.md']),
    };
    expect(visibleLinkPaths(view, notes)).toEqual(['Alpha.md', 'Beta.md']);
  });

  test('ignores code blocks and escaped links', () => {
    const view = mockView('[[Alpha]] `[[Beta]]` \\[[Beta]]');
    const notes = {
      ready: Promise.resolve(),
      isLoaded: () => true,
      resolve: createLinkResolver(['Alpha.md', 'Beta.md']),
    };
    expect(visibleLinkPaths(view, notes)).toEqual(['Alpha.md']);
  });

  test('defers prefetch until notes.ready resolves and cancels if destroyed', async () => {
    let resolveReady!: () => void;
    let loaded = false;
    const ready = new Promise<void>((resolve) => {
      resolveReady = () => {
        loaded = true;
        resolve();
      };
    });
    const resolver = createLinkResolver(['Alpha.md']);
    const notes = { ready, isLoaded: () => loaded, resolve: resolver };

    let prefetched: string[] = [];
    const cache = {
      peek: () => undefined,
      fetch: async () => null,
      prefetch: async (paths: readonly string[]) => {
        prefetched.push(...paths);
      },
      invalidate: () => {},
      size: () => 0,
      stop: () => {},
    };

    const { linkHover } = await import('./link-hover');
    const ext = linkHover({ notes, cache });
    expect(ext).toBeDefined();

    // Simulate deferred ready resolution.
    resolveReady();
    await ready;
    expect(loaded).toBe(true);
    expect(prefetched).toEqual([]);
  });
});
