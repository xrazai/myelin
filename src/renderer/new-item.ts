// What creating from the file tree needs, in plain TS: where the item goes, whether its name
// can be used, and what the tree's context menu offers.
import type { TreeEntry } from '../shared/ipc';
import { folderNameProblem, noteNameProblem } from '../shared/links';

export type ItemKind = TreeEntry['kind'];

/** The folder a new item goes to when asked for on `entry`: `''` is the vault root. */
export function targetFolder(entry: TreeEntry | null): string {
  if (!entry) return '';
  return entry.kind === 'folder' ? entry.path : entry.path.slice(0, Math.max(0, entry.path.lastIndexOf('/')));
}

export interface NewItem {
  /** Vault path of what the name asks for. */
  path: string;
  /** Why it cannot be created, or `null`. */
  problem: string | null;
}

function entriesOf(tree: TreeEntry[], folder: string): TreeEntry[] {
  let entries = tree;
  if (folder === '') return entries;
  const segments = folder.split('/');
  for (let depth = 1; depth <= segments.length; depth++) {
    const path = segments.slice(0, depth).join('/');
    const found = entries.find((entry) => entry.kind === 'folder' && entry.path === path);
    if (found?.kind !== 'folder') return [];
    entries = found.children;
  }
  return entries;
}

/**
 * The item called `typed` inside `folder`; `null`: no name yet. Only the new name is
 * judged: the folders it goes into already exist.
 */
export function newItem(tree: TreeEntry[], folder: string, kind: ItemKind, typed: string): NewItem | null {
  const trimmed = typed.trim();
  const name = kind === 'note' ? trimmed.replace(/\.md$/i, '') : trimmed;
  if (name === '') return null;
  const file = kind === 'note' ? `${name}.md` : name;
  const path = folder === '' ? file : `${folder}/${file}`;
  let problem: string | null;
  if (name.includes('/')) problem = 'a name cannot contain /';
  else if (name.startsWith('.')) problem = 'a name cannot start with a dot';
  else problem = kind === 'note' ? noteNameProblem(file) : folderNameProblem(file);
  if (problem === null) {
    // Case ignored, as Windows ignores it. A note and a folder may share a name.
    const wanted = name.toLowerCase();
    const taken = entriesOf(tree, folder).find((entry) => entry.kind === kind && entry.name.toLowerCase() === wanted);
    if (taken) problem = `a ${kind} named ${taken.name} already exists`;
  }
  return { path, problem };
}

/** Every folder on the way to `path`: what must be expanded for its row to show. */
export function foldersAbove(path: string): string[] {
  const segments = path.split('/').slice(0, -1);
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'));
}

export interface MenuItem {
  id: 'new-note' | 'new-folder' | 'rename';
  label: string;
}

/** The context menu of `entry`, or of the blank space below the rows (`null`). */
export function menuItems(entry: TreeEntry | null): MenuItem[] {
  const items: MenuItem[] = [
    { id: 'new-note', label: 'New note' },
    { id: 'new-folder', label: 'New folder' },
  ];
  // Folders cannot be renamed yet.
  if (entry?.kind === 'note') items.push({ id: 'rename', label: 'Rename' });
  return items;
}
