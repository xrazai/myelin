// Coordinates a deletion in the renderer: save what is open under the target, so that the
// Recycle Bin gets the latest text, delete, then close those tabs. Plain TS, so that the
// order can be tested without Svelte.
import type { DeleteInfo, TreeEntry } from '../shared/ipc';

export interface DeleteTarget {
  path: string;
  kind: TreeEntry['kind'];
}

export interface DeleteDisk {
  deleteItem(path: string, kind: TreeEntry['kind']): Promise<void>;
}

export interface DeleteState {
  /** The paths with a tab, as they are now. */
  openPaths(): string[];
  /** Saves the note. `false`: the user's text is not safe on disk. */
  save(path: string): Promise<boolean>;
  /** Closes these tabs, saved or not. */
  close(paths: string[]): void;
}

/** `unsaved`: nothing was deleted; these open notes have text the bin would not get. */
export type DeleteOutcome = { status: 'deleted' } | { status: 'unsaved'; paths: string[] };

export function pathsUnder(paths: readonly string[], target: DeleteTarget): string[] {
  const { path, kind } = target;
  return paths.filter((open) => (kind === 'note' ? open === path : open.startsWith(`${path}/`)));
}

/** `discard`: the user chose to lose the text that cannot be saved. Rejects if the move fails. */
export async function deleteItem(
  disk: DeleteDisk,
  state: DeleteState,
  target: DeleteTarget,
  discard: boolean,
): Promise<DeleteOutcome> {
  const unsaved: string[] = [];
  for (const path of pathsUnder(state.openPaths(), target)) {
    if (!(await state.save(path))) unsaved.push(path);
  }
  if (unsaved.length > 0 && !discard) return { status: 'unsaved', paths: unsaved };
  await disk.deleteItem(target.path, target.kind);
  state.close(pathsUnder(state.openPaths(), target));
  return { status: 'deleted' };
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** What the confirmation says, one sentence each. */
export function deleteWarnings(kind: TreeEntry['kind'], info: DeleteInfo): string[] {
  const lines: string[] = [];
  if (kind === 'folder') {
    lines.push(
      `Everything in the folder goes with it: ${count(info.notes, 'note')}, and any file the tree does not show ` +
        `(images, other files, hidden ones): ${info.otherFiles} here.`,
    );
  }
  const what = kind === 'note' ? 'this note' : 'a note in this folder';
  if (info.linkedFrom === null) {
    lines.push(`How many notes link to ${what} is not known yet: the vault is still being indexed.`);
  } else if (info.linkedFrom === 0) {
    lines.push(`No other note links to ${what}.`);
  } else {
    const verb = info.linkedFrom === 1 ? 'links' : 'link';
    lines.push(`${count(info.linkedFrom, 'other note')} ${verb} to ${what}. The text of those links stays as it is.`);
  }
  return lines;
}
