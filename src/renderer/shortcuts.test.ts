import { expect, test } from 'vitest';
import { shortcutFor } from './shortcuts';

const press = (key: string, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {}) =>
  shortcutFor({
    key,
    ctrlKey: mods.ctrl ?? true,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
  });

test('workspace shortcuts, with Caps Lock or without', () => {
  expect(press('Tab')).toBe('next-tab');
  expect(press('Tab', { shift: true })).toBe('previous-tab');
  expect(press('w')).toBe('close-tab');
  expect(press('W')).toBe('close-tab');
  expect(press('L', { shift: true })).toBe('toggle-right-panel');
  expect(press('s')).toBe('save');
});

test('other combinations are left alone', () => {
  expect(press('w', { ctrl: false })).toBeNull();
  expect(press('w', { shift: true })).toBeNull();
  expect(press('w', { alt: true })).toBeNull();
  expect(press('Tab', { meta: true })).toBeNull();
  expect(press('l')).toBeNull();
  expect(press('s', { shift: true })).toBeNull();
  expect(press('p')).toBeNull();
});
