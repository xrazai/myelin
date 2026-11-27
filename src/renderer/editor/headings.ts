// The headings of a note, for `[[Note#` completion. Parsed as Markdown, so a `#` line
// inside a code block is not one.
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { Tree } from '@lezer/common';

export interface Heading {
  level: number;
  /** As written, without the `#` marks or the underline. */
  text: string;
}

/** YAML at the top would otherwise read as text under a `---` underline. */
const FRONTMATTER = /^---[ \t]*\n(?:[\s\S]*?\n)?---[ \t]*(?:\n|$)/;

export const frontmatterLength = (text: string) => FRONTMATTER.exec(text)?.[0].length ?? 0;

/**
 * `tree` is the parse of the note and `slice` reads its text. What starts before `after`
 * is left out.
 */
export function headingsIn(tree: Tree, slice: (from: number, to: number) => string, after = 0): Heading[] {
  const headings: Heading[] = [];
  tree.iterate({
    enter(node) {
      const match = /^(?:ATX|Setext)Heading(\d)$/.exec(node.name);
      if (!match) return;
      if (node.from < after) return false;
      let from = node.from;
      let to = node.to;
      for (const mark of node.node.getChildren('HeaderMark')) {
        if (mark.from === from) from = mark.to;
        else to = Math.min(to, mark.from);
      }
      const text = slice(from, to).replace(/\s+/g, ' ').trim();
      if (text) headings.push({ level: Number(match[1]), text });
      return false;
    },
  });
  return headings;
}

/** The headings of a note's text as `readNote` or the editor have it. */
export function noteHeadings(raw: string): Heading[] {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  return headingsIn(
    markdownLanguage.parser.parse(text),
    (from, to) => text.slice(from, to),
    frontmatterLength(text),
  );
}
