// Coordinates a rename in the renderer: save the old note, call the worker, then rekey
// the editor/saver state. Plain TS so the ordering can be tested without Svelte.
import type { Tabs } from './tabs-model';
import { renameTab } from './tabs-model';

export interface RenameDisk {
  renameNote(from: string, to: string): Promise<void>;
}

export interface RenameState {
  /** Saves the note before leaving its path. `false`: the user's text is not safe. */
  save(from: string): Promise<boolean>;
  /** Rekeys the editor and saver state to the new path. */
  move(from: string, to: string): Promise<void>;
}

/**
 * Runs a rename. On success the caller should apply the returned tabs; on failure the
 * tabs are left untouched. `to` must be a valid note path with a `.md` extension.
 */
export async function renameNote(
  disk: RenameDisk,
  state: RenameState,
  tabs: Tabs,
  from: string,
  to: string,
): Promise<{ tabs: Tabs } | null> {
  if (!/\.md$/i.test(to) || /[\\:\0]/.test(to) || to.split('/').some((s) => s === '' || s.startsWith('.'))) {
    throw new Error(`not a note path: ${to}`);
  }
  if (from === to) return null;
  if (!(await state.save(from))) return null;
  await disk.renameNote(from, to);
  await state.move(from, to);
  return { tabs: renameTab(tabs, from, to) };
}
