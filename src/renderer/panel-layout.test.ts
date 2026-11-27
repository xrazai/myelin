import { expect, test } from 'vitest';
import {
  DEFAULT_WIDTHS,
  fitWidths,
  loadWidths,
  maxWidth,
  MIN_EDITOR_WIDTH,
  MIN_WIDTHS,
  resizeSide,
  saveWidths,
} from './panel-layout';

function memory() {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

test('widths that fit are shown as they are', () => {
  expect(fitWidths({ left: 300, right: 400 }, 1400)).toEqual({ left: 300, right: 400 });
});

test('a narrow window shrinks both sides and keeps the editor usable', () => {
  const shown = fitWidths({ left: 460, right: 600 }, 1000);
  expect(shown.left).toBeGreaterThan(MIN_WIDTHS.left);
  expect(shown.right).toBeGreaterThan(MIN_WIDTHS.right);
  expect(1000 - shown.left - shown.right - 2).toBeGreaterThanOrEqual(MIN_EDITOR_WIDTH);
});

test('sides never go below their minimum, even in a tiny window', () => {
  expect(fitWidths({ left: 400, right: 400 }, 300)).toEqual(MIN_WIDTHS);
  expect(fitWidths({ left: 1, right: 1 }, 1400)).toEqual(MIN_WIDTHS);
});

test('resizing one side stops at its limits and does not move the other', () => {
  const shown = { left: 260, right: 320 };
  expect(resizeSide(shown, 'left', 10, 1200)).toEqual({ left: MIN_WIDTHS.left, right: 320 });
  expect(resizeSide(shown, 'left', 5000, 1200)).toEqual({ left: 1200 - MIN_EDITOR_WIDTH - 2 - 320, right: 320 });
  expect(resizeSide(shown, 'right', 400.6, 1200)).toEqual({ left: 260, right: 401 });
  expect(maxWidth(shown, 'right', 300)).toBe(MIN_WIDTHS.right);
});

test('sizes are remembered per vault', () => {
  const storage = memory();
  saveWidths(storage, 'one', { left: 200, right: 500 });
  expect(loadWidths(storage, 'one')).toEqual({ left: 200, right: 500 });
  expect(loadWidths(storage, 'two')).toEqual(DEFAULT_WIDTHS);
});

test('unreadable or blocked storage falls back to the defaults', () => {
  for (const stored of ['{', '"x"', 'null', '{"left":"wide","right":null}']) {
    expect(loadWidths({ getItem: () => stored }, 'id')).toEqual(DEFAULT_WIDTHS);
  }
  const blocked = () => {
    throw new Error('blocked');
  };
  expect(loadWidths({ getItem: blocked }, 'id')).toEqual(DEFAULT_WIDTHS);
  expect(() => saveWidths({ setItem: blocked }, 'id', DEFAULT_WIDTHS)).not.toThrow();
});
