// Note paths from the renderer are untrusted (see `shared/ipc.ts`). Runs inside
// vault-worker only. Loaded by Node as-is in tests (type stripping): erasable TypeScript.
import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The OS path of the note at `path`, or a throw. Only the contract form passes: relative,
 * `/` separators, `.md`, and no segment that is empty or starts with `.` (so no `..`, and
 * nothing hidden such as `.myelin/`). `:` is refused too: drive letters and, on Windows,
 * alternate data streams. Says nothing about what is on disk.
 */
export function resolveNotePath(root: string, path: unknown): string {
  if (typeof path === 'string' && /\.md$/i.test(path) && !/[\\:\0]/.test(path)) {
    const segments = path.split('/');
    if (segments.every((segment) => segment !== '' && !segment.startsWith('.'))) {
      return join(root, ...segments);
    }
  }
  throw new Error(`not a note path: ${String(path)}`);
}

/**
 * `resolveNotePath` for a note that exists. Like the tree, it follows no symlink or
 * junction, which could lead outside the vault.
 */
export async function existingNotePath(root: string, path: unknown): Promise<string> {
  const file = resolveNotePath(root, path);
  const segments = (path as string).split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stats = await lstat(current);
    const last = index === segments.length - 1;
    // `lstat` calls a symlink or junction neither a file nor a folder.
    if (last ? !stats.isFile() : !stats.isDirectory()) throw new Error(`not a note: ${String(path)}`);
  }
  return file;
}

/**
 * `resolveNotePath` for a note about to be written: it may not exist, nor may its folders.
 * What exists on the way must be real folders, never a symlink or junction, and the note
 * itself a file.
 */
export async function writableNotePath(root: string, path: unknown): Promise<string> {
  const file = resolveNotePath(root, path);
  // The root may be a link: the user picked it. If it is gone, nothing is recreated.
  if (!(await stat(root)).isDirectory()) throw new Error(`not a folder: ${root}`);
  const segments = (path as string).split('/');
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stats = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stats) break;
    const last = index === segments.length - 1;
    if (last ? !stats.isFile() : !stats.isDirectory()) throw new Error(`not a note: ${String(path)}`);
  }
  return file;
}

/**
 * The folder on disk that a new note at `path` (already valid) writes in another case, or
 * `null`. Windows would put the note in it, under a path the app does not know.
 */
export async function folderOnDiskInOtherCase(root: string, path: string): Promise<string | null> {
  const folders = path.split('/').slice(0, -1);
  let current = root;
  for (const [index, segment] of folders.entries()) {
    const names = await readdir(current);
    if (!names.includes(segment)) {
      const other = names.find((name) => name.toLowerCase() === segment.toLowerCase());
      return other === undefined ? null : [...folders.slice(0, index), other].join('/');
    }
    current = join(current, segment);
  }
  return null;
}
