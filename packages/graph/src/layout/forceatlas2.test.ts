import { describe, expect, test } from 'vitest';
import { ForceAtlas2, type LayoutGraph } from './forceatlas2.ts';
import { QuadTree } from './quadtree.ts';
import { mulberry32 } from './random.ts';

/** Two cliques of `size` nodes joined by one edge. */
function cliques(size: number): LayoutGraph {
  const edges: number[] = [];
  for (const base of [0, size]) {
    for (let a = 0; a < size; a++) for (let b = a + 1; b < size; b++) edges.push(base + a, base + b);
  }
  edges.push(0, size);
  return { nodeCount: size * 2, edges: Uint32Array.from(edges) };
}

function settle(layout: ForceAtlas2): ForceAtlas2 {
  while (!layout.done) layout.step();
  return layout;
}

const distance = (p: Float32Array, a: number, b: number) =>
  Math.hypot(p[a * 2]! - p[b * 2]!, p[a * 2 + 1]! - p[b * 2 + 1]!);

/** The energy whose gradient the LinLog forces are, over every pair. */
function energy(layout: ForceAtlas2, { nodeCount, edges }: LayoutGraph): number {
  const p = layout.positions;
  const { scalingRatio, gravity } = layout.options;
  const mass = new Array<number>(nodeCount).fill(1);
  let total = 0;
  for (let e = 0; e < edges.length; e += 2) {
    mass[edges[e]!]!++;
    mass[edges[e + 1]!]!++;
    const d = distance(p, edges[e]!, edges[e + 1]!);
    total += (1 + d) * Math.log1p(d) - d;
  }
  for (let a = 0; a < nodeCount; a++) {
    total += gravity * mass[a]! * Math.hypot(p[a * 2]!, p[a * 2 + 1]!);
    for (let b = a + 1; b < nodeCount; b++) total -= scalingRatio * mass[a]! * mass[b]! * Math.log(distance(p, a, b));
  }
  return total;
}

describe('QuadTree repulsion', () => {
  const count = 600;
  const random = mulberry32(7);
  // Half spread out, half in one small clump: a deep, uneven tree.
  const positions = Float32Array.from({ length: count * 2 }, (_, i) => (random() - 0.5) * (i < count ? 1000 : 5));
  const masses = Float32Array.from({ length: count }, () => 1 + Math.floor(random() * 9));

  const bruteForce = new Float64Array(count * 2);
  for (let a = 0; a < count; a++) {
    for (let b = 0; b < count; b++) {
      if (a === b) continue;
      const dx = positions[a * 2]! - positions[b * 2]!;
      const dy = positions[a * 2 + 1]! - positions[b * 2 + 1]!;
      const factor = (2 * masses[a]! * masses[b]!) / (dx * dx + dy * dy);
      bruteForce[a * 2]! += dx * factor;
      bruteForce[a * 2 + 1]! += dy * factor;
    }
  }

  /** Mean error of the force vectors relative to their mean length. */
  function error(theta: number): number {
    const tree = new QuadTree(count);
    const forces = new Float32Array(count * 2);
    // Twice: the second build starts from the order the first one left.
    tree.build(positions, masses);
    tree.build(positions, masses);
    tree.repulsion(forces, 2, theta);
    let wrong = 0;
    let size = 0;
    for (let i = 0; i < count * 2; i += 2) {
      wrong += Math.hypot(forces[i]! - bruteForce[i]!, forces[i + 1]! - bruteForce[i + 1]!);
      size += Math.hypot(bruteForce[i]!, bruteForce[i + 1]!);
    }
    return wrong / size;
  }

  test('with theta 0 matches the sum over every pair', () => {
    expect(error(0)).toBeLessThan(1e-5);
  });

  test('approximates it more closely with a smaller theta', () => {
    expect(error(0.5)).toBeLessThan(0.02);
    expect(error(1.2)).toBeLessThan(0.1);
    expect(error(0.5)).toBeLessThan(error(1.2));
  });

  test('splits coincident bodies no further, and keeps their forces finite', () => {
    const tree = new QuadTree(100);
    const same = new Float32Array(200).fill(5);
    const forces = new Float32Array(200);
    tree.build(same, new Float32Array(100).fill(1));
    tree.repulsion(forces, 2, 1.2);
    expect(forces.every(Number.isFinite)).toBe(true);
    expect(forces.some((force) => force !== 0)).toBe(true);
  });
});

describe('ForceAtlas2', () => {
  test('separates two cliques and settles before the limit', () => {
    const layout = settle(new ForceAtlas2(cliques(12)));
    expect(layout.converged).toBe(true);
    expect(layout.iteration).toBeLessThan(layout.options.maxIterations);
    const p = layout.positions;
    let inside = 0;
    let across = 0;
    for (let a = 0; a < 12; a++) {
      for (let b = 0; b < 12; b++) {
        inside = Math.max(inside, distance(p, a, b), distance(p, a + 12, b + 12));
        across += distance(p, a, b + 12) / 144;
      }
    }
    // The cliques do not even touch.
    expect(across).toBeGreaterThan(inside);
  });

  test('lowers the energy', () => {
    const graph = cliques(10);
    const layout = new ForceAtlas2(graph);
    const initial = energy(layout, graph);
    for (let i = 0; i < 10; i++) layout.step();
    const early = energy(layout, graph);
    settle(layout);
    expect(early).toBeLessThan(initial);
    expect(energy(layout, graph)).toBeLessThan(early);
  });

  test('does not freeze around a huge hub', () => {
    // A star: the hub rests at the center, and the leaves form an even disc around it.
    const nodeCount = 500;
    const edges = Uint32Array.from({ length: (nodeCount - 1) * 2 }, (_, i) => (i % 2 ? (i >> 1) + 1 : 0));
    const layout = new ForceAtlas2({ nodeCount, edges });
    for (let i = 0; i < 150; i++) layout.step();
    // With a gravity that flips at the center, the speed collapsed to nothing by here.
    expect(layout.movement).toBeGreaterThan(layout.options.stopThreshold / 5);
    settle(layout);
    expect(layout.converged).toBe(true);
  });

  test('cools down a graph that would tremble forever', () => {
    const layout = settle(new ForceAtlas2({ nodeCount: 500, edges: new Uint32Array(0) }));
    expect(layout.converged).toBe(true);
    expect(layout.iteration).toBeLessThan(1000);
  });

  test('gives the same picture for the same seed', () => {
    const graph = cliques(10);
    const a = settle(new ForceAtlas2(graph, { seed: 3 }));
    const b = settle(new ForceAtlas2(graph, { seed: 3 }));
    const c = settle(new ForceAtlas2(graph, { seed: 4 }));
    expect(b.positions).toEqual(a.positions);
    expect(b.iteration).toBe(a.iteration);
    expect(c.positions).not.toEqual(a.positions);
  });

  test('keeps a settled layout in place when it starts from it', () => {
    const graph = cliques(10);
    const first = settle(new ForceAtlas2(graph));
    const saved = first.positions.slice();
    const again = new ForceAtlas2(graph, { seed: 99 });
    expect(again.positions).not.toEqual(saved);
    const restarted = new ForceAtlas2({ ...graph, positions: saved });
    expect(restarted.positions).toEqual(saved);
    settle(restarted);
    expect(restarted.iteration).toBeLessThan(50);
    const size = distance(saved, 0, 10);
    for (let i = 0; i < 20; i++) {
      const drift = Math.hypot(restarted.positions[i * 2]! - saved[i * 2]!, restarted.positions[i * 2 + 1]! - saved[i * 2 + 1]!);
      expect(drift).toBeLessThan(size * 0.05);
    }
  });

  test('goes on from positions saved half-way', () => {
    const graph = cliques(10);
    const half = new ForceAtlas2(graph);
    for (let i = 0; i < 5; i++) half.step();
    const resumed = settle(new ForceAtlas2({ ...graph, positions: half.positions.slice() }));
    expect(resumed.iteration).toBeGreaterThan(20);
    expect(distance(resumed.positions, 0, 10)).toBeGreaterThan(distance(half.positions, 0, 10) * 1.5);
  });

  test('places nodes that have no saved position', () => {
    const positions = new Float32Array(8).fill(NaN);
    positions.set([100, 100]);
    const layout = new ForceAtlas2({ nodeCount: 4, edges: Uint32Array.of(0, 1), positions });
    expect(Array.from(layout.positions.subarray(0, 2))).toEqual([100, 100]);
    expect(layout.positions.every(Number.isFinite)).toBe(true);
  });

  test('pulls nodes saved on one point apart', () => {
    const layout = new ForceAtlas2({ nodeCount: 50, edges: new Uint32Array(0), positions: new Float32Array(100) });
    const points = new Set(Array.from({ length: 50 }, (_, i) => `${layout.positions[i * 2]},${layout.positions[i * 2 + 1]}`));
    expect(points.size).toBe(50);
  });

  test('draws strong edges shorter', () => {
    // A path 0 - 1 - 2.
    const layout = settle(
      new ForceAtlas2({ nodeCount: 3, edges: Uint32Array.of(0, 1, 1, 2), weights: Float32Array.of(10, 1) }),
    );
    expect(distance(layout.positions, 0, 1)).toBeLessThan(distance(layout.positions, 1, 2) / 2);
  });

  test('survives self-loops, bad weights and tiny graphs', () => {
    const odd = settle(
      new ForceAtlas2({ nodeCount: 2, edges: Uint32Array.of(0, 0, 0, 1), weights: Float32Array.of(1, NaN) }),
    );
    expect(odd.positions.every(Number.isFinite)).toBe(true);
    const single = settle(new ForceAtlas2({ nodeCount: 1, edges: new Uint32Array(0) }));
    expect(single.positions.every(Number.isFinite)).toBe(true);
    expect(new ForceAtlas2({ nodeCount: 0, edges: new Uint32Array(0) }).done).toBe(true);
  });

  test('stops at maxIterations', () => {
    const layout = settle(new ForceAtlas2(cliques(5), { maxIterations: 3 }));
    expect([layout.iteration, layout.converged]).toEqual([3, false]);
  });

  test('refuses a graph that does not fit together', () => {
    const edges = Uint32Array.of(0, 2);
    expect(() => new ForceAtlas2({ nodeCount: 2, edges })).toThrow(RangeError);
    expect(() => new ForceAtlas2({ nodeCount: 3, edges: Uint32Array.of(0) })).toThrow(RangeError);
    expect(() => new ForceAtlas2({ nodeCount: 3, edges, weights: new Float32Array(2) })).toThrow(RangeError);
    expect(() => new ForceAtlas2({ nodeCount: 3, edges, positions: new Float32Array(2) })).toThrow(RangeError);
  });
});
