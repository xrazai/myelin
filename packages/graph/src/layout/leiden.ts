// Hierarchical community detection: Leiden (Traag, Waltman and van Eck, Sci Rep 2019,
// doi:10.1038/s41598-019-41695-z), optimizing modularity. Typed arrays only, no object
// per node. Every community is connected: refinement only joins linked groups, and each
// level is made of whole groups of the level below.

import { mulberry32 } from './random.ts';

export interface CommunityGraph {
  nodeCount: number;
  /** `[source0, target0, source1, target1, ...]`, either direction. */
  edges: Uint32Array;
  /** One per edge; 1 when absent. */
  weights?: Float32Array;
}

export interface LeidenOptions {
  /** Above 1: more, smaller communities. */
  resolution?: number;
  seed?: number;
}

/** An undirected weighted graph in compressed rows. */
interface Csr {
  count: number;
  start: Uint32Array;
  to: Uint32Array;
  weight: Float64Array;
  /** Weighted degree, self-loops counted twice. */
  strength: Float64Array;
}

/** Builds rows from pairs; repeated pairs add up, self-loops only add to the strength. */
function toCsr(count: number, pairs: Uint32Array, weights: ArrayLike<number> | undefined, selves?: Float64Array): Csr {
  const strength = new Float64Array(count);
  if (selves) for (let i = 0; i < count; i++) strength[i] = 2 * selves[i]!;
  const start = new Uint32Array(count + 1);
  const edges = pairs.length / 2;
  const usable = (e: number) => {
    const w = weights ? weights[e]! : 1;
    return w > 0 && w < Infinity;
  };
  for (let e = 0; e < edges; e++) {
    const a = pairs[e * 2]!;
    const b = pairs[e * 2 + 1]!;
    if (!usable(e) || a === b) continue;
    start[a + 1]!++;
    start[b + 1]!++;
  }
  for (let i = 0; i < count; i++) start[i + 1]! += start[i]!;
  const at = start.slice(0, count);
  const to = new Uint32Array(start[count]!);
  const weight = new Float64Array(start[count]!);
  for (let e = 0; e < edges; e++) {
    const a = pairs[e * 2]!;
    const b = pairs[e * 2 + 1]!;
    if (!usable(e) || a === b) continue;
    const w = weights ? weights[e]! : 1;
    to[at[a]!] = b;
    weight[at[a]!++] = w;
    to[at[b]!] = a;
    weight[at[b]!++] = w;
    strength[a]! += w;
    strength[b]! += w;
  }
  return { count, start, to, weight, strength };
}

function shuffled(count: number, random: () => number): Uint32Array {
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  return order;
}

/** Sums, per community, the weights from one node to its neighbors. Reused between nodes. */
class Tally {
  readonly weight: Float64Array;
  readonly seen: Uint32Array;
  size = 0;
  constructor(count: number) {
    this.weight = new Float64Array(count);
    this.seen = new Uint32Array(count);
  }
  add(community: number, weight: number): void {
    if (this.weight[community] === 0) this.seen[this.size++] = community;
    this.weight[community]! += weight;
  }
  clear(): void {
    for (let i = 0; i < this.size; i++) this.weight[this.seen[i]!] = 0;
    this.size = 0;
  }
}

/** Moves nodes to the neighbor community that gains most, until none gains. */
function moveNodes(g: Csr, community: Uint32Array, gamma: number, random: () => number): boolean {
  const total = new Float64Array(g.count);
  for (let i = 0; i < g.count; i++) total[community[i]!]! += g.strength[i]!;
  const sizes = new Uint32Array(g.count);
  for (let i = 0; i < g.count; i++) sizes[community[i]!]!++;
  const empty: number[] = [];
  for (let c = 0; c < g.count; c++) if (sizes[c] === 0) empty.push(c);
  // A ring of nodes to look at; a node is in it once.
  const queue = shuffled(g.count, random);
  const waiting = new Uint8Array(g.count).fill(1);
  const tally = new Tally(g.count);
  let head = 0;
  let length = g.count;
  let moved = false;
  while (length > 0) {
    const node = queue[head]!;
    head = (head + 1) % g.count;
    length--;
    waiting[node] = 0;
    const own = community[node]!;
    const k = g.strength[node]!;
    tally.clear();
    for (let at = g.start[node]!; at < g.start[node + 1]!; at++) tally.add(community[g.to[at]!]!, g.weight[at]!);
    total[own]! -= k;
    sizes[own]!--;
    let best = own;
    let bestGain = tally.weight[own]! - gamma * k * total[own]!;
    for (let i = 0; i < tally.size; i++) {
      const candidate = tally.seen[i]!;
      const gain = tally.weight[candidate]! - gamma * k * total[candidate]!;
      if (gain > bestGain + 1e-12) {
        best = candidate;
        bestGain = gain;
      }
    }
    // Alone is better than any of them.
    if (bestGain < -1e-12 && sizes[own]! > 0) best = empty.pop()!;
    total[best]! += k;
    sizes[best]!++;
    if (best === own) continue;
    if (sizes[own] === 0) empty.push(own);
    community[node] = best;
    moved = true;
    for (let at = g.start[node]!; at < g.start[node + 1]!; at++) {
      const other = g.to[at]!;
      if (community[other] !== best && !waiting[other]) {
        waiting[other] = 1;
        queue[(head + length) % g.count] = other;
        length++;
      }
    }
  }
  return moved;
}

/** Splits each community into connected, well-knit groups, joining only along edges. */
function refine(g: Csr, community: Uint32Array, gamma: number, random: () => number): Uint32Array {
  const refined = new Uint32Array(g.count);
  const total = new Float64Array(g.count);
  const alone = new Uint8Array(g.count).fill(1);
  for (let i = 0; i < g.count; i++) {
    refined[i] = i;
    total[i] = g.strength[i]!;
  }
  const tally = new Tally(g.count);
  for (const node of shuffled(g.count, random)) {
    if (!alone[node]) continue;
    const k = g.strength[node]!;
    tally.clear();
    for (let at = g.start[node]!; at < g.start[node + 1]!; at++) {
      const other = g.to[at]!;
      if (community[other] === community[node]) tally.add(refined[other]!, g.weight[at]!);
    }
    let best = -1;
    let bestGain = 1e-12;
    for (let i = 0; i < tally.size; i++) {
      const candidate = tally.seen[i]!;
      const gain = tally.weight[candidate]! - gamma * k * total[candidate]!;
      if (gain > bestGain) {
        best = candidate;
        bestGain = gain;
      }
    }
    if (best === -1) continue;
    total[best]! += k;
    total[refined[node]!]! -= k;
    refined[node] = best;
    alone[node] = 0;
    // What was joined is no longer alone, so it never leaves the group.
    alone[best] = 0;
  }
  return refined;
}

/** Numbers the labels 0, 1, 2... in order of first use. Returns how many there are. */
function renumber(labels: Uint32Array): number {
  const map = new Int32Array(labels.length).fill(-1);
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    if (map[labels[i]!] === -1) map[labels[i]!] = count++;
    labels[i] = map[labels[i]!]!;
  }
  return count;
}

/**
 * The communities of every node, one array per level, the finest first. Labels are
 * `0..n-1` within a level, and each community is part of one community of the next level.
 */
export function leiden({ nodeCount, edges, weights }: CommunityGraph, options: LeidenOptions = {}): Uint32Array[] {
  const { resolution = 1, seed = 1 } = options;
  const random = mulberry32(seed);
  if (nodeCount === 0) return [new Uint32Array(0)];
  let g = toCsr(nodeCount, edges, weights);
  const total = g.strength.reduce((sum, value) => sum + value, 0);
  const gamma = total > 0 ? resolution / total : 0;
  /** The aggregate node each original node is in. */
  const member = new Uint32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) member[i] = i;
  let community = new Uint32Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) community[i] = i;
  const levels: Uint32Array[] = [];
  let previous = nodeCount;

  for (;;) {
    moveNodes(g, community, gamma, random);
    const labels = community.slice();
    // Every community is one node of this graph: nothing left to join.
    if (renumber(labels) === g.count) break;
    const refined = refine(g, community, gamma, random);
    const count = renumber(refined);
    // Refinement joined nothing: aggregating would repeat this graph forever.
    if (count === g.count) break;
    for (let i = 0; i < nodeCount; i++) member[i] = refined[member[i]!]!;
    if (count < previous) levels.push(member.slice());
    previous = count;

    // The aggregate: one node per refined group, starting in the community it came from.
    const selves = new Float64Array(count);
    const inner = new Float64Array(count);
    const pairs: number[] = [];
    const sums: number[] = [];
    const next = new Uint32Array(count);
    const strength = new Float64Array(count);
    for (let i = 0; i < g.count; i++) {
      next[refined[i]!] = labels[i]!;
      strength[refined[i]!]! += g.strength[i]!;
      for (let at = g.start[i]!; at < g.start[i + 1]!; at++) {
        const j = g.to[at]!;
        if (j < i) continue;
        const a = refined[i]!;
        const b = refined[j]!;
        if (a === b) inner[a]! += g.weight[at]!;
        else {
          pairs.push(a, b);
          sums.push(g.weight[at]!);
        }
      }
    }
    for (let c = 0; c < count; c++) selves[c] = inner[c]!;
    g = toCsr(count, Uint32Array.from(pairs), sums, selves);
    g.strength.set(strength);
    renumber(next);
    community = next;
  }
  if (levels.length === 0) {
    const flat = community.slice();
    const out = new Uint32Array(nodeCount);
    for (let i = 0; i < nodeCount; i++) out[i] = flat[member[i]!]!;
    renumber(out);
    levels.push(out);
  }
  return levels;
}
