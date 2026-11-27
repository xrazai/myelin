import { expect, test } from 'vitest';
import { loadSession, restorableTabs, saveSession } from './session-state';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

test('remembers a session per vault', () => {
  const storage = memory();
  const state = { tabs: ['a.md', 'b/c.md'], active: 'b/c.md', expanded: ['b'] };
  saveSession(storage, 'one', state);
  expect(loadSession(storage, 'one')).toEqual(state);
  expect(loadSession(storage, 'two')).toEqual({ tabs: [], active: null, expanded: [] });
});

test('anything unreadable is left out', () => {
  expect(loadSession(memory({ 'myelin.session.x': '{' }), 'x').tabs).toEqual([]);
  const odd = memory({ 'myelin.session.x': '{"tabs":["a.md",1,"a.md"],"active":7,"expanded":"no"}' });
  expect(loadSession(odd, 'x')).toEqual({ tabs: ['a.md'], active: null, expanded: [] });
});

test('what no longer exists is skipped, and another tab takes over as active', () => {
  const state = { tabs: ['a.md', 'b.md', 'c.md'], active: 'b.md', expanded: [] };
  expect(restorableTabs(state, () => true)).toEqual({ tabs: state.tabs, active: 'b.md' });
  expect(restorableTabs(state, (path) => path !== 'b.md')).toEqual({ tabs: ['a.md', 'c.md'], active: 'c.md' });
  expect(restorableTabs(state, (path) => path === 'a.md')).toEqual({ tabs: ['a.md'], active: 'a.md' });
  expect(restorableTabs(state, () => false)).toEqual({ tabs: [], active: null });
});
