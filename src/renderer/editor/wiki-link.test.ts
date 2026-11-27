import { parser as commonmark, GFM } from '@lezer/markdown';
import { expect, test } from 'vitest';
import { parseLinks } from '../../shared/links';
import { shownRange, wikiLink } from './wiki-link';

const parser = commonmark.configure([GFM, wikiLink]);

function wikiLinks(text: string): string[] {
  const found: string[] = [];
  parser.parse(text).iterate({
    enter: (node) => {
      if (node.name === 'WikiLink') found.push(text.slice(node.from, node.to));
    },
  });
  return found;
}

const SAMPLES = [
  '[[Note]] and [[folder/Note|an alias]] and [[Note#Heading]] and [[Note#^block]]',
  '[[#Heading]] [[ spaced | name ]] [[a|]] [[]] [[ ]] [[|x]]',
  '[[[Note]]] [[a[b]] [Note] [[unclosed',
  '`[[code]]` ``a ` [[code]]`` ` [[after a lone backtick]]',
  '\\[[escaped]] \\`[[not code]]`',
  '```\n[[fenced]]\n```\n\n    [[indented]]\n\n[[after]]',
  '# Title [[in heading]]\n\n> [[quoted]]\n\n- [[item]]\n- [ ] [[task]]',
  '**[[bold]]** *[[italic]]* [text [[inside]]](https://example.com)',
  '| a |\n|---|\n| [[Note\\|alias]] |',
  'line one [[a]]\nline two [[b\nsplit]] [[c]]',
];

test.each(SAMPLES)('finds the same links as the shared parser: %j', (text) => {
  expect(wikiLinks(text)).toEqual(parseLinks(text).map((link) => text.slice(link.from, link.to)));
});

test.each([
  ['Note', 'Note'],
  [' folder/Note#Heading ', 'folder/Note#Heading'],
  ['Note|the alias ', 'the alias'],
  ['Note\\|alias', 'alias'],
  ['Note|', 'Note'],
  ['Note\\|', 'Note'],
])('the reader sees the right part of [[%s]]', (inner, shown) => {
  expect(inner.slice(...shownRange(inner))).toBe(shown);
});
