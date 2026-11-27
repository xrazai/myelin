import { describe, expect, test } from 'vitest';
import { boundsOf, fit, pan, screenToWorld, zoomAt, type Camera } from './camera.ts';

const size = { width: 800, height: 600 };
const camera: Camera = { x: 100, y: -50, zoom: 2 };
const limits = { min: 0.1, max: 10 };

describe('camera', () => {
  test('the center of the viewport is the camera position, and y grows downward', () => {
    expect(screenToWorld(camera, size, 400, 300)).toEqual([100, -50]);
    expect(screenToWorld(camera, size, 402, 304)).toEqual([101, -48]);
  });

  test('a pan keeps the world point under the pointer under the pointer', () => {
    const before = screenToWorld(camera, size, 10, 20);
    expect(screenToWorld(pan(camera, 30, -8), size, 40, 12)).toEqual(before);
  });

  test('a zoom keeps the world point under the pointer where it is', () => {
    const before = screenToWorld(camera, size, 650, 90);
    const zoomed = zoomAt(camera, size, 650, 90, 1.7, limits);
    expect(zoomed.zoom).toBeCloseTo(3.4);
    const after = screenToWorld(zoomed, size, 650, 90);
    expect(after[0]).toBeCloseTo(before[0]);
    expect(after[1]).toBeCloseTo(before[1]);
  });

  test('a zoom stops at the limits, and at a limit nothing moves', () => {
    expect(zoomAt(camera, size, 0, 0, 100, limits).zoom).toBe(10);
    const out = zoomAt(camera, size, 0, 0, 1e-9, limits);
    expect(out.zoom).toBe(0.1);
    expect(zoomAt(out, size, 7, 9, 0.5, limits)).toEqual(out);
  });

  test('bounds skip non-finite points; none left gives null', () => {
    expect(boundsOf(Float32Array.of(1, 2, NaN, 9, -3, 8, 4, Infinity))).toEqual({
      minX: -3,
      minY: 2,
      maxX: 1,
      maxY: 8,
    });
    expect(boundsOf(new Float32Array(0))).toBeNull();
    expect(boundsOf(Float32Array.of(NaN, NaN))).toBeNull();
  });

  test('fit shows all of the bounds, centered, with padding on the tighter axis', () => {
    const fitted = fit({ minX: 0, minY: 0, maxX: 4000, maxY: 1000 }, size);
    expect(fitted).toEqual({ x: 2000, y: 500, zoom: (800 * 0.9) / 4000 });
  });

  test('fit does not magnify a single point without limit', () => {
    expect(fit({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, size)).toEqual({ x: 5, y: 5, zoom: 1 });
  });
});
