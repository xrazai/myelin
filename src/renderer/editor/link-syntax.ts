// What the editor needs to know about `[[links]]` around a position. The grammar is the one
// of `shared/links.ts`; the syntax tree only says what is code.
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { matchLink, type ParsedLink } from '../../shared/links';

const CODE = new Set(['InlineCode', 'FencedCode', 'CodeBlock']);

/** `true` if a `[[` written at `at` opens a link: not in code and not escaped (`\[[`). */
export function opensLink(state: EditorState, at: number): boolean {
  const line = state.doc.lineAt(at);
  let backslashes = 0;
  while (line.text[at - line.from - 1 - backslashes] === '\\') backslashes++;
  if (backslashes % 2 === 1) return false;
  for (let node = syntaxTree(state).resolveInner(at, 1); node.parent; node = node.parent) {
    if (CODE.has(node.name)) return false;
  }
  return true;
}

/**
 * The link around `pos`, with offsets in the note, or `null`. It reads the line, not the
 * `WikiLink` node: in a GFM table `[[a|b]]` has none, and it is a link all the same.
 * `edges`: also at the very start or end of the link.
 */
export function linkAt(state: EditorState, pos: number, edges: boolean): ParsedLink | null {
  const line = state.doc.lineAt(pos);
  const at = pos - line.from;
  let touching: ParsedLink | null = null;
  for (let from = line.text.indexOf('[['); from !== -1 && from <= at; from = line.text.indexOf('[[', from + 1)) {
    const match = matchLink(line.text, from);
    if (!match?.link || at > match.end || !opensLink(state, line.from + from)) continue;
    const { link } = match;
    const found = {
      ...link,
      from: line.from + link.from,
      to: line.from + link.to,
      targetFrom: line.from + link.targetFrom,
      targetTo: line.from + link.targetTo,
    };
    if (at > from && at < match.end) return found;
    // Between two links, the one that starts here wins.
    if (edges) touching = found;
  }
  return touching;
}
