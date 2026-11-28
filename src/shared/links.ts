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
 * named `name`. `key` is `linkKey(target)`, empty for a link to the note itself; links to
 * the same missing note share it.
 */
export type Resolution = ({ path: string } | { path: null; name: string }) & { key: string };

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

/** A resolver that follows notes as they come and go, without being built again. */
export type MutableLinkResolver = LinkResolver & {
  /** A path that is not there yet. */
  add(path: string): void;
  /** A path that is not there is ignored. */
  remove(path: string): void;
};

/**
 * Resolves targets against a set of note paths (vault-relative, see `ipc.ts`). Call `add`
 * and `remove` as notes are created and deleted, or build a new one.
 * A target matches by file name without `.md`, case-insensitive; a folder prefix must match
 * the end of the path, whole folders only. Among several matches the shortest path wins:
 * fewest folders, then fewest characters, then code unit order.
 */
export function createLinkResolver(notePaths: Iterable<string>): MutableLinkResolver {
  type Entry = { path: string; key: string; depth: number };
  const byName = new Map<string, Entry[]>();
  /** The first of several matches wins. */
  const order = (a: Entry, b: Entry) =>
    a.depth - b.depth || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const read = (path: string) => {
    const key = linkKey(path);
    const parts = key.split('/');
    return { name: parts[parts.length - 1]!, entry: { path, key: `/${key}`, depth: parts.length } };
  };
  for (const path of notePaths) {
    const { name, entry } = read(path);
    const list = byName.get(name);
    if (list) list.push(entry);
    else byName.set(name, [entry]);
  }
  for (const list of byName.values()) list.sort(order);

  const resolve = (target: string, source: string): Resolution => {
    if (target === '') return { path: source, key: '' };
    const key = linkKey(target);
    const candidates = byName.get(key.slice(key.lastIndexOf('/') + 1));
    const match = candidates?.find((c) => c.key.endsWith(`/${key}`));
    return match ? { path: match.path, key } : { path: null, name: stripExtension(target), key };
  };

  return Object.assign(resolve, {
    add(path: string) {
      const { name, entry } = read(path);
      const list = byName.get(name);
      if (!list) {
        byName.set(name, [entry]);
        return;
      }
      const after = list.findIndex((other) => order(entry, other) < 0);
      list.splice(after === -1 ? list.length : after, 0, entry);
    },
    remove(path: string) {
      const { name } = read(path);
      const list = byName.get(name);
      const at = list?.findIndex((entry) => entry.path === path) ?? -1;
      if (at === -1) return;
      list!.splice(at, 1);
      if (list!.length === 0) byName.delete(name);
    },
  });
}

/** Every link of the note at `source`, in text order, resolved. */
export function noteLinks(source: string, text: string, resolve: LinkResolver): NoteLink[] {
  return parseLinks(text).map((link) => ({ ...link, source, ...resolve(link.target, source) }));
}

/**
 * Why a note cannot be renamed to `path`, or `null`. Refuses names that `[[links]]` or
 * Windows cannot hold.
 */
export function noteNameProblem(path: string): string | null {
  const segments = stripExtension(path).split('/');
  const name = segments[segments.length - 1]!;
  if (/[[\]#|]/.test(name)) return 'a note name cannot contain [ ] # |';
  const problem = segmentsProblem(segments);
  if (problem) return problem;
  if (/\.md$/i.test(name)) return 'a note name cannot end with .md';
  return null;
}

const RESERVED = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$) *(?:\.|$)/i;

/** A device name of Windows, with any extension. Git and most Windows tools refuse it. */
export function isReservedName(segment: string): boolean {
  return RESERVED.test(segment);
}

/** What no name on the way to a note, its own included, can be. */
function segmentsProblem(segments: string[]): string | null {
  if (segments.some(isReservedName)) return 'Windows reserves that name';
  if (segments.some((segment) => /[<>:"?*\\\x00-\x1f]/.test(segment))) {
    return 'a name cannot contain < > : " ? * \\';
  }
  if (segments.some((segment) => segment !== segment.trim() || segment.endsWith('.'))) {
    return 'a name cannot start or end with a space, or end with a dot';
  }
  return null;
}

/**
 * Why a folder cannot be created at `path`, or `null`. As strict as a note name: a link
 * by path (`[[folder/Note]]`) must be able to hold every folder on the way.
 */
export function folderNameProblem(path: string): string | null {
  const segments = path.split('/');
  if (segments.includes('')) return 'a folder name cannot be empty';
  // Hidden: neither the tree nor the index would show it.
  if (segments.some((segment) => segment.startsWith('.'))) return 'a name cannot start with a dot';
  if (segments.some((segment) => /[[\]#|]/.test(segment))) return 'a folder name cannot contain [ ] # |';
  // The watcher would take it for a note.
  if (segments.some((segment) => /\.md$/i.test(segment))) return 'a folder name cannot end with .md';
  return segmentsProblem(segments);
}

/**
 * `rewriteLinksForMoves` for the rename of one note.
 */
export function rewriteLinksForRename(
  text: string,
  source: string,
  from: string,
  to: string,
  oldResolve: LinkResolver,
  newResolve: LinkResolver,
): { text: string; count: number } {
  return rewriteLinksForMoves(text, source, new Map([[from, to]]), oldResolve, newResolve);
}

/**
 * Rewrites the links in `text`, the note at `source`, so that every one still leads where
 * it did once the notes in `moves` (old path -> new path) have moved, all at once: the
 * links to a moved note, and also those to another note that a new path would capture.
 * Only the target is replaced: alias, heading/block subpath, table escapes and line endings
 * stay as they were, and so does `[[#Heading]]`. `oldResolve` is the resolver from before
 * the moves, `newResolve` the one after. Returns the new text and the number of links
 * changed; throws if a link cannot be written.
 */
export function rewriteLinksForMoves(
  text: string,
  source: string,
  moves: ReadonlyMap<string, string>,
  oldResolve: LinkResolver,
  newResolve: LinkResolver,
): { text: string; count: number } {
  const nextSource = moves.get(source) ?? source;
  const nameOf = (path: string) => stripExtension(path.slice(path.lastIndexOf('/') + 1));
  /** The last `parts` names of a path: what a link that writes that many is about. */
  const tailOf = (path: string, parts: number) => stripExtension(path).split('/').slice(-parts).join('/');
  const edits: { link: ParsedLink; target: string }[] = [];

  for (const link of parseLinks(text)) {
    // `[[#Heading]]` means the note it is in, whatever its name.
    if (link.target === '') continue;
    const before = oldResolve(link.target, source).path;
    if (before === null) continue;
    const wanted = moves.get(before) ?? before;
    // A link follows a new spelling of what it writes (name or folder), even one that
    // differs in case only.
    const parts = link.target.split('/').length;
    const follows = tailOf(before, parts) !== tailOf(wanted, parts);
    if (!follows && newResolve(link.target, nextSource).path === wanted) continue;
    // The bare name, if the link was bare and the name still leads there; else the path.
    const name = nameOf(wanted);
    const bare = !link.target.includes('/') && newResolve(name, nextSource).path === wanted;
    const target = bare ? name : stripExtension(wanted);
    if (/[[\]#|]/.test(target)) throw new Error(`a link cannot point to ${wanted}: its path contains [ ] # |`);
    if (target !== link.target) edits.push({ link, target });
  }

  let result = text;
  for (const { link, target } of edits.reverse()) {
    result = result.slice(0, link.targetFrom) + target + result.slice(link.targetTo);
  }
  return { text: result, count: edits.length };
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

    // Outside lists, an indented fence here is just paragraph text.
    const opening = !inList && INDENTED.test(line) ? null : FENCE.exec(line);
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

/**
 * The `[[...]]` written at `at`, or `null`. `end` is where it ends; `link` is `null` for
 * brackets that link nowhere (`[[ ]]`). Does not look at what is around, such as code.
 */
export function matchLink(text: string, at: number): { end: number; link: ParsedLink | null } | null {
  LINK.lastIndex = at;
  const match = LINK.exec(text);
  return match && { end: at + match[0].length, link: readLink(match[1]!, at) };
}

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
      const match = matchLink(block, i);
      if (!match) continue;
      if (match.link) links.push(shift(match.link, start));
      special.lastIndex = match.end;
    }
  }
}

function shift(link: ParsedLink, by: number): ParsedLink {
  return {
    ...link,
    from: link.from + by,
    to: link.to + by,
    targetFrom: link.targetFrom + by,
    targetTo: link.targetTo + by,
  };
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
