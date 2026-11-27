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
      isLoaded: () => true,
      resolve: createLinkResolver(['Alpha.md', 'Beta.md']),
    };
    expect(visibleLinkPaths(view, notes)).toEqual(['Alpha.md', 'Beta.md']);
  });

  test('ignores code blocks and escaped links', () => {
    const view = mockView('[[Alpha]] `[[Beta]]` \\[[Beta]]');
    const notes = {
      isLoaded: () => true,
      resolve: createLinkResolver(['Alpha.md', 'Beta.md']),
    };
    expect(visibleLinkPaths(view, notes)).toEqual(['Alpha.md']);
  });
});
