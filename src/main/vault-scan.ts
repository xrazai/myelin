// Lists the vault as the `TreeEntry` tree of the contract. Runs inside vault-worker only.
// Loaded by Node as-is in tests (type stripping): erasable TypeScript, only `import type`
// from other project files.
import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { TreeEntry } from '../shared/ipc';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Folders first, then by name; code units break ties, so the order is stable. */
function compareEntries(a: TreeEntry, b: TreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** A folder that disappears or cannot be read must not take the whole tree down. */
const SKIPPABLE = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

function skip(error: unknown): null {
  if (SKIPPABLE.has((error as NodeJS.ErrnoException).code ?? '')) return null;
  throw error;
}

/**
 * What the entry is, or `null` to leave it out. Symlinks and junctions are never followed
 * (no cycles, nothing outside the vault). On Windows `readdir` calls every reparse point a
 * link, cloud placeholders included; `lstat` tells those apart from real links.
 */
async function entryKind(dir: string, entry: Dirent): Promise<TreeEntry['kind'] | null> {
  const stats = entry.isSymbolicLink() ? await lstat(join(dir, entry.name)).catch(skip) : entry;
  if (stats?.isDirectory()) return 'folder';
  return stats?.isFile() && /\.md$/i.test(entry.name) ? 'note' : null;
}

async function toEntries(dir: string, prefix: string, dirents: Dirent[]): Promise<TreeEntry[]> {
  const entries = await Promise.all(
    dirents.map(async (dirent): Promise<TreeEntry | null> => {
      // Dot entries are hidden: `.myelin/`, `.git/`, `.obsidian/`, `.trash/`...
      if (dirent.name.startsWith('.')) return null;
      const kind = await entryKind(dir, dirent);
      if (!kind) return null;
      const path = prefix + dirent.name;
      if (kind === 'note') return { kind, name: dirent.name.slice(0, -'.md'.length), path };
      const folder = join(dir, dirent.name);
      const children = await readdir(folder, { withFileTypes: true }).catch(skip);
      if (!children) return null;
      return { kind, name: dirent.name, path, children: await toEntries(folder, `${path}/`, children) };
    }),
  );
  return entries.filter((entry) => entry !== null).sort(compareEntries);
}

/** Entries at the vault root. Rejects if the root itself cannot be read. */
export async function scanVault(root: string): Promise<TreeEntry[]> {
  return toEntries(root, '', await readdir(root, { withFileTypes: true }));
}
