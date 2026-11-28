import { describe, expect, test } from 'vitest';
import { describeCommunity, keepIds, NO_COMMUNITY } from './communities.ts';
import { leiden } from './layout/leiden.ts';
import { mulberry32 } from './layout/random.ts';

/** `groups` groups of `size` nodes: dense inside, a few links between. */
function planted(groups: number, size: number, inside: number, outside: number, seed = 5) {
  const random = mulberry32(seed);
  const edges: number[] = [];
  const count = groups * size;
  for (let a = 0; a < count; a++) {
    for (let b = a + 1; b < count; b++) {
      const same = Math.floor(a / size) === Math.floor(b / size);
      if (random() < (same ? inside : outside)) edges.push(a, b);
    }
  }
  return { nodeCount: count, edges: Uint32Array.from(edges) };
}

function connected(labels: Uint32Array, edges: Uint32Array): boolean {
  const parent = Array.from({ length: labels.length }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let e = 0; e < edges.length; e += 2) {
    if (labels[edges[e]!] === labels[edges[e + 1]!]) parent[find(edges[e]!)] = find(edges[e + 1]!);
  }
  const roots = new Map<number, number>();
  return labels.every((label, node) => {
    const root = find(node);
    if (!roots.has(label)) roots.set(label, root);
    return roots.get(label) === root;
  });
}

describe('leiden', () => {
  test('recovers planted groups at the top level', () => {
    const graph = planted(6, 40, 0.3, 0.005);
    const top = leiden(graph).at(-1)!;
    expect(new Set(top).size).toBe(6);
    for (let group = 0; group < 6; group++) expect(new Set(top.slice(group * 40, group * 40 + 40)).size).toBe(1);
  });

  test('every community of every level is connected and inside one of the next', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const graph = planted(5, 30, 0.08, 0.02, seed);
      const levels = leiden(graph, { seed });
      levels.forEach((labels, level) => {
        expect(connected(labels, graph.edges), `seed ${seed} level ${level}`).toBe(true);
        const above = levels[level + 1];
        if (!above) return;
        const parent = new Map<number, number>();
        labels.forEach((label, node) => {
          if (!parent.has(label)) parent.set(label, above[node]!);
          expect(parent.get(label)).toBe(above[node]);
        });
      });
    }
  });

  test('empty and unlinked graphs, self-loops and zero weights', () => {
    expect(leiden({ nodeCount: 0, edges: new Uint32Array(0) })).toEqual([new Uint32Array(0)]);
    expect([...leiden({ nodeCount: 3, edges: new Uint32Array(0) }).at(-1)!]).toEqual([0, 1, 2]);
    const odd = leiden({ nodeCount: 3, edges: Uint32Array.of(0, 0, 0, 1, 1, 2), weights: Float32Array.of(5, 1, 0) }).at(-1)!;
    expect(odd[0]).toBe(odd[1]);
    expect(odd[2]).not.toBe(odd[0]);
  });
});

describe('keepIds', () => {
  test('a community keeps its id while it keeps most of its nodes', () => {
    const first = keepIds(null, [Uint32Array.of(0, 0, 0, 1, 1, 1)], 0);
    expect([...first.assignment.levels[0]!]).toEqual([0, 0, 0, 1, 1, 1]);
    // Labels swapped and one node moved: the ids follow the nodes.
    const second = keepIds(first.assignment, [Uint32Array.of(1, 1, 1, 0, 0, 1)], first.nextId);
    expect([...second.assignment.levels[0]!]).toEqual([0, 0, 0, 1, 1, 0]);
    const split = keepIds(second.assignment, [Uint32Array.of(0, 0, 2, 1, 1, NO_COMMUNITY)], second.nextId);
    expect([...split.assignment.levels[0]!]).toEqual([0, 0, 2, 1, 1, NO_COMMUNITY]);
    expect(split.nextId).toBe(3);
  });
});

test('describeCommunity gives size, central nodes, family and neighbors', () => {
  const assignment = { levels: [Uint32Array.of(0, 0, 0, 1, 2), Uint32Array.of(3, 3, 3, 3, 4)] };
  const edges = Uint32Array.of(0, 1, 0, 2, 2, 3, 3, 4);
  const weights = Float32Array.of(1, 1, 2, 1);
  expect(describeCommunity(assignment, 0, edges, weights, 4)).toEqual({
    id: 0, level: 0, size: 3, topNodes: [0, 1, 2], parent: 3, children: [], neighbors: [{ id: 1, weight: 2 }],
  });
  expect(describeCommunity(assignment, 3, edges, weights, 4)).toMatchObject({ level: 1, size: 4, children: [0, 1], parent: null });
  expect(describeCommunity(assignment, 99, edges, weights, 4)).toBeNull();
});
