import { describe, expect, test } from 'vitest';
import { relax } from './layout/relax.ts';
import { GraphStore } from './store.ts';

const pairsOf = (store: GraphStore) =>
  Array.from({ length: store.edgeCount }, (_, e) => `${store.ends[e * 2]}-${store.ends[e * 2 + 1]}`).sort();

describe('GraphStore', () => {
  test('keeps edges dense and found by their pair through removals', () => {
    const store = new GraphStore();
    store.load({ nodeCount: 5, edges: Uint32Array.of(0, 1, 1, 2, 2, 3, 3, 4, 4, 0) });
    store.removeEdges(Uint32Array.of(0, 1));
    expect(pairsOf(store)).toEqual(['1-2', '2-3', '3-4', '4-0']);
    store.removeNodes([2]);
    expect(pairsOf(store)).toEqual(['3-4', '4-0']);
    store.updateWeights(Uint32Array.of(4, 0), Float32Array.of(3));
    store.removeEdges(Uint32Array.of(3, 4));
    expect(pairsOf(store)).toEqual(['4-0']);
    expect(store.weights[0]).toBe(3);
    expect(store.neighbors(0)).toEqual([4]);
    expect(store.neighbors(3)).toEqual([]);
  });

  test('matches a from-scratch graph after many random changes', () => {
    const store = new GraphStore();
    store.load({ nodeCount: 30, edges: new Uint32Array(0) });
    const wanted = new Set<string>();
    const alive = new Set(Array.from({ length: 30 }, (_, i) => i));
    let seed = 7;
    const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let step = 0; step < 600; step++) {
      const ids = [...alive];
      const a = ids[random(ids.length)]!;
      const b = ids[random(ids.length)]!;
      const kind = random(10);
      if (kind < 5) {
        store.addEdges(Uint32Array.of(a, b));
        wanted.add(`${a}-${b}`);
      } else if (kind < 7) {
        store.removeEdges(Uint32Array.of(a, b));
        wanted.delete(`${a}-${b}`);
      } else if (kind < 8 && alive.size > 5) {
        store.removeNodes([a]);
        alive.delete(a);
        for (const pair of wanted) if (pair.split('-').map(Number).includes(a)) wanted.delete(pair);
      } else {
        alive.add(store.addNodes(1)[0]!);
      }
    }
    expect(pairsOf(store)).toEqual([...wanted].sort());
    for (const id of alive) {
      const expected = [...wanted].flatMap((pair) => {
        const [from, to] = pair.split('-').map(Number) as [number, number];
        return from === id ? [to] : to === id ? [from] : [];
      });
      expect([...new Set(store.neighbors(id))].sort()).toEqual([...new Set(expected)].sort());
    }
  });

  test('grows by doubling and says when everything has to be uploaded again', () => {
    const store = new GraphStore();
    store.load({ nodeCount: 10, edges: new Uint32Array(0) });
    store.takeChanges();
    store.addNodes(3);
    expect(store.takeChanges()).toEqual({ grown: false, nodes: [10, 13], edges: null });
    store.addNodes(10);
    expect(store.takeChanges().grown).toBe(true);
    expect(store.radii.length).toBe(32);
  });
});

describe('relax', () => {
  test('places a new node by its neighbors and moves nothing else', () => {
    const positions = Float32Array.of(0, 0, 200, 0, 1000, 1000, NaN, NaN);
    const before = positions.slice(0, 6);
    relax({
      nodeCount: 4,
      alive: Uint8Array.of(1, 1, 1, 1),
      edges: Uint32Array.of(0, 3, 1, 3),
      positions,
      movable: Uint32Array.of(3),
      temperatures: Float32Array.of(1),
    });
    expect(positions.slice(0, 6)).toEqual(before);
    const [x, y] = [positions[6]!, positions[7]!];
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    expect(Math.hypot(x - 100, y)).toBeLessThan(500);
  });

  test('places a chain of new nodes, and an unlinked one, ignoring empty slots', () => {
    const positions = Float32Array.of(0, 0, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN);
    relax({
      nodeCount: 5,
      alive: Uint8Array.of(1, 1, 1, 1, 0),
      edges: Uint32Array.of(0, 1, 1, 2),
      positions,
      movable: Uint32Array.of(2, 1, 3),
      temperatures: Float32Array.of(1, 1, 1),
    });
    expect([...positions.slice(0, 8)].every(Number.isFinite)).toBe(true);
    expect([...positions.slice(0, 2)]).toEqual([0, 0]);
  });
});
