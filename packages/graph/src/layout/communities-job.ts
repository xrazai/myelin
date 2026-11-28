// Communities as the worker answers them: detected, given the ids they had and the colors
// to draw them in. All of it grows with the graph, so none of it runs on the main thread.

import { keepIds, NO_COMMUNITY } from '../communities.ts';
import { communityColors } from '../constellations.ts';
import { leiden, type CommunityGraph } from './leiden.ts';
import type { Naming } from './protocol.ts';

export interface Named {
  levels: Uint32Array[];
  nextId: number;
  /** `[coarsest, finest]`; empty without naming. */
  colors: Float32Array[];
}

export function nameCommunities(graph: CommunityGraph, naming?: Naming): Named {
  const found = leiden(graph);
  if (!naming) return { levels: found, nextId: 0, colors: [] };
  const { previous, alive, palette, capacity } = naming;
  for (const level of found) {
    for (let id = 0; id < level.length; id++) if (!alive[id]) level[id] = NO_COMMUNITY;
  }
  const { assignment, nextId } = keepIds(previous && { levels: previous }, found, naming.nextId);
  const weights = graph.weights ?? new Float32Array(graph.edges.length / 2).fill(1);
  const colors = [assignment.levels.at(-1)!, assignment.levels[0]!].map((level) =>
    communityColors(level, graph.edges, weights, graph.edges.length / 2, palette, capacity),
  );
  return { levels: assignment.levels, nextId, colors };
}
