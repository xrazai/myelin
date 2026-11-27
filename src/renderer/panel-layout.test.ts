import { expect, test } from 'vitest';
import {
  chooseWidth,
  DEFAULT_COLLAPSED,
  DEFAULT_WIDTHS,
  fitVisibleWidths,
  fitWidths,
  loadCollapsed,
  loadWidths,
  maxWidth,
  MIN_EDITOR_WIDTH,
  MIN_WIDTHS,
  resizeSide,
  resizeStored,
  saveCollapsed,
  saveWidths,
  toggleCollapsed,
  toggleFocusMode,
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

test('resizing in a narrow window keeps the remembered width of the other side', () => {
  const chosen = { left: 400, right: 600 };
  const narrow = fitWidths(chosen, 900);
  expect(narrow).toEqual({ left: 241, right: 336 });

  // One arrow step: on screen only the left column moves.
  const step = resizeStored(chosen, narrow, 'left', 225, 900);
  expect(step.shown).toEqual({ left: 225, right: 336 });
  expect(step.stored).toMatchObject({ left: 225, right: 600 });
  expect(fitWidths(step.stored, 1400)).toEqual({ left: 225, right: 600 });
  // In the same window (reload, new window size) the chosen side stays as chosen.
  expect(fitWidths(step.stored, 900)).toEqual({ left: 225, right: 353 });

  // The step back is still possible, and the other side stays remembered.
  const back = resizeStored(step.stored, step.shown, 'left', 241, 900);
  expect(back.shown).toEqual(narrow);
  expect(back.stored).toMatchObject({ left: 241, right: 600 });

  const other = resizeStored(back.stored, back.shown, 'right', 320, 900);
  expect(other.shown).toEqual({ left: 241, right: 320 });
  expect(other.stored).toMatchObject({ left: 241, right: 320 });
});

test('a kept side only gives room once the other one is at its minimum', () => {
  const widths = { left: 400, right: 600, kept: 'left' as const };
  expect(fitWidths(widths, 900)).toEqual({ left: 378, right: MIN_WIDTHS.right });
  expect(fitWidths(widths, 300)).toEqual(MIN_WIDTHS);
  expect(fitWidths({ ...widths, kept: 'right' }, 1100)).toEqual({ left: 178, right: 600 });
});

test('widths that fit the window they were chosen in keep no side', () => {
  expect(chooseWidth({ left: 400, right: 600, kept: 'right' }, 'left', 200, 1400)).toEqual({ left: 200, right: 600 });
  // A reset remembers the default, also where the screen cannot show it.
  expect(chooseWidth({ left: 400, right: 600 }, 'left', DEFAULT_WIDTHS.left, 900)).toEqual({
    left: DEFAULT_WIDTHS.left,
    right: 600,
    kept: 'left',
  });
});

test('sizes are remembered per vault', () => {
  const storage = memory();
  saveWidths(storage, 'one', { left: 200, right: 500 });
  expect(loadWidths(storage, 'one')).toEqual({ left: 200, right: 500 });
  expect(loadWidths(storage, 'two')).toEqual(DEFAULT_WIDTHS);
  saveWidths(storage, 'two', { left: 200, right: 500, kept: 'right' });
  expect(loadWidths(storage, 'two')).toEqual({ left: 200, right: 500, kept: 'right' });
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

test('collapsed panels persist per vault and restore widths when reopened', () => {
  const storage = memory();
  expect(loadCollapsed(storage, 'v1')).toEqual(DEFAULT_COLLAPSED);
  const next = toggleCollapsed(DEFAULT_COLLAPSED, 'left');
  expect(next).toEqual({ left: true, right: false });
  saveCollapsed(storage, 'v1', next);
  expect(loadCollapsed(storage, 'v1')).toEqual({ left: true, right: false });
  expect(loadCollapsed(storage, 'v2')).toEqual(DEFAULT_COLLAPSED);
  expect(loadCollapsed({ getItem: () => '{bad' }, 'v1')).toEqual(DEFAULT_COLLAPSED);
});

test('focus mode collapses both panels and restores the prior open panels on exit', () => {
  const initial = { left: false, right: true };
  const entered = toggleFocusMode(initial, null);
  expect(entered.collapsed).toEqual({ left: true, right: true });
  expect(entered.beforeFocus).toEqual(initial);

  const exited = toggleFocusMode(entered.collapsed, entered.beforeFocus);
  expect(exited.collapsed).toEqual(initial);
  expect(exited.beforeFocus).toBeNull();

  // Exiting focus mode without saved prior state opens both panels.
  expect(toggleFocusMode({ left: true, right: true }, null).collapsed).toEqual({ left: false, right: false });
});

test('fitVisibleWidths gives collapsed panels zero width and allocates room to the open one', () => {
  expect(fitVisibleWidths({ left: 300, right: 400 }, { left: true, right: true }, 1000)).toEqual({ left: 0, right: 0 });
  expect(fitVisibleWidths({ left: 300, right: 400 }, { left: true, right: false }, 1000)).toEqual({
    left: 0,
    right: 400,
  });
  expect(fitVisibleWidths({ left: 300, right: 900 }, { left: true, right: false }, 1000)).toEqual({
    left: 0,
    right: 1000 - MIN_EDITOR_WIDTH - 1,
  });
});
