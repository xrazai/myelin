// Fuzzy search over note names, ignoring case and accents. Plain TS.

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

/**
 * Lower is better; `null`: no match. Whole text, its start, the start of a word,
 * anywhere, then the characters in order with gaps (tighter is better). Both folded.
 */
export function score(text: string, query: string): number | null {
  let at = text.indexOf(query);
  if (at === 0) return text.length === query.length ? 0 : 1;
  if (at > 0) {
    for (; at > 0; at = text.indexOf(query, at + 1)) if (!LETTER.test(text[at - 1]!)) return 2;
    return 3;
  }
  let first = -1;
  let last = -1;
  for (const char of query) {
    // Spaces only separate what was typed.
    if (char === ' ') continue;
    last = text.indexOf(char, last + 1);
    if (last === -1) return null;
    if (first === -1) first = last;
  }
  // From 4 up to 5, by how spread out the characters are.
  const spread = last - first;
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
      pathKey: fold(path.replace(/\.md$/i, '')),
    };
  }).sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path));

  const byPathMap = new Map<string, (typeof notes)[number]>();
  for (const note of notes) byPathMap.set(note.path, note);

  return (query, limit, recent) => {
    const wanted = fold(query.trim());
    // A `/` asks about folders too.
    const byPath = wanted.includes('/');
    let found = notes;
    if (wanted !== '') {
      if (limit <= 0) return [];
      const top: { note: (typeof notes)[number]; score: number }[] = [];
      for (const note of notes) {
        let result = score(byPath ? note.pathKey : note.key, wanted);
        if (result === null && !byPath) {
          if (top.length === limit && top[limit - 1]!.score < 10) continue;
          const pathScore = score(note.pathKey, wanted);
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

/** Normalizes a palette query into a `.md` note path, or `null` if empty or invalid. */
export function normalizeNewNotePath(query: string): string | null {
  const trimmed = query.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '' || trimmed.includes('\\') || trimmed.includes(':') || trimmed.includes('\0')) {
    return null;
  }
  const segments = trimmed.split('/');
  if (segments.some((seg) => seg === '' || seg.startsWith('.'))) return null;
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}
