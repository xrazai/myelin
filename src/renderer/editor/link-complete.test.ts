import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import { EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { expect, test, vi } from 'vitest';
import { createLinkResolver } from '../../shared/links';
import { watchNoteList } from '../note-list';
import { markdownSupport } from './cm-editor';
import { linkCompletionSource, linkTarget } from './link-complete';
import { notePath } from './note-path';

const PATHS = [
  'Home.md',
  'Reflexão sobre ótica.md',
  'Ideias/Plano.md',
  'Projetos/Plano.md',
  'Projetos/Antigos/Plano.md',
  'C# notes.md',
];

const OTHER = '---\ntitle: x\n---\n# Introdução\n\n```\n# not a heading\n```\n\nSetext\n------\n\n## Método ##\n## Método\n## [[Link]]\n';

async function setup(text: string, paths = PATHS) {
  const notes = watchNoteList({ listNotes: async () => paths, onVaultEvents: () => () => {} });
  await notes.ready;
  const readText = vi.fn(async () => OTHER);
  const source = linkCompletionSource({ notes, readText });
  const cursor = text.indexOf('‸');
  let state = EditorState.create({
    doc: text.replace('‸', ''),
    selection: { anchor: cursor },
    extensions: [markdownSupport, notePath.of('Home.md')],
  });
  const complete = async () => (await source(new CompletionContext(state, cursor, false))) as CompletionResult | null;
  const view = {
    get state() {
      return state;
    },
    dispatch: (spec: TransactionSpec) => void (state = state.update(spec).state),
  } as unknown as EditorView;
  /** Accepts an option; the result shows the cursor as `‸`. */
  async function accept(label: string, detail?: string) {
    const result = (await complete())!;
    const option = result.options.find((o) => o.label === label && (!detail || o.detail === detail))!;
    (option.apply as (view: EditorView, completion: Completion, from: number, to: number) => void)(
      view, option, result.from, cursor,
    );
    const doc = state.doc.toString();
    const at = state.selection.main.head;
    return `${doc.slice(0, at)}‸${doc.slice(at)}`;
  }
  const labels = async () => (await complete())?.options.map((o) => [o.label, o.detail]) ?? null;
  return { complete, accept, labels, readText };
}

test('opens after [[, matching names without case or accents, folder only for duplicates', async () => {
  const { labels } = await setup('see [[‸');
  // `C# notes` cannot be written as a link.
  expect(await labels()).toEqual([
    ['Home', undefined],
    ['Plano', 'Ideias/'],
    ['Plano', 'Projetos/Antigos/'],
    ['Plano', 'Projetos/'],
    ['Reflexão sobre ótica', undefined],
  ]);
  expect(await (await setup('[[REFLEXAO‸')).labels()).toEqual([['Reflexão sobre ótica', undefined]]);
  expect(await (await setup('[[rfxot‸')).labels()).toEqual([['Reflexão sobre ótica', undefined]]);
  expect(await (await setup('[[otica‸')).labels()).toEqual([['Reflexão sobre ótica', undefined]]);
  expect(await (await setup('[[antigos/pla‸')).labels()).toEqual([['Plano', 'Projetos/Antigos/']]);
  expect(await (await setup('[[zzz‸')).labels()).toBeNull();
});

test.each([
  'no link [Home‸',
  '`[[‸`',
  '```\n[[‸\n```',
  '\\[[‸',
  '[[Home|ali‸',
  '[[Home]] ‸',
  '[[Home#^blo‸',
  '[[Missing#‸',
])('stays closed in %j', async (text) => {
  expect(await (await setup(text)).complete()).toBeNull();
});

test('inserts the shortest target that leads to the chosen note, and closes the link', async () => {
  expect(await (await setup('a [[pla‸ b')).accept('Plano', 'Ideias/')).toBe('a [[Plano]]‸ b');
  expect(await (await setup('[[pla‸')).accept('Plano', 'Projetos/')).toBe('[[Projetos/Plano]]‸');
  expect(await (await setup('[[pla‸')).accept('Plano', 'Projetos/Antigos/')).toBe('[[Antigos/Plano]]‸');
});

test('every target it can insert resolves back to its note', () => {
  const paths = ['a/b/X.md', 'b/X.md', 'z/a/b/X.md', 'X y/X.md'];
  const resolve = createLinkResolver(paths);
  for (const path of paths) {
    expect(resolve(linkTarget(path, 'Home.md', resolve)!, 'Home.md').path).toBe(path);
  }
});

test('inside a link already written, replaces the rest of the name and keeps what follows', async () => {
  expect(await (await setup('[[Ho‸me]] x')).accept('Home')).toBe('[[Home]]‸ x');
  expect(await (await setup('[[Ho‸|start]]')).accept('Home')).toBe('[[Home‸|start]]');
  expect(await (await setup('[[Ho‸me#Top]]')).accept('Home')).toBe('[[Home‸#Top]]');
  expect(await (await setup('| [[Ho‸\\|a]] |')).accept('Home')).toBe('| [[Home‸\\|a]] |');
  // Another link further on the line is left alone.
  expect(await (await setup('[[Ho‸ then [[Home]]')).accept('Home')).toBe('[[Home]]‸ then [[Home]]');
});

test('after Note# completes its headings, reading only that note', async () => {
  const { labels, accept, readText } = await setup('[[Plano#‸');
  expect(await labels()).toEqual([
    ['Introdução', 'H1'],
    ['Setext', 'H2'],
    ['Método', 'H2'],
  ]);
  expect(readText).toHaveBeenCalledWith('Ideias/Plano.md');
  expect(await accept('Método')).toBe('[[Plano#Método]]‸');
  expect(await (await setup('[[Plano#intro‸]]')).accept('Introdução')).toBe('[[Plano#Introdução]]‸');
});

test('headings of the note itself come from the editor', async () => {
  for (const text of ['# Top\n\n## Other part\n\n[[#oth‸', '# Top\n\n## Other part\n\n[[Home#oth‸']) {
    const { labels, readText } = await setup(text);
    expect(await labels()).toEqual([['Other part', 'H2']]);
    expect(readText).not.toHaveBeenCalled();
  }
});
