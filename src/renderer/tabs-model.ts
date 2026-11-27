// The logic behind the tabs, in plain TS. A tab is a note, keyed by its path.
import type { VaultEvent } from '../shared/ipc';

export interface Tab {
  path: string;
  /** The note is gone from disk. The tab stays until the user closes it. */
  deleted: boolean;
}

export interface Tabs {
  list: readonly Tab[];
  /** Path of the open note. `null` only when there are no tabs. */
  active: string | null;
}

export const NO_TABS: Tabs = { list: [], active: null };

export function tabName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

const indexOf = (tabs: Tabs, path: string | null) => tabs.list.findIndex((tab) => tab.path === path);

/** Activates the note's tab, adding it right of the active one if there is none. */
export function openTab(tabs: Tabs, path: string): Tabs {
  if (indexOf(tabs, path) >= 0) return tabs.active === path ? tabs : { ...tabs, active: path };
  const after = indexOf(tabs, tabs.active) + 1;
  return { list: tabs.list.toSpliced(after, 0, { path, deleted: false }), active: path };
}

/** Closing the active tab activates the one on its right, or else the one on its left. */
export function closeTab(tabs: Tabs, path: string): Tabs {
  const index = indexOf(tabs, path);
  if (index < 0) return tabs;
  const list = tabs.list.toSpliced(index, 1);
  const active = tabs.active === path ? ((list[index] ?? list[index - 1])?.path ?? null) : tabs.active;
  return { list, active };
}

/** The tab `step` places from the active one, in strip order, wrapping around. */
export function cycleTab(tabs: Tabs, step: 1 | -1): Tabs {
  const { length } = tabs.list;
  if (length < 2) return tabs;
  const next = tabs.list[(indexOf(tabs, tabs.active) + step + length) % length]!;
  return { ...tabs, active: next.path };
}

/** Moves a tab so that it ends up at index `to`. */
export function moveTab(tabs: Tabs, path: string, to: number): Tabs {
  const from = indexOf(tabs, path);
  const target = Math.max(0, Math.min(to, tabs.list.length - 1));
  if (from < 0 || from === target) return tabs;
  return { ...tabs, list: tabs.list.toSpliced(from, 1).toSpliced(target, 0, tabs.list[from]!) };
}

/**
 * Marks the tabs of deleted notes (or inside deleted folders) and unmarks those that come
 * back. They are not closed: an external rename or a rewrite may look like a deletion.
 */
export function applyTabEvents(tabs: Tabs, events: VaultEvent[]): Tabs {
  let list = tabs.list;
  for (const event of events) {
    if (event.type === 'changed') continue;
    const deleted = event.type === 'deleted';
    list.forEach((tab, index) => {
      const hit =
        event.kind === 'note' ? tab.path === event.path : deleted && tab.path.startsWith(`${event.path}/`);
      if (hit && tab.deleted !== deleted) list = list.with(index, { ...tab, deleted });
    });
  }
  return list === tabs.list ? tabs : { ...tabs, list };
}

/**
 * Where a dragged tab lands: the new index of the tab now at `from`, with the pointer at `x`.
 * `middles` are the horizontal centers of all tabs, in strip order, in the same coordinates.
 */
export function dropIndex(middles: readonly number[], x: number, from: number): number {
  const next = middles.findIndex((middle) => x < middle);
  const gap = next < 0 ? middles.length : next;
  // The gaps on both sides of the dragged tab leave it where it is.
  return gap > from ? gap - 1 : gap;
}
