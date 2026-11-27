import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { estimateMs, fitModel, type FitPoint, type GpuProfile } from './bench-graph.ts';

const grid = (model: (pixels: number, elements: number) => number): FitPoint[] =>
  [2_073_600, 3_686_400, 5_184_000].flatMap((pixels) =>
    [42_000, 210_000, 424_000].map((elements) => ({ pixels, elements, gpuMs: model(pixels, elements) })),
  );

describe('the weak GPU model', () => {
  test('recovers the terms of a cost that is linear', () => {
    const fitted = fitModel(grid((pixels, elements) => 3e-8 * pixels + 1.5e-6 * elements + 0.04));
    expect(fitted.a).toBeCloseTo(3e-8, 12);
    expect(fitted.b).toBeCloseTo(1.5e-6, 10);
    expect(fitted.c).toBeCloseTo(0.04, 8);
    expect(fitted.maxError).toBeLessThan(1e-6);
  });

  test('never gives a cost below zero, and reports how far off it is', () => {
    // Cheaper with more pixels: noise could look like this.
    const fitted = fitModel(grid((pixels, elements) => 1.5e-6 * elements + 0.5 - 3e-8 * pixels));
    expect(Math.min(fitted.a, fitted.b, fitted.c)).toBeGreaterThanOrEqual(0);
    expect(fitted.a).toBe(0);
    expect(fitted.maxError).toBeGreaterThan(0);
  });

  test('scales pixels by bandwidth and elements by FP32; the fixed cost stays', () => {
    const gpu = (memoryBandwidthGBs: number, fp32GFlops: number): GpuProfile => ({
      id: 'x',
      name: 'x',
      memoryBandwidthGBs,
      fp32GFlops,
    });
    const model = { a: 1, b: 10, c: 5, maxError: 0 };
    expect(estimateMs(model, gpu(100, 1000), gpu(100, 1000), 2, 3)).toBe(37);
    expect(estimateMs(model, gpu(100, 1000), gpu(10, 500), 2, 3)).toBe(20 + 60 + 5);
  });

  test('every profile has its figures, how they were found and a source; the reference exists', () => {
    const file = JSON.parse(readFileSync(join(import.meta.dirname, 'gpu-profiles.json'), 'utf8')) as {
      reference: string;
      profiles: (GpuProfile & { basis: { bandwidth: string; fp32: string }; sources: string[] })[];
    };
    expect(file.profiles.map((profile) => profile.id)).toEqual(['rtx-5070-ti', 'iris-xe', 'uhd-770', 'n100']);
    expect(file.profiles.find((profile) => profile.id === file.reference)?.rendererMatch).toBeTruthy();
    for (const profile of file.profiles) {
      expect(profile.memoryBandwidthGBs).toBeGreaterThan(0);
      expect(profile.fp32GFlops).toBeGreaterThan(0);
      expect(profile.basis.bandwidth).toMatch(/^(Listed|Derived)/);
      expect(profile.basis.fp32).toMatch(/^Derived/);
      for (const source of profile.sources) expect(source).toMatch(/^https:\/\/www\.(intel|nvidia)\.com\//);
    }
  });
});
