// Coordinates a rename in the renderer: save the open notes, rename in the worker, then
// move the open state to the new path. Plain TS so the order can be tested without Svelte.
import type { RenameResult } from '../shared/ipc';

export interface RenameDisk {
  renameNote(from: string, to: string): Promise<RenameResult>;
}

export interface RenameState {
  /** `true`: a tab holds a deleted note at this path. */
  hasDeletedTab(path: string): boolean;
  /** Saves every open note: the rename may rewrite the links of any of them. */
  saveAll(): Promise<unknown>;
  /** Saves the note before it leaves its path. `false`: the user's text is not safe. */
  save(path: string): Promise<boolean>;
  /** Moves the editor, the saver and the tab to the new path, in one step. */
  move(from: string, to: string): void;
}

/** The path a note gets when its name is edited to `typed`; `null`: no rename. */
export function renamedPath(from: string, typed: string): string | null {
  const name = typed.trim().replace(/\.md$/i, '');
  if (!name) return null;
  const to = `${from.slice(0, from.lastIndexOf('/') + 1)}${name}.md`;
  return to === from ? null : to;
}

/**
 * Runs a rename. `null`: the note has text that could not be saved, so nothing happened.
 * Rejects, with nothing moved, if the rename is refused.
 */
export async function renameNote(
  disk: RenameDisk,
  state: RenameState,
  from: string,
  to: string,
): Promise<RenameResult | null> {
  // The tab of a deleted note may hold text that moving there would drop.
  if (state.hasDeletedTab(to)) throw new Error(`close the tab of ${to} first`);
  // Another note that cannot be saved keeps its text: it does not hold up this rename.
  await state.saveAll();
  if (!(await state.save(from))) return null;
  const result = await disk.renameNote(from, to);
  state.move(from, to);
  return result;
}
