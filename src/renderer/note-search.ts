// Fuzzy search over note names, ignoring case and accents. Plain TS.
import { noteNameProblem } from '../shared/links.ts';

export interface NoteMatch {
  path: string;
  /** File name without `.md`. */
  name: string;
  /** `''` at the vault root. */
  folder: string;
  /** Another note has the same name (case ignored): the folder tells them apart. */
  duplicate: boolean;
}

/** The best matches first. An empty query lists recent notes first, then notes in name order. */
export type NoteSearch = (query: string, limit: number, recent?: readonly string[]) => NoteMatch[];

/** Without accents and case. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const LETTER = /[\p{L}\p{N}]/u;

/** A letter or digit before a match: it is not the start of a word. */
function inWord(text: string, at: number): boolean {
  const code = text.charCodeAt(at - 1);
  // ASCII without the regular expression, which is slow over a whole vault.
  if (code < 128) return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
  return LETTER.test(text[at - 1]!);
}

/** The characters a gapped match looks for. Spaces only separate what was typed. */
function lettersOf(query: string): string {
  return query.replaceAll(' ', '');
}

/**
 * One bit per letter, one for the digits, five shared by the rest: a text whose mask
 * lacks a bit of the query's cannot match it.
 */
function maskOf(text: string): number {
  let mask = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 32) continue;
    mask |= 1 << (code >= 97 && code <= 122 ? code - 97 : code >= 48 && code <= 57 ? 26 : 27 + (code % 5));
  }
  return mask;
}

/**
 * How many of `letters`, from `start` on, `text` holds in order. One pass, no
 * `indexOf` per letter: this runs for every note on every keystroke.
 */
function lettersIn(text: string, letters: string, start = 0): number {
  let i = start;
  let wanted = letters.charCodeAt(i);
  for (let j = 0; j < text.length && i < letters.length; j++) {
    if (text.charCodeAt(j) === wanted) wanted = letters.charCodeAt(++i);
  }
  return i - start;
}

/** From the first to the last character of the earliest gapped match, which must exist. */
function spreadOf(text: string, letters: string): number {
  const first = text.indexOf(letters[0]!);
  let last = first;
  for (let i = 1; i < letters.length; i++) last = text.indexOf(letters[i]!, last + 1);
  return last - first;
}

/**
 * Lower is better; `null`: no match. Whole text, its start, the start of a word,
 * anywhere, then the characters in order with gaps (tighter is better). Both folded.
 * `letters`: `lettersOf(query)`, passed in by a caller that scores many texts.
 */
export function score(text: string, query: string, letters = lettersOf(query)): number | null {
  // First the characters in order: every match has them, and most texts stop here.
  if (lettersIn(text, letters) < letters.length) return null;
  let at = text.indexOf(query);
  if (at === 0) return text.length === query.length ? 0 : 1;
  if (at > 0) {
    for (; at > 0; at = text.indexOf(query, at + 1)) if (!inWord(text, at)) return 2;
    return 3;
  }
  // From 4 up to 5, by how spread out the characters are.
  const spread = spreadOf(text, letters);
  return 4 + spread / (spread + 1);
}

export function createNoteSearch(paths: Iterable<string>): NoteSearch {
  const names = new Map<string, number>();
  const notes = Array.from(paths, (path) => {
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1).replace(/\.md$/i, '');
    const same = name.normalize('NFC').toLowerCase();
    names.set(same, (names.get(same) ?? 0) + 1);
    return {
      path,
      name,
      folder: path.slice(0, Math.max(0, slash)),
      same,
      key: fold(name),
      folderKey: fold(path.slice(0, slash + 1)),
      pathKey: fold(path.replace(/\.md$/i, '')),
    };
  }).sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path));

  // By position in `notes`, packed: most notes are ruled out without being read. The name
  // is part of the path, so this covers both.
  const masks = Int32Array.from(notes, (note) => maskOf(note.pathKey));

  const byPathMap = new Map<string, (typeof notes)[number]>();
  for (const note of notes) byPathMap.set(note.path, note);

  return (query, limit, recent) => {
    const wanted = fold(query.trim());
    const letters = lettersOf(wanted);
    // A `/` asks about folders too.
    const byPath = wanted.includes('/');
    let found = notes;
    if (wanted !== '') {
      if (limit <= 0) return [];
      const top: { note: (typeof notes)[number]; score: number }[] = [];
      // Many notes share a folder: what each one gives a path match is counted once.
      const fromFolder = new Map<string, number>();
      // Whether the folder and the name together hold the letters the name alone does not.
      const pathCanMatch = (note: (typeof notes)[number]) => {
        let given = fromFolder.get(note.folderKey);
        if (given === undefined) fromFolder.set(note.folderKey, (given = lettersIn(note.folderKey, letters)));
        return given > 0 && lettersIn(note.key, letters, given) === letters.length - given;
      };
      const needed = maskOf(letters);
      for (let index = 0; index < notes.length; index++) {
        if ((masks[index]! & needed) !== needed) continue;
        const note = notes[index]!;
        const text = byPath ? note.pathKey : note.key;
        // With the list full of word starts or better, a name no shorter than the last
        // one gets in only by starting with the query: no need to score the others.
        if (top.length === limit) {
          const worst = top[limit - 1]!;
          if (worst.score <= 2 && note.name.length >= worst.note.name.length && !text.startsWith(wanted)) continue;
        }
        let result = score(text, wanted, letters);
        if (result === null && !byPath) {
          if (top.length === limit && top[limit - 1]!.score < 10) continue;
          if (!pathCanMatch(note)) continue;
          const pathScore = score(note.pathKey, wanted, letters);
          if (pathScore !== null) result = pathScore + 10;
        }
        if (result === null) continue;
        if (top.length === limit) {
          const worst = top[limit - 1]!;
          if (result > worst.score || (result === worst.score && note.name.length >= worst.note.name.length)) {
            continue;
          }
          top.pop();
        }
        let pos = top.length;
        while (pos > 0) {
          const prev = top[pos - 1]!;
          if (prev.score < result || (prev.score === result && prev.note.name.length <= note.name.length)) break;
          pos--;
        }
        top.splice(pos, 0, { note, score: result });
      }
      found = top.map((match) => match.note);
    } else if (recent && recent.length > 0) {
      const result: (typeof notes)[number][] = [];
      const seen = new Set<string>();
      for (const path of recent) {
        if (result.length >= limit) break;
        if (seen.has(path)) continue;
        const note = byPathMap.get(path);
        if (!note) continue;
        seen.add(path);
        result.push(note);
      }
      for (const note of notes) {
        if (result.length >= limit) break;
        if (seen.has(note.path)) continue;
        result.push(note);
      }
      found = result;
    }
    return found.slice(0, limit).map(({ path, name, folder, same }) => ({
      path,
      name,
      folder,
      duplicate: names.get(same)! > 1,
    }));
  };
}

export interface NewNote {
  /** The `.md` path the query asks for. */
  path: string;
  /** Why no note can be created there, or `null`. */
  problem: string | null;
}

/** The note a palette query would create; `null`: nothing was typed. Same names as a rename. */
export function newNoteFor(query: string): NewNote | null {
  const trimmed = query.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return null;
  const path = /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  const segments = trimmed.split('/');
  let problem: string | null;
  if (segments.includes('')) problem = 'a folder name cannot be empty';
  else if (segments.some((segment) => segment.startsWith('.'))) problem = 'a name cannot start with a dot';
  else problem = noteNameProblem(path);
  return { path, problem };
}
