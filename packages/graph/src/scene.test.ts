import { describe, expect, test } from 'vitest';
import { buildScene, createStyle, NODE_RADIUS, parseColor, strength } from './scene.ts';

describe('scene', () => {
  test('a weight maps to a strength in 0..1 that grows with it', () => {
    expect([0, 1, 3, Infinity].map(strength)).toEqual([0, 0.5, 0.75, 1]);
    expect([-1, NaN].map(strength)).toEqual([0, 0]);
  });

  test('edges without weights count as weight 1', () => {
    const scene = buildScene({ nodeCount: 2, edges: Uint32Array.of(0, 1) });
    expect([...scene.strengths]).toEqual([0.5]);
    expect([...scene.states]).toEqual([0, 0]);
  });

  test('nodes with more links are larger; a self-loop adds nothing', () => {
    const { radii } = buildScene({ nodeCount: 4, edges: Uint32Array.of(0, 1, 0, 2, 3, 3) });
    expect(radii[0]).toBeGreaterThan(radii[1]!);
    expect(radii[1]).toBe(radii[2]);
    expect(radii[3]).toBe(NODE_RADIUS);
  });

  test('states are kept within 0..1, and the caller’s arrays are copied', () => {
    const edges = Uint32Array.of(0, 1);
    const scene = buildScene({ nodeCount: 4, edges, states: Float32Array.of(-1, 0.5, 7, NaN) });
    expect([...scene.states]).toEqual([0, 0.5, 1, 0]);
    edges[0] = 1;
    expect(scene.edges[0]).toBe(0);
  });

  test('arrays of the wrong length are refused', () => {
    expect(() => buildScene({ nodeCount: 3, edges: new Uint32Array(0), states: new Float32Array(2) })).toThrow(
      /states/,
    );
  });

  test('colors are hex only', () => {
    expect(parseColor('#fff')).toEqual([1, 1, 1]);
    expect(parseColor('#336699')).toEqual([0.2, 0.4, 0.6]);
    for (const bad of ['white', '#ffff', 'rgb(0,0,0)', '336699']) expect(() => parseColor(bad)).toThrow(RangeError);
  });

  test('the host’s colors replace the defaults one by one', () => {
    const style = createStyle({ node: '#ff0000' });
    expect(style.node).toEqual([1, 0, 0]);
    expect(style.background).toEqual(createStyle().background);
  });
});
