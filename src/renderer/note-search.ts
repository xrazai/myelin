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

/** The best matches first. An empty query lists notes in name order. */
export type NoteSearch = (query: string, limit: number) => NoteMatch[];

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

  return (query, limit) => {
    const wanted = fold(query.trim());
    // A `/` asks about folders too.
    const byPath = wanted.includes('/');
    let found = notes;
    if (wanted !== '') {
      const scored: { note: (typeof notes)[number]; score: number }[] = [];
      for (const note of notes) {
        const result = score(byPath ? note.pathKey : note.key, wanted);
        if (result !== null) scored.push({ note, score: result });
      }
      // Stable: ties of score and length stay in name order.
      scored.sort((a, b) => a.score - b.score || a.note.name.length - b.note.name.length);
      found = scored.map((match) => match.note);
    }
    return found.slice(0, limit).map(({ path, name, folder, same }) => ({
      path,
      name,
      folder,
      duplicate: names.get(same)! > 1,
    }));
  };
}
