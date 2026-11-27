// Runs on states only, without a DOM.
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { expect, test } from 'vitest';
import { markdownSupport } from './cm-editor';
import { livePreviewDecorations } from './live-preview';

function run(doc: string, selection = EditorSelection.single(doc.length), ranges = [{ from: 0, to: doc.length }]) {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [markdownSupport, EditorState.allowMultipleSelections.of(true)],
  });
  expect(ensureSyntaxTree(state, doc.length, 5000)).not.toBeNull();
  const hidden: [number, number][] = [];
  const styled: [string, string][] = [];
  livePreviewDecorations(state, ranges).between(0, doc.length, (from, to, decoration) => {
    const name = (decoration.spec as { class?: string }).class;
    if (name === undefined) hidden.push([from, to]);
    else styled.push([name, doc.slice(from, to)]);
  });
  /** The text as it reads on screen. */
  const shown = hidden.reduceRight((text, [from, to]) => text.slice(0, from) + text.slice(to), doc);
  return { shown, styled };
}

/** An empty last line for the cursor, away from everything. */
const away = (text: string) => `${text}\n\nend`;

test.each([
  ['# Title', 'Title'],
  ['### Title ###', 'Title'],
  ['> ## Quoted', '> Quoted'],
  ['**bold** and _italic_ and *more*', 'bold and italic and more'],
  ['~~gone~~ and `code`', 'gone and code'],
  ['[[Note]] [[folder/Note|alias]] [[Note#Heading]]', 'Note alias Note#Heading'],
  ['[text](https://example.com "Title")', 'text'],
])('hides the syntax of %j away from the cursor', (source, shown) => {
  expect(run(away(source)).shown).toBe(away(shown));
});

test.each([
  '- item\n- [ ] task\n1. one',
  '```js\n**not bold** [[not a link]]\n```',
  '[reference][label] ![image](a.png) [](https://example.com)',
  'Title\n=====',
  '---',
])('keeps what it cannot hide in %j', (source) => {
  expect(run(away(source)).shown).toBe(away(source));
});

test('inline code loses its backticks and keeps what looks like a link', () => {
  expect(run(away('`[[code]]`')).shown).toBe(away('[[code]]'));
});

test('shows the raw syntax only on the line of the cursor', () => {
  const doc = '# One\n**two** [[Three]]\n**four**';
  const { shown, styled } = run(doc, EditorSelection.single(8));
  expect(shown).toBe('One\n**two** [[Three]]\nfour');
  expect(styled).toContainEqual(['cm-md-syntax', '**']);
  expect(styled).toContainEqual(['cm-md-syntax', '[[']);
});

test('a selection shows the syntax of every line it touches, and so does each cursor', () => {
  const doc = '# a\n# b\n# c\n# d\n# e';
  expect(run(doc, EditorSelection.single(2, 9)).shown).toBe('# a\n# b\n# c\nd\ne');
  const cursors = EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(doc.length)]);
  expect(run(doc, cursors).shown).toBe('# a\nb\nc\nd\n# e');
});

test('styles headings, emphasis and links on every line', () => {
  const { styled } = run('## T **b** *i* [[n]]');
  expect(styled).toContainEqual(['cm-md-heading cm-md-h2', '## T **b** *i* [[n]]']);
  expect(styled).toContainEqual(['cm-md-strong', '**b**']);
  expect(styled).toContainEqual(['cm-md-em', '*i*']);
  expect(styled).toContainEqual(['cm-md-wikilink', '[[n]]']);
});

test('decorates only the given ranges, and a node that spans two of them once', () => {
  const doc = away('**a**\n\n```\none\n\ntwo\n```\n\n**b**');
  const middle = doc.indexOf('one');
  const { styled } = run(doc, EditorSelection.single(doc.length), [
    { from: middle, to: middle + 3 },
    { from: doc.indexOf('two'), to: doc.indexOf('two') + 3 },
  ]);
  expect(styled.filter(([name]) => name === 'cm-md-code')).toHaveLength(1);
  expect(styled.some(([name]) => name === 'cm-md-strong')).toBe(false);
});

test('styles research Markdown constructs: blockquotes, code blocks, inline code, headings, hr and tasks', () => {
  const doc = away(
    '# Heading\n\n> Quoted claim\n\nUse `inline` here.\n\n```ts\nconst x = 1;\n```\n\n---\n\n- [ ] open\n- [x] done',
  );
  const { styled } = run(doc);
  expect(styled).toContainEqual(['cm-md-heading-line cm-md-h1-line', '']);
  expect(styled).toContainEqual(['cm-md-quote', '> Quoted claim']);
  expect(styled).toContainEqual(['cm-md-quote-line', '']);
  expect(styled).toContainEqual(['cm-md-code cm-md-inline-code', '`inline`']);
  expect(styled).toContainEqual(['cm-md-codeblock-line', '']);
  expect(styled).toContainEqual(['cm-md-codeblock-first', '']);
  expect(styled).toContainEqual(['cm-md-codeblock-last', '']);
  expect(styled).toContainEqual(['cm-md-hr', '---']);
  expect(styled).toContainEqual(['cm-md-hr-line', '']);
  expect(styled).toContainEqual(['cm-md-task', '[ ]']);
  expect(styled).toContainEqual(['cm-md-task cm-md-task-done', '[x]']);
});
