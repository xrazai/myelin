// The deltas of the graph feed, applied one after the other, against a full read.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { GraphSnapshot } from '../shared/ipc';
import { createGraphFeed, readGraph } from './vault-graph';
import { openIndex, syncIndex, updateIndex } from './vault-index';

const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const pairs = ({ paths, edges }: GraphSnapshot) => {
  const found: string[] = [];
  for (let e = 0; e < edges.length; e += 2) found.push(pair(paths[edges[e]!]!, paths[edges[e + 1]!]!));
  return found.sort();
};

test('after any creations, edits and deletions the deltas add up to the whole graph', async () => {
  const base = await mkdtemp(join(tmpdir(), 'myelin-feed-'));
  const root = join(base, 'vault');
  await mkdir(join(root, 'f'), { recursive: true });
  const names = ['a', 'b', 'c', 'd', 'f/a', 'f/b', 'e'];
  let seed = 11;
  const random = (n: number) => (seed = (seed * 48271) % 2147483647) % n;
  const db = openIndex(join(base, 'index.db'));
  const signal = new AbortController().signal;
  try {
    await writeFile(join(root, 'a.md'), '[[b]] [[f/a]] [[e]]', 'utf8');
    await syncIndex(db, root, signal);
    const feed = createGraphFeed();
    expect(feed.changes(db)).toBeNull();
    const first = feed.full(db);
    const notes = new Set(first.paths);
    const edges = new Set(pairs(first));
    for (let step = 0; step < 150; step++) {
      const changed: string[] = [];
      for (let i = 0; i <= random(3); i++) {
        const path = `${names[random(names.length)]}.md`;
        if (random(3) === 0) await rm(join(root, path), { force: true });
        else {
          const links = Array.from({ length: random(4) }, () => `[[${names[random(names.length)]}]]`);
          // The step makes each text new, so that the note counts as written.
          await writeFile(join(root, path), `${links.join(' ')} ${step} ${i}`, 'utf8');
        }
        changed.push(path);
      }
      const exists = (path: string) => existsSync(join(root, path));
      await updateIndex(db, root, [...new Set(changed)], exists, signal, () => {}, { touched: feed.touched });
      // Now and then two updates are read at once.
      if (random(4) === 0) continue;
      const delta = feed.changes(db)!;
      for (const [a, b] of delta.removedEdges) expect(edges.delete(pair(a, b)), `${step} had ${a} ${b}`).toBe(true);
      for (const path of delta.removed) expect(notes.delete(path)).toBe(true);
      for (const path of delta.added) {
        expect(notes.has(path)).toBe(false);
        notes.add(path);
      }
      for (const [a, b] of delta.addedEdges) {
        expect(edges.has(pair(a, b)), `${step} did not have ${a} ${b}`).toBe(false);
        edges.add(pair(a, b));
      }
      const whole = readGraph(db);
      expect([...notes].sort(), `notes at ${step}`).toEqual(whole.paths);
      expect([...edges].sort(), `edges at ${step}`).toEqual(pairs(whole));
    }
    // The last step may not have been read yet.
    feed.changes(db);
    expect(feed.changes(db)).toMatchObject({ removed: [], added: [], removedEdges: [], addedEdges: [], edited: [] });
    feed.reset();
    expect(feed.changes(db)).toBeNull();
  } finally {
    db.close();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 60_000);
