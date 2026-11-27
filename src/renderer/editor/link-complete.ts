// `[[` completion (docs/features.md, pillar A): note names, and the headings of a note
// after `[[Note#`. The filtering is our own: CodeMirror's does not ignore accents.
import {
  autocompletion,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { EditorState, Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { matchLink, type LinkResolver } from '../../shared/links';
import type { NoteList } from '../note-list';
import { fold, score, type NoteMatch } from '../note-search';
import { frontmatterLength, headingsIn, noteHeadings, type Heading } from './headings';
import { opensLink } from './link-syntax';
import { notePath } from './note-path';

/** More than this is not a list anyone reads. */
export const MAX_OPTIONS = 50;

export interface CompletionHost {
  notes: NoteList;
  /** The text of another note: the editor's if it is open, else the disk's. */
  readText(path: string): Promise<string>;
}

/** From `[[` to the cursor; `|` starts the alias, which is free text. */
const OPEN_LINK = /\[\[[^[\]\r\n|]*$/;
/** What is left of the part under the cursor in a link already written. */
const REST_OF_NAME = /^[^[\]\r\n|#\\]*(?=\]\]|\||#|\\\|)/;
const REST_OF_HEADING = /^[^[\]\r\n|\\]*(?=\]\]|\||\\\|)/;

/** `true` if `[[target + subpath]]` reads back as these two. */
function writable(target: string, subpath: string): boolean {
  const link = matchLink(`[[${target}${subpath}]]`, 0)?.link;
  return link?.target === target && link.subpath === subpath && link.alias === null;
}

/**
 * The shortest way to write a link in `source` that leads to the note at `path`: its name,
 * or with as many folders as it takes. `null` for names the syntax cannot hold (`#`, `]`).
 */
export function linkTarget(path: string, source: string, resolve: LinkResolver): string | null {
  const parts = path.replace(/\.md$/i, '').split('/');
  for (let start = parts.length - 1; start >= 0; start--) {
    const target = parts.slice(start).join('/');
    if (resolve(target, source).path === path) return writable(target, '') ? target : null;
  }
  return null;
}

/** Writes `text` in the link, closes it if needed and leaves the cursor after it. */
function insert(rest: RegExp, text: string) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const { doc } = view.state;
    const after = doc.sliceString(to, doc.lineAt(to).to);
    const end = to + (rest.exec(after)?.[0].length ?? 0);
    const next = doc.sliceString(end, Math.min(end + 2, doc.length));
    const closed = next === ']]';
    // Before an alias or a heading the link goes on: the cursor stays before them.
    const goesOn = next.startsWith('|') || next.startsWith('#') || next === '\\|';
    const written = closed || goesOn ? text : `${text}]]`;
    view.dispatch({
      changes: { from, to: end, insert: written },
      selection: { anchor: from + written.length + (closed ? 2 : 0) },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete',
    });
  };
}

function noteOptions(matches: NoteMatch[], source: string, resolve: LinkResolver): Completion[] {
  return matches.flatMap((match) => {
    const target = linkTarget(match.path, source, resolve);
    if (target === null) return [];
    const option: Completion = { label: match.name, apply: insert(REST_OF_NAME, target) };
    if (match.duplicate) option.detail = `${match.folder}/`;
    return [option];
  });
}

function headingOptions(headings: Heading[], target: string, query: string): Completion[] {
  const wanted = fold(query.trim());
  const seen = new Set<string>();
  const found: { heading: Heading; score: number }[] = [];
  for (const heading of headings) {
    // A link cannot tell two equal headings apart.
    if (seen.has(heading.text) || !writable(target, `#${heading.text}`)) continue;
    seen.add(heading.text);
    const result = wanted === '' ? 0 : score(fold(heading.text), wanted);
    if (result !== null) found.push({ heading, score: result });
  }
  // Stable: ties stay in the order of the note.
  found.sort((a, b) => a.score - b.score);
  return found.slice(0, MAX_OPTIONS).map(({ heading }) => ({
    label: heading.text,
    detail: `H${heading.level}`,
    apply: insert(REST_OF_HEADING, heading.text),
  }));
}

/** The headings of the note on screen, from the tree the editor already has. */
function ownHeadings(state: EditorState): Heading[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const top = state.sliceDoc(0, Math.min(10_000, state.doc.length));
  return headingsIn(tree, (from, to) => state.sliceDoc(from, to), frontmatterLength(top));
}

export function linkCompletionSource({ notes, readText }: CompletionHost): CompletionSource {
  /** The note whose headings were read last: they are asked for on every key. */
  let last: { text: string; headings: Heading[] } | null = null;

  return async function complete(context: CompletionContext): Promise<CompletionResult | null> {
    const open = context.matchBefore(OPEN_LINK);
    if (!open) return null;
    const start = open.from;
    if (!opensLink(context.state, start)) return null;
    const written = context.state.sliceDoc(start + 2, context.pos);
    if (!notes.isLoaded()) {
      try {
        await notes.ready;
      } catch {
        return null;
      }
    }
    const source = context.state.facet(notePath);
    const hash = written.indexOf('#');

    if (hash === -1) {
      const options = noteOptions(notes.search(written, MAX_OPTIONS), source, notes.resolve);
      return options.length === 0 ? null : { from: start + 2, options, filter: false };
    }

    const target = written.slice(0, hash).trim();
    const query = written.slice(hash + 1);
    // `#^` names a block, which is not completed.
    if (query.startsWith('^')) return null;
    const { path } = notes.resolve(target, source);
    if (path === null) return null;
    let headings: Heading[];
    if (path === source) {
      headings = ownHeadings(context.state);
    } else {
      let text: string;
      try {
        text = await readText(path);
      } catch {
        return null;
      }
      if (last?.text !== text) last = { text, headings: noteHeadings(text) };
      headings = last.headings;
    }
    const options = headingOptions(headings, target, query);
    return options.length === 0 ? null : { from: start + 2 + hash + 1, options, filter: false };
  };
}

export function linkCompletion(host: CompletionHost): Extension {
  return autocompletion({ override: [linkCompletionSource(host)], icons: false });
}
