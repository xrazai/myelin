import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readNotePreview } from './note-preview';
import { existingNotePath } from './vault-path';

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('readNotePreview', () => {
  test('reads title (case-insensitive .md), strips BOM, normalizes CRLF, and caps at 500 chars', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'myelin-preview-'));
    const body = 'a'.repeat(600);
    await writeFile(join(tempDir, 'Sample.MD'), `\uFEFFLine 1\r\nLine 2\r\n${body}`, 'utf8');

    const preview = await readNotePreview(await existingNotePath(tempDir, 'Sample.MD'), 'Sample.MD');
    expect(preview.path).toBe('Sample.MD');
    expect(preview.title).toBe('Sample');
    expect(preview.excerpt.startsWith('Line 1\nLine 2\n')).toBe(true);
    expect(preview.excerpt.length).toBe(500);
  });

  test('rejects missing notes and traversal paths', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'myelin-preview-'));
    await expect(existingNotePath(tempDir, 'Missing.md')).rejects.toThrow();
    await expect(existingNotePath(tempDir, '../outside.md')).rejects.toThrow();
  });
});
