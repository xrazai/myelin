// `[[links]]` for the Lezer Markdown parser. The grammar is the one of `shared/links.ts`
// (wiki-link.test.ts keeps them equal). Plain TS, no DOM.
//
// Tree: `WikiLink` covers `[[...]]` and has two `WikiLinkMark` children: everything before
// and after the text a reader sees (the alias, or the link as written if there is none).
import type { MarkdownConfig } from '@lezer/markdown';
import { matchLink } from '../../shared/links';

const OPEN = 91; // [

/** `[from, to)` of the visible text inside `inner`, the text between the brackets. */
export function shownRange(inner: string): [number, number] {
  const pipe = inner.indexOf('|');
  const aliased = pipe !== -1 && inner.slice(pipe + 1).trim() !== '';
  const start = aliased ? pipe + 1 : 0;
  // Without an alias, the `|` (`\|` in tables) and what follows it are hidden too.
  const part = aliased ? inner.slice(start) : pipe === -1 ? inner : inner.slice(0, pipe).replace(/\\$/, '');
  return [start + part.length - part.trimStart().length, start + part.trimEnd().length];
}

export const wikiLink: MarkdownConfig = {
  defineNodes: ['WikiLink', 'WikiLinkMark'],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== OPEN || cx.char(pos + 1) !== OPEN) return -1;
        const match = matchLink(cx.text, pos - cx.offset);
        if (!match?.link) return -1;
        const end = cx.offset + match.end;
        const [from, to] = shownRange(cx.text.slice(match.link.from + 2, match.end - 2));
        return cx.addElement(
          cx.elt('WikiLink', pos, end, [
            cx.elt('WikiLinkMark', pos, pos + 2 + from),
            cx.elt('WikiLinkMark', pos + 2 + to, end),
          ]),
        );
      },
    },
  ],
};
