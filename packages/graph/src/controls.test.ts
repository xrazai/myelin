import { describe, expect, test } from 'vitest';
import { createWheelReader, type WheelInput } from './controls.ts';

const wheel = (input: Partial<WheelInput>): WheelInput => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  timeStamp: 1000,
  ...input,
});

describe('wheel', () => {
  test('a mouse notch zooms: up zooms in, down zooms out', () => {
    const read = createWheelReader();
    const out = read(wheel({ deltaY: 100 }));
    const back = read(wheel({ deltaY: -100, timeStamp: 1050 }));
    expect(out).toMatchObject({ type: 'zoom' });
    if (out.type !== 'zoom' || back.type !== 'zoom') throw new Error('zoom expected');
    expect(out.factor).toBeLessThan(1);
    expect(back.factor).toBeCloseTo(1 / out.factor);
  });

  test('line and page steps zoom too', () => {
    expect(createWheelReader()(wheel({ deltaY: 3, deltaMode: 1 }))).toMatchObject({ type: 'zoom' });
    expect(createWheelReader()(wheel({ deltaY: 1, deltaMode: 2 }))).toMatchObject({ type: 'zoom' });
  });

  test('small or sideways steps are a trackpad scroll: the picture follows the fingers', () => {
    expect(createWheelReader()(wheel({ deltaY: 4 }))).toEqual({ type: 'pan', dx: -0, dy: -4 });
    expect(createWheelReader()(wheel({ deltaX: 60, deltaY: 90 }))).toEqual({ type: 'pan', dx: -60, dy: -90 });
  });

  test('a gesture keeps its kind until a pause', () => {
    const read = createWheelReader();
    expect(read(wheel({ deltaY: 3, timeStamp: 0 })).type).toBe('pan');
    // A fast flick: large and vertical, but the same gesture.
    expect(read(wheel({ deltaY: 120, timeStamp: 16 })).type).toBe('pan');
    expect(read(wheel({ deltaY: 120, timeStamp: 500 })).type).toBe('zoom');
    expect(read(wheel({ deltaY: 2, timeStamp: 516 })).type).toBe('zoom');
  });

  test('ctrl is a pinch: always zoom, with a capped step', () => {
    const read = createWheelReader();
    const pinch = read(wheel({ deltaY: -5, ctrlKey: true }));
    expect(pinch).toEqual({ type: 'zoom', factor: Math.exp(0.05) });
    expect(read(wheel({ deltaY: -100, ctrlKey: true }))).toEqual({ type: 'zoom', factor: Math.exp(0.25) });
  });
});
