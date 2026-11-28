// The note path <-> graph node id map, and what the graph has to change to follow the
// index. Ids are session-local (`docs/graph-lib.md`, rule 8); paths are the keys. Plain TS.
import type { GraphDelta, GraphSnapshot } from '../shared/ipc';

export interface GraphChanges {
  /** Pairs `[s0, t0, ...]` that are no longer links. Applied first, while their nodes live. */
  removeEdges: Uint32Array;
  /** Applied second. */
  removeNodes: number[];
  /** Added third; `assign` takes the ids the graph gives them, in this order. */
  addNodes: { paths: string[]; positions: Float32Array };
}

/** Marks a node whose communities are not saved. */
const UNSAVED = 0xfffffffe;

/**
 * Which nodes have communities that differ from the saved ones, so that a computation
 * saves what it changed and not the whole vault.
 */
export class SavedCommunities {
  private levels: Uint32Array[] | null = null;

  /** What is saved, by node id: from a load, or `null` for nothing. */
  reset(levels: Uint32Array[] | null): void {
    this.levels = levels?.map((level) => level.slice()) ?? null;
  }

  /** A node that is new, or took the slot of another, has nothing saved. */
  forget(ids: ArrayLike<number>): void {
    for (const level of this.levels ?? []) {
      for (let i = 0; i < ids.length; i++) if (ids[i]! < level.length) level[ids[i]!] = UNSAVED;
    }
  }

  /** The nodes to save for `next`, which counts as saved from now on. */
  changed(next: Uint32Array[]): number[] {
    const before = this.levels;
    const nodes: number[] = [];
    // Another number of levels: every row has to say so.
    const all = !before || before.length !== next.length;
    for (let id = 0; id < next[0]!.length; id++) {
      if (all || next.some((level, depth) => before![depth]![id] !== level[id])) nodes.push(id);
    }
    this.reset(next);
    return nodes;
  }
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

  /** What a delta asks of the graph. The nodes it drops are forgotten here. */
  apply(delta: GraphDelta): GraphChanges {
    const dropped: number[] = [];
    for (const [from, to] of delta.removedEdges) {
      const a = this.ids.get(from);
      const b = this.ids.get(to);
      if (a === undefined || b === undefined) continue;
      const key = pairKey(a, b);
      const pair = this.edges.get(key);
      if (!pair) continue;
      dropped.push(...pair);
      this.edges.delete(key);
    }
    const removeNodes: number[] = [];
    for (const path of delta.removed) {
      const id = this.ids.get(path);
      if (id !== undefined) removeNodes.push(id);
    }
    if (removeNodes.length > 0) {
      // Their pairs go with them: a reused id must not look linked.
      const gone = new Set(removeNodes);
      for (const [key, [a, b]] of this.edges) if (gone.has(a) || gone.has(b)) this.edges.delete(key);
      for (const id of removeNodes) {
        this.ids.delete(this.paths[id]!);
        this.paths[id] = undefined;
      }
    }
    const added: string[] = [];
    const positions: number[] = [];
    delta.added.forEach((path, i) => {
      // A note renamed in the app already has its node.
      if (this.ids.has(path)) return;
      added.push(path);
      positions.push(delta.positions[i * 2]!, delta.positions[i * 2 + 1]!);
    });
    return {
      removeEdges: Uint32Array.from(dropped),
      removeNodes,
      addNodes: { paths: added, positions: Float32Array.from(positions) },
    };
  }

  /** Takes the ids of the added nodes and returns the new pairs to add, by id. */
  assign(delta: GraphDelta, added: string[], ids: ArrayLike<number>): Uint32Array {
    added.forEach((path, i) => {
      this.ids.set(path, ids[i]!);
      this.paths[ids[i]!] = path;
    });
    const pairs: number[] = [];
    for (const [from, to] of delta.addedEdges) {
      const a = this.ids.get(from);
      const b = this.ids.get(to);
      if (a === undefined || b === undefined) continue;
      const key = pairKey(a, b);
      if (this.edges.has(key)) continue;
      this.edges.set(key, [a, b]);
      pairs.push(a, b);
    }
    return Uint32Array.from(pairs);
  }

  /** The notes of these nodes with their communities, from levels by node id. */
  grouped(byId: Uint32Array[], nodes: number[]): { paths: string[]; levels: Uint32Array[] } {
    const known = nodes.filter((id) => this.paths[id] !== undefined);
    return {
      paths: known.map((id) => this.paths[id]!),
      levels: byId.map((level) => Uint32Array.from(known, (id) => level[id]!)),
    };
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
