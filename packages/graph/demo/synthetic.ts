// A graph shaped like a vault of notes: groups that link mostly among themselves, a hub in
// each, a few links across groups.

import { mulberry32 } from '../src/layout/random.ts';
import type { GraphData } from '../src/index.ts';

const GROUP_SIZE = 150;
const LINKS_PER_NODE = 3;
const CROSS_GROUP_SHARE = 0.05;
const ACTIVE_SHARE = 0.03;

export function syntheticGraph(nodeCount: number, seed: number): GraphData {
  const random = mulberry32(seed);
  const edges: number[] = [];
  const weights: number[] = [];
  for (let node = 1; node < nodeCount; node++) {
    const first = node - (node % GROUP_SIZE);
    for (let link = 0; link < LINKS_PER_NODE; link++) {
      const across = node === first || random() < CROSS_GROUP_SHARE;
      // Squaring favors the first nodes of the group, which become its hubs.
      const target = across
        ? Math.floor(random() * node)
        : first + Math.floor(random() ** 2 * (node - first));
      edges.push(node, target);
      // Mostly weak edges, a few that were used a lot.
      weights.push(random() < 0.05 ? 4 + random() * 12 : 0.3 + random());
      if (node === first) break;
    }
  }
  const states = Float32Array.from({ length: nodeCount }, () => (random() < ACTIVE_SHARE ? 1 : 0));
  return { nodeCount, edges: Uint32Array.from(edges), weights: Float32Array.from(weights), states };
}
