// The only door to "intelligence" (AGENTS.md, "AI: prepared, not decided"): FTS5 now.
// Semantic search and a local model plug in behind it later, without touching the UI.
// Runs inside vault-worker only. Loaded by Node as-is in tests: erasable TypeScript.
import type Database from 'better-sqlite3';
import type { SearchCard } from '../shared/ipc';

export const SEARCH_LIMIT = 30;
/** Title above body. */
const WEIGHTS = '10.0, 1.0';
/** Private-use characters around each match: note text does not hold them. */
const OPEN = '';
const CLOSE = '';
const EXCERPT_TOKENS = 32;
/** A query this long is not a search. */
const MAX_QUERY = 500;

/**
 * The FTS5 query for what the user typed, or `null` if there is nothing to look for. Typed
 * text is never FTS5 syntax: each term is quoted, and the last one also matches as a
 * prefix, since it may not be finished.
 */
export function matchQuery(typed: string): string | null {
  const terms = typed
    .slice(0, MAX_QUERY)
    .split(/\s+/)
    // The tokenizer keeps only letters and numbers: a term without them asks for nothing.
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .map((term) => `"${term.replaceAll('"', '""')}"`);
  return terms.length === 0 ? null : `${terms.join(' ')}*`;
}

/** Takes the markers out of a snippet, keeping where the matches were. */
export function readSnippet(marked: string): { excerpt: string; matches: [number, number][] } {
  const matches: [number, number][] = [];
  let excerpt = '';
  let open = -1;
  // One character for one: offsets hold. A card shows one flowing paragraph.
  for (const char of marked.replace(/[\t\n\r]/g, ' ')) {
    if (char === OPEN) open = excerpt.length;
    else if (char === CLOSE) {
      if (open !== -1) matches.push([open, excerpt.length]);
      open = -1;
    } else excerpt += char;
  }
  return { excerpt, matches };
}

interface Row {
  path: string;
  title: string;
  snippet: string;
  rank: number;
}

/** Cards ordered by relevance: `bm25`, the title above the body. */
export function search(db: Database.Database, typed: string, limit = SEARCH_LIMIT): SearchCard[] {
  const query = matchQuery(typed);
  if (query === null) return [];
  // Ranked first, and a snippet only for what is shown: a snippet reads the note's text.
  const rows = db
    .prepare(
      `WITH best AS (
         SELECT rowid AS id, bm25(notes_fts, ${WEIGHTS}) AS rank FROM notes_fts
         WHERE notes_fts MATCH @query ORDER BY rank LIMIT @limit
       )
       SELECT notes.path, notes.title, best.rank,
         snippet(notes_fts, 1, '${OPEN}', '${CLOSE}', '…', ${EXCERPT_TOKENS}) AS snippet
       FROM best
       JOIN notes_fts ON notes_fts.rowid = best.id
       JOIN notes ON notes.id = best.id
       WHERE notes_fts MATCH @query
       ORDER BY best.rank, notes.path`,
    )
    .all({ query, limit }) as Row[];
  return rows.map(({ path, title, snippet, rank }) => ({ path, title, score: -rank, ...readSnippet(snippet) }));
}

/** The heavy path of the save pipeline (AGENTS.md, rule 2). No processor exists yet. */
export function processNote(_changedNote: string): void {}
