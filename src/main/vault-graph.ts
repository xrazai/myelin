// The graph's side of the index: notes and links as it takes them, and the positions it
// saves by note path. Runs inside vault-worker only. Loaded by Node as-is in tests (type
// stripping): erasable TypeScript only.
import type Database from 'better-sqlite3';
import type { GraphSnapshot } from '../shared/ipc';

export function readGraph(db: Database.Database): GraphSnapshot {
  const rows = db
    .prepare('SELECT n.path, p.x, p.y FROM notes n LEFT JOIN positions p ON p.path = n.path ORDER BY n.path')
    .raw()
    .all() as [string, number | null, number | null][];
  const paths = rows.map(([path]) => path);
  const positions = new Float32Array(rows.length * 2);
  rows.forEach(([, x, y], i) => {
    positions[i * 2] = x ?? NaN;
    positions[i * 2 + 1] = y ?? NaN;
  });
  const index = new Map(paths.map((path, i) => [path, i]));
  const seen = new Set<number>();
  const edges: number[] = [];
  const links = db
    .prepare('SELECT DISTINCT source, target_path FROM links WHERE target_path IS NOT NULL AND target_path <> source')
    .raw()
    .iterate() as IterableIterator<[string, string]>;
  for (const [source, target] of links) {
    const a = index.get(source);
    const b = index.get(target);
    if (a === undefined || b === undefined) continue;
    // Two notes that link to each other are one edge.
    const key = a < b ? a * paths.length + b : b * paths.length + a;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(a, b);
  }
  return { paths, positions, edges: Uint32Array.from(edges) };
}

export function writePositions(db: Database.Database, paths: string[], positions: Float32Array): void {
  const save = db.prepare(
    `INSERT INTO positions (path, x, y) SELECT path, ?, ? FROM notes WHERE path = ?
     ON CONFLICT (path) DO UPDATE SET x = excluded.x, y = excluded.y`,
  );
  db.transaction(() => {
    paths.forEach((path, i) => {
      const x = positions[i * 2]!;
      const y = positions[i * 2 + 1]!;
      if (Number.isFinite(x) && Number.isFinite(y)) save.run(x, y, path);
    });
  })();
}

/** Renamed or moved notes keep their place. Called before the index learns of the move. */
export function movePositions(db: Database.Database, moves: ReadonlyMap<string, string>): void {
  const move = db.prepare('UPDATE OR REPLACE positions SET path = ? WHERE path = ?');
  db.transaction(() => {
    for (const [from, to] of moves) move.run(to, from);
  })();
}
