// Moving in the file tree: where an item can go. A move is a rename to another folder,
// so the worker's rename rules apply (it refuses a taken name). Plain TS.
import type { TreeEntry } from '../shared/ipc';

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

export interface MoveItem {
  path: string;
  kind: TreeEntry['kind'];
}

/** The path `item` gets inside `folder` (`''`: the vault root). */
export function movedInto(item: MoveItem, folder: string): string {
  const name = item.path.slice(item.path.lastIndexOf('/') + 1);
  return folder === '' ? name : `${folder}/${name}`;
}

/** `false` for where it already is, and for a folder into itself. */
export function canMove(item: MoveItem, folder: string): boolean {
  if (folder === parentOf(item.path)) return false;
  return item.kind === 'note' || (folder !== item.path && !folder.startsWith(`${item.path}/`));
}

/** Every folder `item` can move to, the root first, in tree order. */
export function destinations(tree: TreeEntry[], item: MoveItem): string[] {
  const found = canMove(item, '') ? [''] : [];
  const walk = (entries: TreeEntry[]) => {
    for (const entry of entries) {
      if (entry.kind !== 'folder') continue;
      if (canMove(item, entry.path)) found.push(entry.path);
      walk(entry.children);
    }
  };
  walk(tree);
  return found;
}
