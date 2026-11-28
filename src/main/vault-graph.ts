// The graph's side of the index: notes and links as it takes them, and the positions it
// saves by note path. Runs inside vault-worker only. Loaded by Node as-is in tests (type
// stripping): erasable TypeScript only.
import type Database from 'better-sqlite3';
import type { GraphDelta, GraphSnapshot } from '../shared/ipc';

export function readGraph(db: Database.Database): GraphSnapshot {
  const rows = db
    .prepare(
      `SELECT n.path, p.x, p.y, n.mtime_ms, c.levels FROM notes n
       LEFT JOIN positions p ON p.path = n.path LEFT JOIN communities c ON c.path = n.path ORDER BY n.path`,
    )
    .raw()
    .all() as [string, number | null, number | null, number | null, string | null][];
  const paths = rows.map(([path]) => path);
  const positions = new Float32Array(rows.length * 2);
  rows.forEach(([, x, y], i) => {
    positions[i * 2] = x ?? NaN;
    positions[i * 2 + 1] = y ?? NaN;
  });
  const edges: number[] = [];
  for (const [a, b] of linkedPairs(db, paths).values()) edges.push(a, b);
  const edited = Float64Array.from(rows, (row) => row[3] ?? 0);
  return { paths, positions, edited, edges: Uint32Array.from(edges), communities: savedCommunities(rows.map((row) => row[4])) };
}

/** The linked pairs of notes as indices into `paths`, by a key of the two paths. */
function linkedPairs(db: Database.Database, paths: string[]): Map<string, [number, number]> {
  const index = new Map(paths.map((path, i) => [path, i]));
  const pairs = new Map<string, [number, number]>();
  const links = db
    .prepare('SELECT DISTINCT source, target_path FROM links WHERE target_path IS NOT NULL AND target_path <> source')
    .raw()
    .iterate() as IterableIterator<[string, string]>;
  for (const [source, target] of links) {
    const a = index.get(source);
    const b = index.get(target);
    if (a === undefined || b === undefined) continue;
    // Two notes that link to each other are one edge. No path holds a line break.
    const key = source < target ? `${source}\n${target}` : `${target}\n${source}`;
    if (!pairs.has(key)) pairs.set(key, [a, b]);
  }
  return pairs;
}

interface Sent {
  /** Each note with when its file changed. */
  notes: Map<string, number>;
  edges: Set<string>;
}

/**
 * Remembers what the graph was last given, so that after it only what changed is sent:
 * the comparison runs here, off the interface's thread.
 */
export function createGraphFeed() {
  let sent: Sent | null = null;
  return {
    full(db: Database.Database): GraphSnapshot {
      const snapshot = readGraph(db);
      const { paths, edges, edited } = snapshot;
      sent = { notes: new Map(paths.map((path, i) => [path, edited[i]!])), edges: new Set() };
      for (let e = 0; e < edges.length; e += 2) {
        const a = paths[edges[e]!]!;
        const b = paths[edges[e + 1]!]!;
        sent.edges.add(a < b ? `${a}\n${b}` : `${b}\n${a}`);
      }
      return snapshot;
    },
    changes(db: Database.Database): GraphDelta | null {
      if (!sent) return null;
      const rows = db.prepare('SELECT path, mtime_ms FROM notes ORDER BY path').raw().all() as [string, number | null][];
      const notes = new Map(rows.map(([path, time]) => [path, time ?? 0]));
      const paths = [...notes.keys()];
      const pairs = linkedPairs(db, paths);
      const before = sent;
      const removed = [...before.notes.keys()].filter((path) => !notes.has(path));
      const added = paths.filter((path) => !before.notes.has(path));
      const saved = db.prepare('SELECT x, y FROM positions WHERE path = ?').raw();
      const positions = new Float32Array(added.length * 2).fill(NaN);
      added.forEach((path, i) => {
        const found = saved.get(path) as [number, number] | undefined;
        if (found) positions.set(found, i * 2);
      });
      const removedEdges = [...before.edges]
        .filter((key) => !pairs.has(key))
        .map((key) => key.split('\n') as [string, string]);
      const addedEdges: [string, string][] = [];
      for (const [key, [a, b]] of pairs) if (!before.edges.has(key)) addedEdges.push([paths[a]!, paths[b]!]);
      const edited = [...notes].filter(([path, time]) => before.notes.get(path) !== time);
      sent = { notes, edges: new Set(pairs.keys()) };
      return { removed, added, positions, removedEdges, addedEdges, edited };
    },
  };
}

/** `null` unless every note has its communities, all with the same levels. */
function savedCommunities(saved: (string | null)[]): Uint32Array[] | null {
  if (saved.length === 0 || saved.some((text) => text === null)) return null;
  const rows = saved.map((text) => JSON.parse(text!) as number[]);
  const depth = rows[0]!.length;
  if (depth === 0 || rows.some((row) => row.length !== depth)) return null;
  return Array.from({ length: depth }, (_, level) => Uint32Array.from(rows, (row) => row[level]!));
}

export function writeCommunities(db: Database.Database, paths: string[], levels: Uint32Array[]): void {
  const save = db.prepare(
    `INSERT INTO communities (path, levels) SELECT path, ? FROM notes WHERE path = ?
     ON CONFLICT (path) DO UPDATE SET levels = excluded.levels`,
  );
  db.transaction(() => {
    paths.forEach((path, i) => save.run(JSON.stringify(levels.map((level) => level[i])), path));
  })();
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

/**
 * Renamed or moved notes keep their place and communities. Called before the index learns
 * of the move.
 */
export function moveGraphData(db: Database.Database, moves: ReadonlyMap<string, string>): void {
  const statements = ['positions', 'communities'].map((table) =>
    db.prepare(`UPDATE OR REPLACE ${table} SET path = ? WHERE path = ?`),
  );
  db.transaction(() => {
    for (const [from, to] of moves) for (const move of statements) move.run(to, from);
  })();
}
