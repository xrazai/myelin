import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { writeFileAtomic } from './atomic-write';

let dir: string;
let note: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'myelin-atomic-'));
  note = join(dir, 'note.md');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = (path: string) => readFileSync(path, 'utf8');

function fsError(code: string) {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

// A file held by another process: the rename fails `times` times, then goes through.
function heldFile(code: string, times: number) {
  let left = times;
  return {
    rename: vi.fn(async (from: string, to: string) => {
      if (left-- > 0) throw fsError(code);
      await rename(from, to);
    }),
    sleep: vi.fn(async (_ms: number) => {}),
  };
}

test('creates and replaces a note with the exact UTF-8 bytes, leaving no .tmp', async () => {
  await writeFileAtomic(note, 'first, a longer version\n');
  await writeFileAtomic(note, 'memória\n');
  expect(readFileSync(note)).toEqual(Buffer.from('memória\n', 'utf8'));
  expect(readdirSync(dir)).toEqual(['note.md']);
});

test('syncs <note>.md.tmp before renaming it over the original', async () => {
  writeFileSync(note, 'old', 'utf8');
  await writeFileAtomic(note, 'new', {
    rename: async (from, to) => {
      expect(from).toBe(`${note}.tmp`);
      expect(read(from)).toBe('new');
      expect(read(to)).toBe('old');
      await rename(from, to);
    },
    sleep: async () => {},
  });
  expect(read(note)).toBe('new');
});

test.each(['EPERM', 'EBUSY', 'EACCES'])('retries the rename while the file is held (%s)', async (code) => {
  writeFileSync(note, 'old', 'utf8');
  const deps = heldFile(code, 3);
  await writeFileAtomic(note, 'new', deps);
  expect(deps.rename).toHaveBeenCalledTimes(4);
  expect(deps.sleep.mock.calls).toEqual([[10], [20], [40]]);
  expect(read(note)).toBe('new');
});

test('gives up on a file that stays held: original intact, .tmp removed', async () => {
  writeFileSync(note, 'old', 'utf8');
  const deps = heldFile('EBUSY', Infinity);
  await expect(writeFileAtomic(note, 'new', deps)).rejects.toMatchObject({ code: 'EBUSY' });
  expect(deps.rename).toHaveBeenCalledTimes(deps.sleep.mock.calls.length + 1);
  const waited = deps.sleep.mock.calls.reduce((sum, [ms]) => sum + ms, 0);
  expect(waited).toBeGreaterThanOrEqual(1000);
  expect(read(note)).toBe('old');
  expect(readdirSync(dir)).toEqual(['note.md']);
});

test('does not retry other errors', async () => {
  writeFileSync(note, 'old', 'utf8');
  const deps = heldFile('ENOSPC', 1);
  await expect(writeFileAtomic(note, 'new', deps)).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(deps.rename).toHaveBeenCalledTimes(1);
  expect(read(note)).toBe('old');
  expect(existsSync(`${note}.tmp`)).toBe(false);
});

// A real OS refusal: Windows does not rename over a read-only file.
test.runIf(process.platform === 'win32')('survives a real EPERM that clears (Windows)', async () => {
  writeFileSync(note, 'old', 'utf8');
  chmodSync(note, 0o444);
  const codes: unknown[] = [];
  await writeFileAtomic(note, 'new', {
    rename: (from, to) =>
      rename(from, to).catch((error: NodeJS.ErrnoException) => {
        codes.push(error.code);
        chmodSync(note, 0o666);
        throw error;
      }),
    sleep,
  });
  expect(codes).toEqual(['EPERM']);
  expect(read(note)).toBe('new');
});

test('a process killed between write and rename leaves the original; the next save works', async () => {
  writeFileSync(note, 'old', 'utf8');
  // Runs the module in plain Node and kills the process where the rename would happen.
  const script = `
    const { writeFileAtomic } = await import(${JSON.stringify(new URL('./atomic-write.ts', import.meta.url).href)});
    await writeFileAtomic(${JSON.stringify(note)}, 'unsaved, longer than the next save', {
      rename: async () => process.kill(process.pid, 'SIGKILL'),
      sleep: async () => {},
    });
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  expect(child.status, child.stderr).not.toBe(0);
  expect(read(note)).toBe('old');
  expect(read(`${note}.tmp`)).toBe('unsaved, longer than the next save');

  await writeFileAtomic(note, 'new');
  expect(read(note)).toBe('new');
  expect(readdirSync(dir)).toEqual(['note.md']);
});

test('concurrent writes to one note run in order; the last one wins', async () => {
  const versions = Array.from({ length: 20 }, (_, i) => `${i}`.repeat((20 - i) * 1000));
  await Promise.all(versions.map((v) => writeFileAtomic(note, v)));
  expect(read(note)).toBe(versions.at(-1));
  expect(readdirSync(dir)).toEqual(['note.md']);
});

test('a failed write does not block the next one to the same note', async () => {
  const failed = writeFileAtomic(note, 'a', heldFile('ENOSPC', 1));
  const next = writeFileAtomic(note, 'b');
  await expect(failed).rejects.toMatchObject({ code: 'ENOSPC' });
  await next;
  expect(read(note)).toBe('b');
});
