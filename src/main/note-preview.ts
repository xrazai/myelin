// Reads a short preview of a note without loading the whole file into memory.
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import type { NotePreview } from '../shared/ipc.ts';

const PREVIEW_BYTES = 2048;
const PREVIEW_CHARS = 500;

export async function readNotePreview(file: string, path: string): Promise<NotePreview> {
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(PREVIEW_BYTES);
    const { bytesRead } = await handle.read(buf, 0, PREVIEW_BYTES, 0);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    // If the 2048-byte boundary cut a multi-byte UTF-8 sequence, drop the trailing replacement char.
    if (bytesRead === PREVIEW_BYTES && text.endsWith('\uFFFD')) {
      text = text.slice(0, -1);
    }
    const clean = (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n?/g, '\n');
    return {
      path,
      title: basename(path).replace(/\.md$/i, ''),
      excerpt: clean.slice(0, PREVIEW_CHARS).trimEnd(),
    };
  } finally {
    await handle.close();
  }
}
