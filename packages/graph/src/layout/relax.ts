// Local relaxation: after nodes are added, only they and their neighbors move; every
// other node stays exactly where it is. The Barnes-Hut tree of the still nodes is built
// once, so a step costs the movable nodes only. Same forces as ForceAtlas2.

import { DEFAULT_OPTIONS, type LayoutOptions } from './forceatlas2.ts';
import { QuadTree } from './quadtree.ts';
import { mulberry32 } from './random.ts';

export interface RelaxGraph {
  /** Node slots; ids are below this. */
  nodeCount: number;
  /** `0`: no node in that slot. */
  alive: Uint8Array;
  edges: Uint32Array;
  weights?: Float32Array;
  /** `[x0, y0, ...]` by slot; NaN for a node that has no place yet. */
  positions: Float32Array;
  /** Nodes that may move. Those without a place start among their neighbors. */
  movable: Uint32Array;
  /** One per movable node, 0 to 1: how freely it moves. */
  temperatures: Float32Array;
}

const STEPS = 60;
/** Furthest a node moves in the first step, in layout units. */
const MAX_STEP = 30;
const COOLING = 0.94;
/** Offset of a new node from the centroid, so that two never start on one point. */
const JITTER = 10;

/** Where each unplaced movable node starts: the centroid of its placed neighbors. */
export function placeNew(graph: RelaxGraph, seed = DEFAULT_OPTIONS.seed): void {
  const { positions, edges, movable, alive, nodeCount } = graph;
  const placed = (id: number) => Number.isFinite(positions[id * 2]!) && Number.isFinite(positions[id * 2 + 1]!);
  const random = mulberry32(seed + movable.length);
  const jitter = () => (random() - 0.5) * 2 * JITTER;

  let centerX = 0;
  let centerY = 0;
  let known = 0;
  for (let id = 0; id < nodeCount; id++) {
    if (!alive[id] || !placed(id)) continue;
    centerX += positions[id * 2]!;
    centerY += positions[id * 2 + 1]!;
    known++;
  }
  if (known > 0) {
    centerX /= known;
    centerY /= known;
  }

  let waiting = [...movable].filter((id) => !placed(id));
  // A chain of new nodes is placed from its linked end inward, one round at a time.
  while (waiting.length > 0) {
    const wanted = new Map<number, [number, number, number]>(waiting.map((id) => [id, [0, 0, 0]]));
    for (let e = 0; e < edges.length; e += 2) {
      for (const [node, other] of [[edges[e]!, edges[e + 1]!], [edges[e + 1]!, edges[e]!]]) {
        const sum = wanted.get(node!);
        if (!sum || !placed(other!)) continue;
        sum[0] += positions[other! * 2]!;
        sum[1] += positions[other! * 2 + 1]!;
        sum[2]++;
      }
    }
    const ready = waiting.filter((id) => wanted.get(id)![2] > 0);
    if (ready.length === 0) {
      // Linked to nothing placed: around the middle of the graph.
      const radius = 10 * Math.sqrt(Math.max(1, known));
      for (const id of waiting) {
        const angle = 2 * Math.PI * random();
        const distance = radius * Math.sqrt(random());
        positions[id * 2] = centerX + distance * Math.cos(angle);
        positions[id * 2 + 1] = centerY + distance * Math.sin(angle);
      }
      break;
    }
    for (const id of ready) {
      const [x, y, count] = wanted.get(id)!;
      positions[id * 2] = x / count + jitter();
      positions[id * 2 + 1] = y / count + jitter();
    }
    waiting = waiting.filter((id) => wanted.get(id)![2] === 0);
  }
}

/** Moves the movable nodes, in place. */
export function relax(graph: RelaxGraph, options: LayoutOptions = {}): void {
  const { scalingRatio, gravity, linLog, theta, edgeWeightInfluence, seed } = { ...DEFAULT_OPTIONS, ...options };
  const { positions, edges, weights, movable, temperatures, alive, nodeCount } = graph;
  placeNew(graph, seed);
  const count = movable.length;
  if (count === 0) return;

  const slot = new Int32Array(nodeCount).fill(-1);
  for (let i = 0; i < count; i++) slot[movable[i]!] = i;
  const masses = new Float32Array(nodeCount).fill(1);
  /** Edges with a movable end: only they pull. */
  const pulls: number[] = [];
  for (let e = 0; e < edges.length / 2; e++) {
    const source = edges[e * 2]!;
    const target = edges[e * 2 + 1]!;
    if (source === target) continue;
    masses[source]!++;
    masses[target]!++;
    if (slot[source]! >= 0 || slot[target]! >= 0) pulls.push(e);
  }

  // The nodes that stay, packed: their tree never changes.
  const still: number[] = [];
  for (let id = 0; id < nodeCount; id++) if (alive[id] && slot[id] === -1) still.push(id);
  const stillPositions = new Float32Array(still.length * 2);
  const stillMasses = new Float32Array(still.length);
  still.forEach((id, i) => {
    stillPositions[i * 2] = positions[id * 2]!;
    stillPositions[i * 2 + 1] = positions[id * 2 + 1]!;
    stillMasses[i] = masses[id]!;
  });
  const tree = new QuadTree(still.length);
  tree.build(stillPositions, stillMasses);

  const forces = new Float64Array(count * 2);
  const total = alive.reduce((sum, value) => sum + value, 0);
  const softening = 10 * Math.sqrt(total);
  const push = (out: number, dx: number, dy: number, strength: number) => {
    const d2 = Math.max(dx * dx + dy * dy, 1e-2);
    forces[out]! += (dx * strength) / d2;
    forces[out + 1]! += (dy * strength) / d2;
  };

  let heat = 1;
  for (let step = 0; step < STEPS; step++, heat *= COOLING) {
    forces.fill(0);
    for (let i = 0; i < count; i++) {
      const id = movable[i]!;
      const x = positions[id * 2]!;
      const y = positions[id * 2 + 1]!;
      const own = scalingRatio * masses[id]!;
      tree.repulsionAt(x, y, own, theta, forces, i * 2);
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        const other = movable[j]!;
        push(i * 2, x - positions[other * 2]!, y - positions[other * 2 + 1]!, own * masses[other]!);
      }
      const distance = Math.sqrt(x * x + y * y);
      const pull = (gravity * masses[id]!) / Math.max(distance, softening);
      forces[i * 2]! -= x * pull;
      forces[i * 2 + 1]! -= y * pull;
    }
    for (const e of pulls) {
      const source = edges[e * 2]!;
      const target = edges[e * 2 + 1]!;
      const weight = weights ? weights[e]! : 1;
      if (!(weight > 0 && weight < Infinity)) continue;
      const dx = positions[target * 2]! - positions[source * 2]!;
      const dy = positions[target * 2 + 1]! - positions[source * 2 + 1]!;
      let factor = weight ** edgeWeightInfluence;
      if (linLog) {
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance === 0) continue;
        factor *= Math.log1p(distance) / distance;
      }
      const a = slot[source]!;
      const b = slot[target]!;
      if (a >= 0) {
        forces[a * 2]! += dx * factor;
        forces[a * 2 + 1]! += dy * factor;
      }
      if (b >= 0) {
        forces[b * 2]! -= dx * factor;
        forces[b * 2 + 1]! -= dy * factor;
      }
    }
    for (let i = 0; i < count; i++) {
      const id = movable[i]!;
      const length = Math.hypot(forces[i * 2]!, forces[i * 2 + 1]!);
      if (length === 0) continue;
      // The force gives the direction; the step is capped and cools down.
      const move = Math.min(length / masses[id]!, MAX_STEP * heat * temperatures[i]!) / length;
      positions[id * 2]! += forces[i * 2]! * move;
      positions[id * 2 + 1]! += forces[i * 2 + 1]! * move;
    }
  }
}
