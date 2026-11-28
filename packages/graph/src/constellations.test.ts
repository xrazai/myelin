import { describe, expect, test } from 'vitest';
import { NO_COMMUNITY } from './communities.ts';
import { communityColors, constellations, NO_COLOR, zoomView } from './constellations.ts';
import { Effects, PULSE_MS } from './effects.ts';

describe('semantic zoom', () => {
  test('far shows the subjects, between their parts and the hubs, near only notes', () => {
    expect(zoomView(0.03)).toEqual({ coarse: 1, fine: 0, names: 'coarse', nodeLabels: 0 });
    const between = zoomView(0.25);
    expect(between).toMatchObject({ coarse: 0, fine: 1, names: 'fine' });
    expect(between.nodeLabels).toBeGreaterThan(0);
    expect(zoomView(1)).toEqual({ coarse: 0, fine: 0, names: null, nodeLabels: null });
  });

  test('the glow crosses over without a jump', () => {
    for (let zoom = 0.05; zoom < 0.8; zoom += 0.002) {
      const a = zoomView(zoom);
      const b = zoomView(zoom + 0.002);
      expect(Math.abs(a.coarse - b.coarse)).toBeLessThan(0.05);
      expect(Math.abs(a.fine - b.fine)).toBeLessThan(0.05);
    }
  });
});

describe('constellations', () => {
  // Three groups of three that link in a triangle, a pair and a removed slot. With two
  // colors for ids 0, 2 and 4, their own colors would all be the same.
  const level = Uint32Array.of(0, 0, 0, 2, 2, 2, 4, 4, 4, 5, 5, NO_COMMUNITY);
  const edges = Uint32Array.of(2, 3, 5, 6, 8, 0);

  test('linked communities take different colors where the palette allows', () => {
    const colors = communityColors(level, edges, Float32Array.of(1, 1, 1), 3, 3, 16);
    const of = [colors[0], colors[3], colors[6]];
    expect(new Set(of).size).toBe(3);
    expect([...colors.slice(0, 3)]).toEqual([of[0], of[0], of[0]]);
    // Too small, removed, and slots past the level.
    expect([...colors.slice(9)]).toEqual(Array(7).fill(NO_COLOR));
    const two = communityColors(level, edges, Float32Array.of(5, 1, 1), 3, 2, 12);
    expect(two[0]).not.toBe(two[3]);
  });

  test('are centered on their placed nodes and named by the best linked', () => {
    const positions = new Float32Array(24).fill(NaN);
    positions.set([0, 0, 3, 0, 0, 3]);
    const radii = new Float32Array(12).fill(14);
    radii[1] = 30;
    expect(constellations(level, positions, radii)).toEqual([{ id: 0, size: 3, topNode: 1, x: 1, y: 1 }]);
  });
});

describe('effects end', () => {
  test('breathing fades to a stop', () => {
    const effects = new Effects();
    expect(effects.moving(0)).toBe(false);
    effects.breathe(1000);
    expect(effects.breath(1500)).toBeGreaterThan(0.8);
    expect(effects.moving(1500)).toBe(true);
    expect(effects.breath(8000)).toBe(0);
    expect(effects.moving(8000)).toBe(false);
  });

  test('a pulse travels and is gone', () => {
    const effects = new Effects();
    effects.pulse(1, 2, 0);
    const half = effects.beams(PULSE_MS / 2);
    expect([half.count, ...half.ends]).toEqual([1, 1, 2]);
    expect(half.progress[1]).toBe(0);
    expect(effects.beams(PULSE_MS).count).toBe(0);
    expect(effects.moving(PULSE_MS)).toBe(false);
  });

  test('the cascade lights neighbors one after the other, stays, and stops asking for frames', () => {
    const effects = new Effects();
    effects.hover(0, [1, 2, 3], 0);
    const early = effects.beams(100).progress;
    expect(early[0]!).toBeGreaterThan(early[4]!);
    expect(effects.moving(100)).toBe(true);
    expect([...effects.beams(5000).progress]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(effects.moving(5000)).toBe(false);
    effects.forget((id) => id !== 2);
    expect(effects.beams(5000).count).toBe(2);
    effects.hover(null, [], 6000);
    expect(effects.beams(6000).count).toBe(0);
  });
});
