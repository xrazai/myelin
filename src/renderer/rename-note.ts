// Coordinates a rename, of a note or a folder, in the renderer: save the open notes, rename in the worker, then
// move the open state to the new path. Plain TS so the order can be tested without Svelte.
import type { FolderRenameResult, RenameResult } from '../shared/ipc';

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

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** The path a folder gets when its name is edited to `typed`; `null`: no rename. */
export function renamedFolderPath(from: string, typed: string): string | null {
  const name = typed.trim();
  if (!name) return null;
  // Moving is another action; a typed `/` would move the folder by surprise.
  if (name.includes('/')) throw new Error('a name cannot contain /');
  const to = parentOf(from) ? `${parentOf(from)}/${name}` : name;
  return to === from ? null : to;
}

/** Whether `path` is `folder` or inside it. */
export const isWithin = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/** `path`, inside the folder `from`, once that folder is called `to`; else `path`. */
export const movedPath = (path: string, from: string, to: string) =>
  isWithin(path, from) ? `${to}${path.slice(from.length)}` : path;

export interface FolderRenameDisk {
  renameFolder(from: string, to: string): Promise<FolderRenameResult>;
}

export interface FolderRenameState {
  /** The paths with a tab, as they are now. */
  openPaths(): string[];
  saveAll(): Promise<unknown>;
  save(path: string): Promise<boolean>;
  /**
   * Moves the editors, the saver and the tabs of `moves` to their new paths, with no pause
   * between them. `gone`: that note did not move, as it was not there to move.
   */
  move(moves: { from: string; to: string; gone: boolean }[]): void;
}

export type FolderRenameOutcome =
  | { status: 'renamed'; result: FolderRenameResult }
  /** Nothing was renamed: the text of this open note is not safe on disk. */
  | { status: 'unsaved'; path: string };

/** Rejects, with nothing moved, if the rename is refused. */
export async function renameFolder(
  disk: FolderRenameDisk,
  state: FolderRenameState,
  from: string,
  to: string,
): Promise<FolderRenameOutcome> {
  // A tab already at a destination holds a deleted note, maybe its only copy (#107).
  const into = `${to.toLowerCase()}/`;
  const held = state.openPaths().find((path) => !isWithin(path, from) && path.toLowerCase().startsWith(into));
  if (held !== undefined) throw new Error(`close the tab of ${held} first`);
  // The rename may rewrite the links of any open note.
  await state.saveAll();
  for (const path of state.openPaths().filter((open) => isWithin(open, from))) {
    if (!(await state.save(path))) return { status: 'unsaved', path };
  }
  const result = await disk.renameFolder(from, to);
  const moved = new Set(result.moved.map(([path]) => path));
  // The tabs of notes deleted before go along too, with their text.
  state.move(
    state
      .openPaths()
      .filter((path) => isWithin(path, from))
      .map((path) => ({ from: path, to: movedPath(path, from, to), gone: !moved.has(path) })),
  );
  return { status: 'renamed', result };
}
