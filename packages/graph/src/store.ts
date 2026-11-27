// The graph as it changes: node slots with tombstones and a free list, edges kept dense and
// found by their (source, target) pair. Arrays grow by doubling; what changed since the
// last `takeChanges` is tracked, so that only that goes to the GPU. Plain TS.

import type { Scene } from './backend/backend.ts';
import { edgeRadius, strength, type SceneInput } from './scene.ts';

/** `[from, to)` of the slots that changed. */
export type Range = [number, number];

export interface Changes {
  /** The arrays grew: everything has to be uploaded again. */
  grown: boolean;
  nodes: Range | null;
  edges: Range | null;
}

const MIN_CAPACITY = 16;

function grow<T extends Float32Array | Uint32Array | Uint8Array>(array: T, length: number): T {
  const next = new (array.constructor as new (length: number) => T)(length);
  next.set(array);
  return next;
}

const key = (source: number, target: number) => `${source},${target}`;

export class GraphStore {
  /** Node slots in use, tombstones included: ids are below this. */
  nodeCount = 0;
  edgeCount = 0;
  alive = new Uint8Array(MIN_CAPACITY);
  /** Degree without self-loops. */
  private degrees = new Uint32Array(MIN_CAPACITY);
  states = new Float32Array(MIN_CAPACITY);
  radii = new Float32Array(MIN_CAPACITY);
  /** `[x0, y0, ...]`; NaN for a node not placed yet. */
  positions = new Float32Array(MIN_CAPACITY * 2);
  ends = new Uint32Array(MIN_CAPACITY * 2);
  weights = new Float32Array(MIN_CAPACITY);
  private strengths = new Float32Array(MIN_CAPACITY);
  private readonly edgeSlots = new Map<string, number>();
  /** Edge slots of each node. */
  private incident: Set<number>[] = [];
  private free: number[] = [];
  private changes: Changes = { grown: true, nodes: null, edges: null };

  /** Full load: resets ids. The input is already checked; the caller keeps its arrays. */
  load({ nodeCount, edges, weights, states }: SceneInput, positions?: Float32Array): void {
    this.nodeCount = 0;
    this.edgeCount = 0;
    this.edgeSlots.clear();
    this.incident = [];
    this.free = [];
    this.reserveNodes(nodeCount);
    this.reserveEdges(edges.length / 2);
    this.nodeCount = nodeCount;
    for (let id = 0; id < nodeCount; id++) {
      this.incident[id] = new Set();
      this.alive[id] = 1;
      this.degrees[id] = 0;
      this.states[id] = clampState(states?.[id] ?? 0);
      const x = positions?.[id * 2] ?? NaN;
      const y = positions?.[id * 2 + 1] ?? NaN;
      const known = Number.isFinite(x) && Number.isFinite(y);
      this.positions[id * 2] = known ? x : NaN;
      this.positions[id * 2 + 1] = known ? y : NaN;
      this.radii[id] = edgeRadius(0);
    }
    // A pair given twice stays two edges on load: the first one answers to the pair.
    for (let e = 0; e < edges.length / 2; e++) {
      this.insertEdge(edges[e * 2]!, edges[e * 2 + 1]!, weights?.[e] ?? 1);
    }
    this.changes = { grown: true, nodes: null, edges: null };
  }

  isAlive(id: number): boolean {
    return id < this.nodeCount && this.alive[id] === 1;
  }

  private check(ids: ArrayLike<number>): void {
    for (let i = 0; i < ids.length; i++) {
      if (!this.isAlive(ids[i]!)) throw new RangeError(`there is no node ${ids[i]}`);
    }
  }

  private checkPairs(pairs: Uint32Array): void {
    if (pairs.length % 2 !== 0) throw new RangeError('edges must hold pairs');
    this.check(pairs);
  }

  addNodes(count: number, { positions, states }: { positions?: Float32Array; states?: Float32Array } = {}): Uint32Array {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be an integer >= 0');
    if (positions && positions.length !== count * 2) throw new RangeError('positions must hold two values per node');
    if (states && states.length !== count) throw new RangeError('states must hold one value per node');
    this.reserveNodes(this.nodeCount + Math.max(0, count - this.free.length));
    const ids = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const id = this.free.pop() ?? this.nodeCount++;
      ids[i] = id;
      this.incident[id] = new Set();
      this.alive[id] = 1;
      this.degrees[id] = 0;
      this.states[id] = clampState(states?.[i] ?? 0);
      this.radii[id] = edgeRadius(0);
      this.positions[id * 2] = positions?.[i * 2] ?? NaN;
      this.positions[id * 2 + 1] = positions?.[i * 2 + 1] ?? NaN;
      this.touchNode(id);
    }
    return ids;
  }

  /** Removed nodes become tombstones; their edges go with them. */
  removeNodes(ids: ArrayLike<number>): void {
    this.check(ids);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      // Given twice.
      if (!this.alive[id]) continue;
      // From the highest slot: removing moves the last edge into the freed one.
      for (const slot of [...this.incident[id]!].sort((a, b) => b - a)) this.deleteEdge(slot);
      this.alive[id] = 0;
      this.radii[id] = 0;
      this.states[id] = 0;
      this.positions[id * 2] = NaN;
      this.positions[id * 2 + 1] = NaN;
      this.free.push(id);
      this.touchNode(id);
    }
  }

  /** A pair that is there already gets the new weight. */
  addEdges(pairs: Uint32Array, weights?: Float32Array): void {
    this.checkPairs(pairs);
    if (weights && weights.length !== pairs.length / 2) throw new RangeError('weights must hold one value per edge');
    this.reserveEdges(this.edgeCount + pairs.length / 2);
    for (let e = 0; e < pairs.length / 2; e++) {
      const source = pairs[e * 2]!;
      const target = pairs[e * 2 + 1]!;
      const weight = weights ? weights[e]! : 1;
      const slot = this.edgeSlots.get(key(source, target));
      if (slot === undefined) this.insertEdge(source, target, weight);
      else this.setWeight(slot, weight);
    }
  }

  /** A pair that is not there is ignored. */
  removeEdges(pairs: Uint32Array): void {
    this.checkPairs(pairs);
    for (let e = 0; e < pairs.length / 2; e++) {
      const slot = this.edgeSlots.get(key(pairs[e * 2]!, pairs[e * 2 + 1]!));
      if (slot !== undefined) this.deleteEdge(slot);
    }
  }

  updateWeights(pairs: Uint32Array, weights: Float32Array): void {
    this.checkPairs(pairs);
    if (weights.length !== pairs.length / 2) throw new RangeError('weights must hold one value per edge');
    for (let e = 0; e < weights.length; e++) {
      const slot = this.edgeSlots.get(key(pairs[e * 2]!, pairs[e * 2 + 1]!));
      if (slot !== undefined) this.setWeight(slot, weights[e]!);
    }
  }

  updateStates(ids: ArrayLike<number>, values: Float32Array): void {
    this.check(ids);
    if (values.length !== ids.length) throw new RangeError('values must hold one value per node');
    for (let i = 0; i < ids.length; i++) {
      this.states[ids[i]!] = clampState(values[i]!);
      this.touchNode(ids[i]!);
    }
  }

  /** The nodes linked to `id`, either way. */
  neighbors(id: number): number[] {
    return [...this.incident[id]!].map((slot) => {
      const source = this.ends[slot * 2]!;
      return source === id ? this.ends[slot * 2 + 1]! : source;
    });
  }

  /** What the backend draws. The arrays are as long as the capacity; the counts say how much of them. */
  scene(): Scene {
    return {
      nodeCount: this.nodeCount,
      edgeCount: this.edgeCount,
      edges: this.ends,
      strengths: this.strengths,
      radii: this.radii,
      states: this.states,
    };
  }

  takeChanges(): Changes {
    const changes = this.changes;
    this.changes = { grown: false, nodes: null, edges: null };
    return changes;
  }

  private touchNode(id: number): void {
    const range = this.changes.nodes;
    this.changes.nodes = range ? [Math.min(range[0], id), Math.max(range[1], id + 1)] : [id, id + 1];
  }

  private touchEdge(slot: number): void {
    const range = this.changes.edges;
    this.changes.edges = range ? [Math.min(range[0], slot), Math.max(range[1], slot + 1)] : [slot, slot + 1];
  }

  private reserveNodes(count: number): void {
    let capacity = this.alive.length;
    if (count <= capacity) return;
    while (capacity < count) capacity *= 2;
    this.alive = grow(this.alive, capacity);
    this.degrees = grow(this.degrees, capacity);
    this.states = grow(this.states, capacity);
    this.radii = grow(this.radii, capacity);
    this.positions = grow(this.positions, capacity * 2);
    this.changes.grown = true;
  }

  private reserveEdges(count: number): void {
    let capacity = this.strengths.length;
    if (count <= capacity) return;
    while (capacity < count) capacity *= 2;
    this.ends = grow(this.ends, capacity * 2);
    this.weights = grow(this.weights, capacity);
    this.strengths = grow(this.strengths, capacity);
    this.changes.grown = true;
  }

  private addDegree(source: number, target: number, by: 1 | -1): void {
    // A self-loop is not drawn and links to nothing.
    if (source === target) return;
    for (const id of [source, target]) {
      this.degrees[id] = this.degrees[id]! + by;
      this.radii[id] = edgeRadius(this.degrees[id]!);
      this.touchNode(id);
    }
  }

  private insertEdge(source: number, target: number, weight: number): void {
    const slot = this.edgeCount++;
    this.ends[slot * 2] = source;
    this.ends[slot * 2 + 1] = target;
    this.weights[slot] = weight;
    this.strengths[slot] = strength(weight);
    const pair = key(source, target);
    if (!this.edgeSlots.has(pair)) this.edgeSlots.set(pair, slot);
    this.incident[source]!.add(slot);
    this.incident[target]!.add(slot);
    this.addDegree(source, target, 1);
    this.touchEdge(slot);
  }

  private setWeight(slot: number, weight: number): void {
    this.weights[slot] = weight;
    this.strengths[slot] = strength(weight);
    this.touchEdge(slot);
  }

  private deleteEdge(slot: number): void {
    const source = this.ends[slot * 2]!;
    const target = this.ends[slot * 2 + 1]!;
    if (this.edgeSlots.get(key(source, target)) === slot) this.edgeSlots.delete(key(source, target));
    this.incident[source]!.delete(slot);
    this.incident[target]!.delete(slot);
    this.addDegree(source, target, -1);
    // The last edge moves into the hole: edges stay dense for drawing.
    const last = --this.edgeCount;
    if (slot === last) return;
    const from = this.ends[last * 2]!;
    const to = this.ends[last * 2 + 1]!;
    this.ends[slot * 2] = from;
    this.ends[slot * 2 + 1] = to;
    this.weights[slot] = this.weights[last]!;
    this.strengths[slot] = this.strengths[last]!;
    if (this.edgeSlots.get(key(from, to)) === last) this.edgeSlots.set(key(from, to), slot);
    for (const id of [from, to]) {
      if (this.incident[id]!.delete(last)) this.incident[id]!.add(slot);
    }
    this.incident[to]!.add(slot);
    this.incident[from]!.add(slot);
    this.touchEdge(slot);
  }
}

const clampState = (value: number) => (value > 0 ? Math.min(1, value) : 0);
