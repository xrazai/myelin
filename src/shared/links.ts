// `[[links]]`: the one parser and the one resolution rule, shared by the index, the editor,
// rename and the graph. The syntax is a subset of Obsidian's:
//   [[Note]]  [[folder/Note]]  [[Note|alias]]  [[Note#Heading]]  [[Note#^block]]
// Links inside code spans and code blocks are not links. Heading and block parts are kept
// as text (`subpath`) and not resolved yet.
// Pure TypeScript: no `node:*`, DOM or dependencies (compiled for worker and renderer).

export interface ParsedLink {
  /** `[from, to)` covers the whole `[[...]]`. Offsets are UTF-16 units of the parsed text. */
  from: number;
  to: number;
  /** `[targetFrom, targetTo)` covers only `target`: what a rename rewrites. */
  targetFrom: number;
  targetTo: number;
  /** Note part as written (`Note`, `folder/Note`). Empty means the note itself (`[[#Heading]]`). */
  target: string;
  /** `#Heading` or `#^block`, `#` included; empty if absent. */
  subpath: string;
  alias: string | null;
}

/** A link of one note, as the index stores it. */
export type NoteLink = ParsedLink & {
  /** Path of the note that contains the link. */
  source: string;
} & Resolution;

/**
 * `path`: the note the link points to. `null`: no such note yet (a "create note" target),
 * named `name`; links to the same missing note have the same `key`.
 */
export type Resolution = { path: string } | { path: null; name: string; key: string };

/**
 * Comparison key of a note name or path: ignores case and Unicode composition, keeps
 * accents. A link can only change its resolution when a note whose `linkKey(path)` ends
 * with the link's key (on a `/` boundary) is created, deleted or renamed.
 */
export function linkKey(name: string): string {
  return stripExtension(name.normalize('NFC').toLowerCase());
}

function stripExtension(name: string): string {
  return name.replace(/\.md$/i, '');
}

export type LinkResolver = (target: string, source: string) => Resolution;

/**
 * Resolves targets against a fixed set of note paths (vault-relative, see `ipc.ts`); build
 * a new one when notes are created, deleted or renamed.
 * A target matches by file name without `.md`, case-insensitive; a folder prefix must match
 * the end of the path, whole folders only. Among several matches the shortest path wins:
 * fewest folders, then fewest characters, then code unit order.
 */
export function createLinkResolver(notePaths: Iterable<string>): LinkResolver {
  const byName = new Map<string, { path: string; key: string; depth: number }[]>();
  for (const path of notePaths) {
    const key = linkKey(path);
    const parts = key.split('/');
    const name = parts[parts.length - 1]!;
    const entry = { path, key: `/${key}`, depth: parts.length };
    const list = byName.get(name);
    if (list) list.push(entry);
    else byName.set(name, [entry]);
  }
  for (const list of byName.values()) {
    list.sort(
      (a, b) =>
        a.depth - b.depth || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
  }

  return (target, source) => {
    if (target === '') return { path: source };
    const key = linkKey(target);
    const candidates = byName.get(key.slice(key.lastIndexOf('/') + 1));
    const match = candidates?.find((c) => c.key.endsWith(`/${key}`));
    return match ? { path: match.path } : { path: null, name: stripExtension(target), key };
  };
}

/** Every link of the note at `source`, in text order, resolved. */
export function noteLinks(source: string, text: string, resolve: LinkResolver): NoteLink[] {
  return parseLinks(text).map((link) => ({ ...link, source, ...resolve(link.target, source) }));
}

/** Every link in a note's text, in text order. Accepts LF and CRLF. */
export function parseLinks(text: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  for (const [start, end] of inlineBlocks(text)) scanInline(text, start, end, links);
  return links;
}

const QUOTE = /^ {0,3}> ?/;
const LIST_MARKER = /^[ \t]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)/;
const FENCE = /^[ \t]*(`{3,}(?=[^`]*$)|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const INDENTED = /^(?: {4}| {0,3}\t)/;

/**
 * The text ranges outside code blocks, one per block (paragraph, list item, heading, table
 * row): a code span never crosses from one to another.
 */
function inlineBlocks(text: string): [number, number][] {
  const blocks: [number, number][] = [];
  let open: [number, number] | null = null; // the paragraph being read
  let fence: { marker: string; quotes: number } | null = null;
  let inList = false; // in a list, indentation is continuation text, not code
  let blank = true;
  let quotes = 0;

  const flush = () => {
    if (open) blocks.push(open);
    open = null;
  };

  for (let start = 0, next = 0; start < text.length; start = next) {
    const newline = text.indexOf('\n', start);
    next = newline === -1 ? text.length : newline + 1;
    let line = text.slice(start, next).replace(/\r?\n$/, '');

    if (fence) {
      let inner = line;
      let found = 0;
      for (; found < fence.quotes && QUOTE.test(inner); found++) inner = inner.replace(QUOTE, '');
      // Leaving the blockquote also ends its fence.
      if (found === fence.quotes) {
        const closing = inner.trim();
        if (closing.startsWith(fence.marker) && closing === fence.marker[0]!.repeat(closing.length)) {
          fence = null;
        }
        continue;
      }
      fence = null;
    }

    let depth = 0;
    for (; QUOTE.test(line); depth++) line = line.replace(QUOTE, '');
    if (depth !== quotes) {
      flush();
      quotes = depth;
      inList = false;
      blank = true;
    }

    if (line.trim() === '') {
      flush();
      blank = true;
      continue;
    }
    const afterBlank: boolean = blank;
    blank = false;
    // Indented code cannot interrupt a paragraph.
    if (!inList && !open && INDENTED.test(line)) {
      blank = afterBlank;
      continue;
    }

    const marker = LIST_MARKER.exec(line);
    if (marker) {
      flush();
      inList = true;
      line = line.slice(marker[0].length);
    } else if (!/^[ \t]/.test(line) && (afterBlank || HEADING.test(line) || FENCE.test(line))) {
      inList = false;
    }

    const opening = FENCE.exec(line);
    if (opening) {
      flush();
      fence = { marker: opening[1]!, quotes: depth };
      continue;
    }
    // Headings and table rows are blocks of a single line.
    const single = HEADING.test(line) || line.trimStart().startsWith('|');
    if (single || marker) flush();
    if (open) open[1] = next;
    else open = [start, next];
    if (single) flush();
  }
  flush();
  return blocks;
}

const LINK = /\[\[([^[\]\r\n]+)\]\]/y;

/** Reads one block left to right: whichever of code span or link starts first wins. */
function scanInline(text: string, start: number, end: number, links: ParsedLink[]): void {
  const block = text.slice(start, end);
  // Start offsets of the backtick runs, by run length, to find closers without rescanning.
  const runs = new Map<number, { at: number[]; next: number }>();
  for (const run of block.matchAll(/`+/g)) {
    const same = runs.get(run[0].length);
    if (same) same.at.push(run.index);
    else runs.set(run[0].length, { at: [run.index], next: 0 });
  }

  const special = /[\\`[]/g;
  for (let found = special.exec(block); found; found = special.exec(block)) {
    const i = found.index;
    if (found[0] === '\\') {
      special.lastIndex = i + 2; // `\[` and `\`` are literal
    } else if (found[0] === '`') {
      let length = 1;
      while (block[i + length] === '`') length++;
      // An escaped backtick can leave a run shorter than the ones collected above.
      const same = runs.get(length);
      if (same) {
        while (same.next < same.at.length && same.at[same.next]! < i + length) same.next++;
      }
      const closer = same?.at[same.next];
      // Without a closer of the same length the run is plain text.
      special.lastIndex = (closer ?? i) + length;
    } else {
      LINK.lastIndex = i;
      const match = LINK.exec(block);
      if (!match) continue;
      const link = readLink(match[1]!, start + i);
      if (link) links.push(link);
      special.lastIndex = i + match[0].length;
    }
  }
}

/** `inner` is the text between the brackets of the link starting at `from`. */
function readLink(inner: string, from: number): ParsedLink | null {
  const pipe = inner.indexOf('|');
  // Inside tables Obsidian writes the separator as `\|`.
  const reference = pipe === -1 ? inner : inner.slice(0, pipe).replace(/\\$/, '');
  const alias = pipe === -1 ? '' : inner.slice(pipe + 1).trim();
  const hash = reference.indexOf('#');
  const written = hash === -1 ? reference : reference.slice(0, hash);
  const target = written.trim();
  const subpath = hash === -1 ? '' : reference.slice(hash).trimEnd();
  if (target === '' && subpath === '') return null;
  const targetFrom = from + 2 + (target === '' ? 0 : written.length - written.trimStart().length);
  return {
    from,
    to: from + inner.length + 4,
    targetFrom,
    targetTo: targetFrom + target.length,
    target,
    subpath,
    alias: alias || null,
  };
}
