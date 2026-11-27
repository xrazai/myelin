import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { layoutRun, vaultGraph } from './bench-layout.ts';
import { generateVault } from './gen-vault.ts';

test('lays out the link graph of a generated vault', async () => {
  const work = await mkdtemp(join(tmpdir(), 'myelin-bench-layout-test-'));
  try {
    await generateVault({ notes: 300, seed: 1, out: join(work, 'vault') });
    const graph = await vaultGraph(join(work, 'vault'));
    expect(graph.nodeCount).toBe(300);
    expect(graph.edges.length).toBeGreaterThan(600);
    const run = layoutRun(graph);
    expect(run.converged).toBe(true);
    expect(run.edgeRatio).toBeLessThan(0.6);
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}, 30_000);
