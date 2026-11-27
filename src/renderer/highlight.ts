// An excerpt cut at its match ranges, for highlighting without HTML strings. Plain TS.

export interface Part {
  text: string;
  match: boolean;
}

/** `matches`: sorted `[from, to)` ranges that do not overlap. */
export function highlightParts(text: string, matches: readonly (readonly [number, number])[]): Part[] {
  const parts: Part[] = [];
  let done = 0;
  for (const [from, to] of matches) {
    if (from > done) parts.push({ text: text.slice(done, from), match: false });
    parts.push({ text: text.slice(from, to), match: true });
    done = to;
  }
  if (done < text.length) parts.push({ text: text.slice(done), match: false });
  return parts;
}
