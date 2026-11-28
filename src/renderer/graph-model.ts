// The note path <-> graph node id map, and what the graph has to change to match the
// index. Ids are session-local (`docs/graph-lib.md`, rule 8); paths are the keys. Plain TS.
import type { GraphSnapshot } from '../shared/ipc';

export interface GraphChanges {
  /** Pairs `[s0, t0, ...]` that are no longer links. Applied first, while their nodes live. */
  removeEdges: Uint32Array;
  /** Applied second. */
  removeNodes: number[];
  /** Added third; `assign` takes the ids the graph gives them, in this order. */
  addNodes: { paths: string[]; positions: Float32Array };
}

/** One edge per pair of notes, whatever the direction. */
const pairKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

export class GraphModel {
  private readonly ids = new Map<string, number>();
  private paths: (string | undefined)[] = [];
  /** The pairs the graph has, as they were given to it. */
  private edges = new Map<string, [number, number]>();

  id(path: string): number | undefined {
    return this.ids.get(path);
  }

  path(id: number): string | undefined {
    return this.paths[id];
  }

  linked(a: number, b: number): boolean {
    return this.edges.has(pairKey(a, b));
  }

  /** A full load: node `i` is `snapshot.paths[i]`. */
  load({ paths, edges }: GraphSnapshot): void {
    this.ids.clear();
    this.paths = [...paths];
    paths.forEach((path, id) => this.ids.set(path, id));
    this.edges = new Map();
    for (let e = 0; e < edges.length; e += 2) {
      this.edges.set(pairKey(edges[e]!, edges[e + 1]!), [edges[e]!, edges[e + 1]!]);
    }
  }

  /** Notes that were renamed or moved keep their node. */
  rename(moves: Iterable<readonly [string, string]>): void {
    const taken: [string, number][] = [];
    for (const [from, to] of moves) {
      const id = this.ids.get(from);
      if (id === undefined) continue;
      this.ids.delete(from);
      taken.push([to, id]);
    }
    for (const [to, id] of taken) {
      this.ids.set(to, id);
      this.paths[id] = to;
    }
  }

  /** What differs in `snapshot`. The nodes it drops are forgotten here. */
  diff(snapshot: GraphSnapshot): GraphChanges {
    const present = new Set(snapshot.paths);
    const removeNodes: number[] = [];
    for (const [path, id] of this.ids) if (!present.has(path)) removeNodes.push(id);

    const wanted = new Set<string>();
    for (let e = 0; e < snapshot.edges.length; e += 2) {
      const a = this.ids.get(snapshot.paths[snapshot.edges[e]!]!);
      const b = this.ids.get(snapshot.paths[snapshot.edges[e + 1]!]!);
      if (a !== undefined && b !== undefined) wanted.add(pairKey(a, b));
    }
    const dropped: number[] = [];
    for (const [key, pair] of this.edges) {
      if (wanted.has(key)) continue;
      dropped.push(...pair);
      this.edges.delete(key);
    }

    for (const id of removeNodes) {
      this.ids.delete(this.paths[id]!);
      this.paths[id] = undefined;
    }

    const added: string[] = [];
    const positions: number[] = [];
    snapshot.paths.forEach((path, i) => {
      if (this.ids.has(path)) return;
      added.push(path);
      positions.push(snapshot.positions[i * 2]!, snapshot.positions[i * 2 + 1]!);
    });
    return {
      removeEdges: Uint32Array.from(dropped),
      removeNodes,
      addNodes: { paths: added, positions: Float32Array.from(positions) },
    };
  }

  /** Takes the ids of the added nodes and returns the pairs to add, by id. */
  assign(snapshot: GraphSnapshot, added: string[], ids: ArrayLike<number>): Uint32Array {
    added.forEach((path, i) => {
      this.ids.set(path, ids[i]!);
      this.paths[ids[i]!] = path;
    });
    const pairs: number[] = [];
    for (let e = 0; e < snapshot.edges.length; e += 2) {
      const a = this.ids.get(snapshot.paths[snapshot.edges[e]!]!)!;
      const b = this.ids.get(snapshot.paths[snapshot.edges[e + 1]!]!)!;
      const key = pairKey(a, b);
      if (this.edges.has(key)) continue;
      this.edges.set(key, [a, b]);
      pairs.push(a, b);
    }
    return Uint32Array.from(pairs);
  }

  /** The paths and positions of the placed notes, from positions by node id. */
  placed(byId: Float32Array): { paths: string[]; positions: Float32Array } {
    const paths: string[] = [];
    const positions: number[] = [];
    for (const [path, id] of this.ids) {
      const x = byId[id * 2];
      const y = byId[id * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      paths.push(path);
      positions.push(x!, y!);
    }
    return { paths, positions: Float32Array.from(positions) };
  }
}
