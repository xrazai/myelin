// Where a search card's excerpt is in the note on screen. The excerpt has line breaks as
// spaces and may be cut with `…`, so whitespace is matched loosely. Plain TS.
import type { SearchCard } from '../shared/ipc';

/** How much text after the first match has to agree with it. */
const CONTEXT = 40;

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

/** The offset in `text` of the first match the card shows, or `0` if it cannot be found. */
export function locateExcerpt(text: string, { excerpt, matches }: Pick<SearchCard, 'excerpt' | 'matches'>): number {
  const first = matches[0];
  if (!first) return 0;
  const [from, to] = first;
  const word = excerpt.slice(from, to);
  const after = excerpt.slice(from, from + CONTEXT).replace(/…$/, '');
  // The match with what follows it; the note may have changed, so then the word alone.
  for (const wanted of [after, word]) {
    const found = new RegExp(literal(wanted), 'u').exec(text);
    if (found) return found.index;
  }
  return 0;
}
