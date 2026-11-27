import { describe, expect, test } from 'vitest';
import { HitGrid, screenRadius } from './hit-grid.ts';
import { MAX_LABELS, placeLabels } from './labels.ts';

const style = { nodeRadius: 14, minNodeRadius: 0.9, maxNodeRadius: 32 };

/** Deterministic pseudo-random graph with a few hubs. */
function world(count: number) {
  let seed = 3;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const positions = new Float32Array(count * 2);
  const radii = new Float32Array(count);
  for (let id = 0; id < count; id++) {
    positions[id * 2] = (random() - 0.5) * 4000;
    positions[id * 2 + 1] = (random() - 0.5) * 4000;
    radii[id] = id % 97 === 0 ? 90 : 14 + random() * 20;
  }
  return { positions, radii, random };
}

describe('HitGrid', () => {
  test('finds the same node as checking every one', () => {
    const { positions, radii, random } = world(3000);
    const grid = new HitGrid(style);
    grid.build(positions, radii, 3000);
    for (let probe = 0; probe < 1500; probe++) {
      const zoom = [0.2, 0.5, 1, 4][probe % 4]!;
      const around = Math.floor(random() * 3000);
      const x = positions[around * 2]! + (random() - 0.5) * (30 / zoom);
      const y = positions[around * 2 + 1]! + (random() - 0.5) * (30 / zoom);
      let best: number | null = null;
      let distance = Infinity;
      for (let id = 0; id < 3000; id++) {
        const d = Math.hypot(positions[id * 2]! - x, positions[id * 2 + 1]! - y) * zoom;
        if (d <= screenRadius(radii[id]!, zoom, style) + 4 && d < distance) {
          best = id;
          distance = d;
        }
      }
      expect(grid.at(x, y, zoom), `probe ${probe} zoom ${zoom}`).toBe(best);
    }
  });

  test('ignores removed and unplaced nodes', () => {
    const grid = new HitGrid(style);
    grid.build(Float32Array.of(0, 0, NaN, NaN, 50, 0), Float32Array.of(0, 14, 14), 3);
    expect(grid.at(0, 0, 1)).toBeNull();
    expect(grid.at(50, 0, 1)).toBe(2);
  });
});

describe('placeLabels', () => {
  const frame = { width: 800, height: 600, pixelRatio: 1, camera: { x: 0, y: 0, zoom: 1 } };
  const place = (positions: number[], order: number[], first: number | null = null, asked: number[] = []) =>
    placeLabels({
      order,
      positions: Float32Array.from(positions),
      radii: new Float32Array(positions.length / 2).fill(14),
      first,
      frame,
      style,
      label: (id) => (asked.push(id), `note ${id}`),
      measure: (text) => text.length * 6,
    });

  test('skips overlaps by priority, keeps the hovered one and asks only for nodes in view', () => {
    const positions = [0, 0, 5, 0, 200, 0, 5000, 0, NaN, NaN];
    const asked: number[] = [];
    expect(place(positions, [0, 1, 2, 3, 4], null, asked).map((box) => box.id)).toEqual([0, 2]);
    expect(asked).toEqual([0, 1, 2]);
    expect(place(positions, [0, 1, 2], 1).map((box) => box.id)).toEqual([1, 2]);
  });

  test('draws at most about a hundred', () => {
    const positions: number[] = [];
    for (let y = -280; y <= 280; y += 40) for (let x = -360; x <= 360; x += 60) positions.push(x, y);
    const order = Array.from({ length: positions.length / 2 }, (_, i) => i);
    expect(place(positions, order)).toHaveLength(MAX_LABELS);
  });
});
