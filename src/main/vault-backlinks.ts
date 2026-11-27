// The notes that link to a note, each with the lines holding the links. Runs inside
// vault-worker only. Loaded by Node as-is in tests (type stripping): erasable TypeScript.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Backlink } from '../shared/ipc';

/** Enough for any list a person reads; each source is a file read. */
export const MAX_SOURCES = 500;
/** A line longer than this is cut around its link. */
const MAX_LINE = 200;

interface Row {
  source: string;
  from: number;
}

/** Links that resolve to `path`, but not the note's own, in source then text order. */
export function backlinkRows(db: Database.Database, path: string): Row[] {
  return db
    .prepare(
      `SELECT source, from_pos AS "from" FROM links WHERE target_path = ? AND source <> ?
       ORDER BY source, from_pos`,
    )
    .all(path, path) as Row[];
}

/**
 * Where the link at `from` of `text` (without BOM, any line endings) is: line (1-based),
 * column, and the line itself. `null` if no link starts there any more.
 */
export function linkLine(text: string, from: number): Omit<Backlink, 'path'> | null {
  if (!text.startsWith('[[', from)) return null;
  const before = text.slice(0, from).split(/\r\n|\n|\r/);
  const line = before.length;
  const column = before.at(-1)!.length;
  const start = from - column;
  const rest = text.slice(start);
  const end = rest.search(/[\r\n]/);
  let shown = end === -1 ? rest : rest.slice(0, end);
  if (shown.length > MAX_LINE) {
    const cut = Math.max(0, Math.min(column - MAX_LINE / 4, shown.length - MAX_LINE));
    shown = `${cut > 0 ? '…' : ''}${shown.slice(cut, cut + MAX_LINE)}${cut + MAX_LINE < shown.length ? '…' : ''}`;
  }
  return { line, column, text: shown.trim() };
}

/** Reads each linking note once. One that cannot be read, or changed meanwhile, is left out. */
export async function readBacklinks(root: string, rows: Row[]): Promise<Backlink[]> {
  const bySource = new Map<string, number[]>();
  for (const { source, from } of rows) {
    const positions = bySource.get(source);
    if (positions) positions.push(from);
    else if (bySource.size < MAX_SOURCES) bySource.set(source, [from]);
  }
  const found: Backlink[] = [];
  for (const [path, positions] of bySource) {
    let text: string;
    try {
      text = (await readFile(join(root, path), 'utf8')).replace(/^﻿/, '');
    } catch {
      continue;
    }
    for (const from of positions) {
      const at = linkLine(text, from);
      if (at) found.push({ path, ...at });
    }
  }
  return found;
}
