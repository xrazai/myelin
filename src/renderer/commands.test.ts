import { expect, test } from 'vitest';
import { COMMANDS, commandFor, searchCommands } from './commands';

const press = (key: string, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {}) =>
  commandFor({
    key,
    ctrlKey: mods.ctrl ?? true,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
  });

test('workspace commands match their shortcuts', () => {
  expect(press('p')).toBe('open-palette');
  expect(press('P')).toBe('open-palette');
  expect(press('Tab')).toBe('next-tab');
  expect(press('Tab', { shift: true })).toBe('previous-tab');
  expect(press('w')).toBe('close-tab');
  expect(press('W')).toBe('close-tab');
  expect(press('L', { shift: true })).toBe('toggle-right-panel');
  expect(press('s')).toBe('save');
  expect(press('n')).toBe('new-note');
  expect(press('\\')).toBe('toggle-focus-mode');
  expect(press('b', { shift: true })).toBe('toggle-left-panel');
});

test('unregistered combinations return null', () => {
  expect(press('w', { ctrl: false })).toBeNull();
  expect(press('w', { shift: true })).toBeNull();
  expect(press('w', { alt: true })).toBeNull();
  expect(press('Tab', { meta: true })).toBeNull();
  expect(press('l')).toBeNull();
  expect(press('s', { shift: true })).toBeNull();
  expect(press('p', { shift: true })).toBeNull();
});

test('searchCommands returns all commands on empty query and filters fuzzily', () => {
  expect(searchCommands('')).toEqual([...COMMANDS]);
  expect(searchCommands('   ')).toEqual([...COMMANDS]);

  const panel = searchCommands('brain');
  expect(panel.map((c) => c.id)).toEqual(['toggle-right-panel']);

  const tab = searchCommands('ntab');
  expect(tab.map((c) => c.id)).toContain('next-tab');
});
