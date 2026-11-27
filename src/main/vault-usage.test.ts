import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { appendUsageEvent } from './vault-usage';

test('appends one JSON line per event, without rewriting earlier ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'myelin-usage-'));
  try {
    await appendUsageEvent(root, { type: 'renamed', from: 'Old.md', to: 'New.md', at: '2026-01-01T00:00:00.000Z' });
    await appendUsageEvent(root, { type: 'followed', from: 'New.md', to: 'Other.md', at: '2026-01-02T00:00:00.000Z' });
    const lines = (await readFile(join(root, '.myelin', 'usage.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ type: 'renamed', from: 'Old.md', to: 'New.md', at: '2026-01-01T00:00:00.000Z' });
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'followed', from: 'New.md', to: 'Other.md', at: '2026-01-02T00:00:00.000Z' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
