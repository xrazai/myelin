import { describe, expect, test } from 'vitest';
import { AdaptiveQuality } from './quality.ts';

const run = (quality: AdaptiveQuality, milliseconds: number, frames: number) => {
  let steps = 0;
  for (let i = 0; i < frames; i++) if (quality.sample(milliseconds)) steps++;
  return steps;
};

describe('adaptive quality', () => {
  test('keeps the half resolution glow at 60 FPS and at just over 50', () => {
    const quality = new AdaptiveQuality();
    expect(run(quality, 16.7, 300)).toBe(0);
    expect(run(quality, 19.9, 300)).toBe(0);
    expect(quality.glow).toBe(0.5);
  });

  test('below 50 FPS lowers the resolution, then turns the glow off, and stays there', () => {
    const quality = new AdaptiveQuality();
    expect(run(quality, 25, 29)).toBe(0);
    expect(run(quality, 25, 1)).toBe(1);
    expect(quality.glow).toBe(0.25);
    expect(run(quality, 25, 30)).toBe(1);
    expect(quality.glow).toBe(0);
    expect(run(quality, 100, 300) + run(quality, 5, 300)).toBe(0);
    expect(quality.glow).toBe(0);
  });

  test('a few slow frames and long pauses change nothing', () => {
    const quality = new AdaptiveQuality();
    for (let i = 0; i < 300; i++) quality.sample(i % 3 === 0 ? 50 : 16);
    run(quality, 1000, 300);
    expect(quality.glow).toBe(0.5);
  });
});
