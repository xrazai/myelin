// Atomic note writes for vault-worker (AGENTS.md, rule 2): <path>.tmp, fsync, rename over the original.
// The file gets exactly the UTF-8 bytes of `content`, so a caller can hash it before calling.
import { open, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

// On Windows, antivirus, OneDrive or the search indexer can hold the target for a moment.
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
// Waits between rename attempts, about 2 s in total.
const RETRY_DELAYS_MS: readonly number[] = [10, 20, 40, 80, 160, 320, 640, 640];

/** Replaceable in tests to simulate a held file or a crash. */
export type AtomicWriteDeps = {
  rename: (from: string, to: string) => Promise<void>;
  sleep: (ms: number) => Promise<unknown>;
};

// Writes to one path share its .tmp file, so they run one at a time, in call order.
const pending = new Map<string, Promise<void>>();

/**
 * Replaces `path` with `content`, or creates it. The parent folder must exist.
 * On failure the promise rejects and the original file is left as it was.
 */
export function writeFileAtomic(
  path: string,
  content: string,
  deps: AtomicWriteDeps = { rename, sleep },
): Promise<void> {
  const absolute = resolve(path);
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  const write = () => replaceFile(absolute, content, deps);
  const result = (pending.get(key) ?? Promise.resolve()).then(write, write);
  pending.set(key, result);
  const forget = () => {
    if (pending.get(key) === result) pending.delete(key);
  };
  result.then(forget, forget);
  return result;
}

async function replaceFile(path: string, content: string, deps: AtomicWriteDeps): Promise<void> {
  const tmp = `${path}.tmp`;
  // 'w' truncates a .tmp left behind by a crash.
  const file = await open(tmp, 'w');
  try {
    try {
      await file.writeFile(content, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await renameWithRetry(tmp, path, deps);
  } catch (error) {
    // Best effort: the caller needs the original error, not a cleanup one.
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function renameWithRetry(from: string, to: string, deps: AtomicWriteDeps): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.rename(from, to);
      return;
    } catch (error) {
      const delay = RETRY_DELAYS_MS[attempt];
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (delay === undefined || !RETRY_CODES.has(code)) throw error;
      await deps.sleep(delay);
    }
  }
}
