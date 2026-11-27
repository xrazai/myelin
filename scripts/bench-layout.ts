// First layout time of @myelin/graph on `gen-vault` link graphs (AGENTS.md, rule 6).
//   node scripts/bench-layout.ts [--sizes 10000,100000] [--runs 3] [--seed 1]
//                                [--label <text>] [--out <file outside the repo>]
// Prints a table and saves JSON (default: `<tmp>/myelin-bench/<timestamp>-layout.json`).
//
// Measured: the solver from construction until it settles, on one thread of this Node
// process. No worker, no messages and no drawing: the worker adds one copy of the
// positions per update. Generating the vault and reading its links are not measured.
//
// Run directly by Node (type stripping): erasable TypeScript only.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_OPTIONS, ForceAtlas2, type LayoutGraph } from '../packages/graph/src/layout/forceatlas2.ts';
import { cpuBusyPercent, isInside, stats } from './bench.ts';
import { generateVault } from './gen-vault.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The links between existing notes: one edge per linked pair. Basenames are unique. */
export async function vaultGraph(vault: string): Promise<LayoutGraph> {
  const files = (await readdir(vault, { recursive: true })).filter((file) => file.endsWith('.md')).sort();
  const ids = new Map(files.map((file, id) => [basename(file, '.md'), id]));
  const pairs = new Set<number>();
  const edges: number[] = [];
  for (const [source, file] of files.entries()) {
    const text = await readFile(join(vault, file), 'utf8');
    for (const match of text.matchAll(/\[\[([^\]|]+)/g)) {
      const target = ids.get(match[1]!.normalize('NFC'));
      if (target === undefined || target === source) continue;
      const pair = Math.min(source, target) * files.length + Math.max(source, target);
      if (pairs.has(pair)) continue;
      pairs.add(pair);
      edges.push(source, target);
    }
  }
  return { nodeCount: files.length, edges: Uint32Array.from(edges) };
}

export interface LayoutRun {
  ms: number;
  iterations: number;
  msPerIteration: number;
  /** False when it stopped at `maxIterations`. */
  converged: boolean;
  /** Median edge length over the median distance of random pairs: lower is clearer. */
  edgeRatio: number;
}

const median = (values: Float64Array) => values.sort()[values.length >> 1] ?? 0;

/** A check that a fast run did not just stop early. */
function edgeRatio(positions: Float32Array, { nodeCount, edges }: LayoutGraph): number {
  const length = (a: number, b: number) =>
    Math.hypot(positions[a * 2]! - positions[b * 2]!, positions[a * 2 + 1]! - positions[b * 2 + 1]!);
  const linked = Float64Array.from({ length: edges.length / 2 }, (_, e) => length(edges[e * 2]!, edges[e * 2 + 1]!));
  // Fixed strides spread the pairs over all nodes without a random generator.
  const random = Float64Array.from({ length: 20_000 }, (_, i) =>
    length((i * 7919) % nodeCount, (i * 104_729 + (nodeCount >> 1)) % nodeCount),
  );
  return median(linked) / median(random);
}

export function layoutRun(graph: LayoutGraph, maxIterations?: number): LayoutRun {
  const start = performance.now();
  const layout = new ForceAtlas2(graph, maxIterations === undefined ? {} : { maxIterations });
  while (!layout.done) layout.step();
  const ms = performance.now() - start;
  return {
    ms: Math.round(ms),
    iterations: layout.iteration,
    msPerIteration: Math.round((ms / Math.max(1, layout.iteration)) * 100) / 100,
    converged: layout.converged,
    edgeRatio: Math.round(edgeRatio(layout.positions, graph) * 1e4) / 1e4,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      sizes: { type: 'string', default: '10000,100000' },
      runs: { type: 'string', default: '3' },
      seed: { type: 'string', default: '1' },
      label: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be an integer >= 1');
  const seed = Number(values.seed);
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-layout.json`;
  const out = resolve(values.out ?? join(tmpdir(), 'myelin-bench', name));
  // Results are per machine: they are not committed.
  if (isInside(REPO_ROOT, out)) throw new Error(`output must be outside the repo: ${out}`);

  const results = [];
  for (const notes of values.sizes.split(',').map(Number)) {
    const work = await mkdtemp(join(tmpdir(), 'myelin-bench-layout-'));
    let graph: LayoutGraph;
    let hash: string;
    try {
      console.error(`${notes} notes: generating`);
      ({ hash } = await generateVault({ notes, seed, out: join(work, 'vault') }));
      graph = await vaultGraph(join(work, 'vault'));
    } finally {
      // Windows may hold a file for a moment (antivirus, indexer).
      await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error: unknown) => {
        console.error(`could not delete ${work}: ${String(error)}`);
      });
    }
    const done = [];
    for (let run = 1; run <= runs; run++) {
      const busy = await cpuBusyPercent();
      const result = { cpuBusyPercent: busy, ...layoutRun(graph) };
      console.error(`${notes} notes, run ${run}/${runs}: ${JSON.stringify(result)}`);
      done.push(result);
    }
    results.push({
      notes,
      edges: graph.edges.length / 2,
      vaultHash: hash,
      summary: stats(done.map((run) => run.ms)),
      runs: done,
    });
  }

  const report = {
    createdAt: new Date().toISOString(),
    label: values.label ?? null,
    cpu: `${cpus()[0]?.model.trim() ?? 'unknown'}, ${cpus().length} threads`,
    node: process.versions.node,
    seed,
    options: DEFAULT_OPTIONS,
    results,
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`${report.cpu}, Node ${report.node}, seed ${seed}${report.label ? `, ${report.label}` : ''}`);
  console.log('first layout, solver only, one thread; vault generation not included');
  for (const { notes, edges, summary, runs } of results) {
    const busy = stats(runs.map((run) => run.cpuBusyPercent));
    const { iterations, converged, edgeRatio } = runs[0]!;
    console.log(
      `${notes} notes, ${edges} edges: median ${(summary.median / 1000).toFixed(1)} s ` +
        `(min ${(summary.min / 1000).toFixed(1)}, max ${(summary.max / 1000).toFixed(1)}), ` +
        `${iterations} iterations, ${converged ? 'settled' : 'NOT settled'}, edge ratio ${edgeRatio}, ` +
        `CPU busy before a run ${busy.min}-${busy.max}%`,
    );
  }
  console.log(`\nsaved: ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
