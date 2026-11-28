// GPU and CPU time per frame of @myelin/graph (AGENTS.md, Targets and rule 6), and an
// estimate for weak GPUs.
//   node scripts/bench.ts --graph             (or: node scripts/bench-graph.ts)
//   [--sizes 10000,50000,100000] [--seed 1] [--frames 120] [--label <text>]
//   [--out <file outside the repo>]
// Graphs: the links of `gen-vault` vaults, laid out by the library's solver until it settles
// (cached in `<tmp>/myelin-bench/layouts`; the first 100k layout takes minutes). The vault
// has no weights: seeded ones are added, to draw edges of different widths.
//
// `bench-graph.page.ts` draws them with the library's backend into an offscreen framebuffer,
// in a hidden window of the repo's Electron. Needs a GPU. The whole graph is in view, which
// draws every node and edge; zoomed views (ZOOMS) are measured over the same grid.
//
// Glow: the library's bloom, at each of its resolutions. The constellation glow is drawn
// as `zoomView` asks for at each camera.
//
// Budget (100k nodes, 2880x1800, glow at BUDGET_GLOW, p95): GPU <= 1.5 ms, CPU <= 4 ms.
// Checked with the whole graph in view, only on the GPU it is stated for; exits with 1 when
// over it. Zoomed views over the budget are printed and saved, and do not change the exit.
//
// Weak GPUs, a MODEL and not a measurement (expected error up to about 2x): per glow, fit
// gpu_ms = a * pixels + b * (nodes + edges) + c over the measured grid, one fit per camera,
// then scale `a` by memory bandwidth and `b` by FP32 throughput of each profile of
// `gpu-profiles.json`.
//
// Run directly by Node (type stripping): erasable TypeScript only.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { ForceAtlas2, type LayoutGraph } from '../packages/graph/src/layout/forceatlas2.ts';
import { mulberry32 } from '../packages/graph/src/layout/random.ts';
import { vaultGraph } from './bench-layout.ts';
import { cpuBusyPercent, isInside } from './bench.ts';
import { generateVault } from './gen-vault.ts';
import type { PageJob, Percentiles, Sample } from './bench-graph.types.ts';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPTS, '..');

const RESOLUTIONS: [number, number][] = [[1920, 1080], [2560, 1440], [2880, 1800]];
const GLOWS = [1, 0.5, 0.25, 0];
/** Cameras: 1 is the whole graph; the rest zoom into its center. */
const ZOOMS = [1, 2, 4, 16];
const BUDGET = { width: 2880, height: 1800, nodes: 100_000, gpuMs: 1.5, cpuMs: 4 };
/** The bloom resolution the budget is checked with: the library's chosen default. */
const BUDGET_GLOW = 0.5;
/** Device pixels per CSS pixel of every measured frame. */
const PIXEL_RATIO = 2;
/** The estimate is printed for these (nodes, resolution). */
const ESTIMATED: [number, [number, number]][] = [
  [10_000, [1920, 1080]],
  [50_000, [1920, 1080]],
  [100_000, [1920, 1080]],
  [100_000, [2880, 1800]],
];

export interface GpuProfile {
  id: string;
  name: string;
  /** Part of the WebGL renderer string of this GPU. */
  rendererMatch?: string;
  memoryBandwidthGBs: number;
  fp32GFlops: number;
}

export interface FitPoint {
  pixels: number;
  /** Nodes plus edges. */
  elements: number;
  gpuMs: number;
}

export interface Model {
  /** ms per pixel. */
  a: number;
  /** ms per node or edge. */
  b: number;
  /** ms per frame. */
  c: number;
  /** Largest |model - measured| / measured over the fitted points. */
  maxError: number;
}

/** Least squares over the columns in `used`, by the normal equations; null when singular. */
function solve(rows: number[][], values: number[], used: number[]): number[] | null {
  const size = used.length;
  const matrix = used.map((i) => [
    ...used.map((j) => rows.reduce((sum, row) => sum + row[i]! * row[j]!, 0)),
    rows.reduce((sum, row, r) => sum + row[i]! * values[r]!, 0),
  ]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let r = column + 1; r < size; r++) {
      if (Math.abs(matrix[r]![column]!) > Math.abs(matrix[pivot]![column]!)) pivot = r;
    }
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    if (Math.abs(matrix[column]![column]!) < 1e-12) return null;
    for (let r = 0; r < size; r++) {
      if (r === column) continue;
      const factor = matrix[r]![column]! / matrix[column]![column]!;
      for (let k = column; k <= size; k++) matrix[r]![k]! -= factor * matrix[column]![k]!;
    }
  }
  return matrix.map((row, i) => row[size]! / row[i]!);
}

/** `gpu_ms = a * pixels + b * elements + c` with a, b, c >= 0: a cost cannot be negative. */
export function fitModel(points: FitPoint[]): Model {
  // Millions, so that the columns have comparable sizes.
  const rows = points.map(({ pixels, elements }) => [pixels / 1e6, elements / 1e6, 1]);
  const values = points.map((point) => point.gpuMs);
  let best: { coefficients: number[]; residual: number } | null = null;
  // Non-negative least squares of three terms: the best subset whose solution is positive.
  for (let mask = 1; mask < 8; mask++) {
    const used = [0, 1, 2].filter((i) => mask & (1 << i));
    const solution = solve(rows, values, used);
    if (!solution || solution.some((value) => value < 0)) continue;
    const coefficients = [0, 0, 0];
    used.forEach((column, i) => (coefficients[column] = solution[i]!));
    const residual = rows.reduce(
      (sum, row, r) => sum + (row.reduce((total, x, i) => total + x * coefficients[i]!, 0) - values[r]!) ** 2,
      0,
    );
    if (!best || residual < best.residual) best = { coefficients, residual };
  }
  if (!best) throw new Error('no fit');
  const [a, b, c] = best.coefficients as [number, number, number];
  const model = { a: a / 1e6, b: b / 1e6, c };
  const maxError = Math.max(
    ...points.map(({ pixels, elements, gpuMs }) =>
      Math.abs(model.a * pixels + model.b * elements + model.c - gpuMs) / gpuMs,
    ),
  );
  return { ...model, maxError };
}

/**
 * The model's frame time on another GPU. `c`, the fixed cost, is not scaled: nothing says
 * what it is bound by.
 */
export function estimateMs(
  model: Model,
  reference: GpuProfile,
  profile: GpuProfile,
  pixels: number,
  elements: number,
): number {
  return (
    model.a * pixels * (reference.memoryBandwidthGBs / profile.memoryBandwidthGBs) +
    model.b * elements * (reference.fp32GFlops / profile.fp32GFlops) +
    model.c
  );
}

export interface GraphResult {
  nodeCount: number;
  edges: number;
  vaultHash: string;
  layout: { iterations: number; converged: boolean; cached: boolean };
  load: { cpuBusyPercent: number; gpuBefore: string | null };
  samples: Sample[];
}

const exec = promisify(execFile);

/** What other programs were doing to the GPU; null without `nvidia-smi`. */
async function gpuLoad(): Promise<string | null> {
  return exec('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used,clocks.sm', '--format=csv,noheader']).then(
    ({ stdout }) => stdout.trim(),
    () => null,
  );
}

async function solverHash(): Promise<string> {
  const hash = createHash('sha256');
  for (const file of ['forceatlas2.ts', 'quadtree.ts', 'random.ts']) {
    hash.update(await readFile(join(REPO_ROOT, 'packages/graph/src/layout', file), 'utf8'));
  }
  return hash.digest('hex').slice(0, 12);
}

interface Layout {
  positions: Float32Array;
  iterations: number;
  converged: boolean;
  cached: boolean;
}

async function layOut(graph: LayoutGraph, key: string, log: (line: string) => void): Promise<Layout> {
  const directory = join(tmpdir(), 'myelin-bench', 'layouts');
  const file = join(directory, `${key}.json`);
  const saved = await readFile(file, 'utf8').catch(() => null);
  if (saved) {
    const { positions, iterations, converged } = JSON.parse(saved) as {
      positions: string;
      iterations: number;
      converged: boolean;
    };
    const bytes = Uint8Array.from(Buffer.from(positions, 'base64'));
    return { positions: new Float32Array(bytes.buffer), iterations, converged, cached: true };
  }
  log(`${graph.nodeCount} nodes: laying out (cached afterwards)`);
  const solver = new ForceAtlas2(graph);
  while (!solver.done) solver.step();
  const { positions, iteration: iterations, converged } = solver;
  await mkdir(directory, { recursive: true });
  await writeFile(
    file,
    JSON.stringify({ positions: Buffer.from(positions.buffer).toString('base64'), iterations, converged }),
    'utf8',
  );
  return { positions, iterations, converged, cached: false };
}

function seededWeights(count: number, seed: number): Float32Array {
  const random = mulberry32(seed);
  return Float32Array.from({ length: count }, () => (random() < 0.05 ? 4 + random() * 12 : 0.3 + random()));
}

const bytes = (array: Float32Array | Uint32Array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

const sampleAt = (graph: GraphResult, [width, height]: [number, number], glow: number, zoom = 1) =>
  graph.samples.find((s) => s.width === width && s.height === height && s.glow === glow && s.zoom === zoom);

const glowName = (glow: number) => (glow === 0 ? 'off' : glow === 1 ? 'full' : `1/${1 / glow}`);

/** The zoomed views of the budget frame whose p95 is over a limit of the budget, as text. */
export function zoomedOverBudget(samples: Sample[], glow = BUDGET_GLOW): string[] {
  return samples
    .filter((s) => s.zoom !== 1 && s.width === BUDGET.width && s.height === BUDGET.height && s.glow === glow)
    .flatMap((s) => {
      const gpu = worst(s.gpuMs, s.gpuWithUploadMs)?.p95 ?? 0;
      const cpu = worst(s.cpuMs, s.cpuWithUploadMs)!.p95;
      return gpu > BUDGET.gpuMs || cpu > BUDGET.cpuMs ? [`x${s.zoom} GPU ${gpu} ms, CPU ${cpu} ms`] : [];
    });
}

const viewName = (zoom: number) => (zoom === 1 ? 'whole graph' : `zoom x${zoom}`);

/** The worst of a still frame and one that uploads a layout step first. */
const worst = (a: Percentiles | null, b: Percentiles | null): Percentiles | null =>
  a && b ? { median: Math.max(a.median, b.median), p95: Math.max(a.p95, b.p95) } : null;

function table(head: string[], rows: (string | number)[][], first = 24): string {
  const line = (cells: (string | number)[]) =>
    cells.map((cell, i) => (i === 0 ? String(cell).padEnd(first) : String(cell).padStart(11))).join('');
  return [line(head), ...rows.map(line)].join('\n');
}

export async function benchGraph(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      sizes: { type: 'string', default: '10000,50000,100000' },
      seed: { type: 'string', default: '1' },
      frames: { type: 'string', default: '120' },
      label: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const sizes = values.sizes.split(',').map(Number);
  const seed = Number(values.seed);
  const frames = Number(values.frames);
  if (!sizes.every((size) => Number.isInteger(size) && size > 0)) throw new Error('sizes must be integers > 0');
  if (!Number.isInteger(frames) || frames < 20) throw new Error('frames must be an integer >= 20');
  const out = resolve(
    values.out ?? join(tmpdir(), 'myelin-bench', `${new Date().toISOString().replace(/[:.]/g, '-')}-graph.json`),
  );
  // Results are per machine: they are not committed.
  if (isInside(REPO_ROOT, out)) throw new Error(`output must be outside the repo: ${out}`);
  const log = (line: string) => console.error(line);
  const { reference: referenceId, profiles } = JSON.parse(
    await readFile(join(SCRIPTS, 'gpu-profiles.json'), 'utf8'),
  ) as { reference: string; profiles: GpuProfile[] };
  const reference = profiles.find((profile) => profile.id === referenceId)!;

  const work = await mkdtemp(join(tmpdir(), 'myelin-bench-graph-'));
  const graphs: GraphResult[] = [];
  let machine = { chrome: '', renderer: '', timerQuery: false };
  try {
    const { build } = await import('vite');
    await build({
      configFile: false,
      root: SCRIPTS,
      base: './',
      publicDir: false,
      logLevel: 'error',
      build: {
        outDir: join(work, 'page'),
        emptyOutDir: true,
        rolldownOptions: { input: join(SCRIPTS, 'bench-graph.page.html') },
      },
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // From Node, the `electron` package is the path of its binary.
    const electron = createRequire(import.meta.url)('electron') as unknown as string;
    const solver = await solverHash();

    for (const size of sizes) {
      const vault = join(work, `vault-${size}`);
      log(`${size} nodes: generating the vault`);
      const { hash } = await generateVault({ notes: size, seed, out: vault });
      const graph = await vaultGraph(vault);
      const weights = seededWeights(graph.edges.length / 2, seed);
      const layout = await layOut(graph, `${hash.slice(0, 16)}-${solver}`, log);
      await rm(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });

      const files = { edges: join(work, 'edges'), weights: join(work, 'weights'), positions: join(work, 'positions') };
      await writeFile(files.edges, bytes(graph.edges));
      await writeFile(files.weights, bytes(weights));
      await writeFile(files.positions, bytes(layout.positions));
      const job: Omit<PageJob, 'edges' | 'weights' | 'positions' | 'nodeCount'> & { graphs: unknown[] } = {
        graphs: [{ nodeCount: graph.nodeCount, files }],
        resolutions: RESOLUTIONS,
        glows: GLOWS,
        zooms: ZOOMS,
        frames,
        pixelRatio: PIXEL_RATIO,
      };
      await writeFile(join(work, 'job.json'), JSON.stringify(job), 'utf8');

      const load = { cpuBusyPercent: await cpuBusyPercent(), gpuBefore: await gpuLoad() };
      const { stdout } = await exec(
        electron,
        [
          join(SCRIPTS, 'bench-graph.main.cjs'),
          join(work, 'page', 'bench-graph.page.html'),
          join(work, 'userData'),
          join(work, 'job.json'),
        ],
        { env, maxBuffer: 16 * 1024 * 1024, timeout: 8 * 60_000 },
      );
      const line = stdout.split('\n').find((text) => text.startsWith('BENCH '));
      if (!line) throw new Error(`no result from Electron: ${stdout}`);
      const { results, ...found } = JSON.parse(line.slice('BENCH '.length)) as typeof machine & {
        results: { edges: number; samples: Sample[] }[];
      };
      machine = found;
      // A software renderer would give numbers that say nothing about any GPU.
      if (/swiftshader|basic render|llvmpipe|software/i.test(machine.renderer)) {
        throw new Error(`not a GPU: ${machine.renderer}`);
      }
      const { edges, samples } = results[0]!;
      // A frame that drew nothing would look fast: fail instead.
      const empty = samples.find((sample) => sample.litShare < 0.001);
      if (empty) throw new Error(`nothing was drawn: ${JSON.stringify(empty)}`);
      graphs.push({
        nodeCount: graph.nodeCount,
        edges,
        vaultHash: hash,
        layout: { iterations: layout.iterations, converged: layout.converged, cached: layout.cached },
        load,
        samples,
      });
    }
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }

  const lines = [
    `${machine.renderer}`,
    `Chrome ${machine.chrome}, ${cpus()[0]?.model.trim()}, ${frames} frames per case, pixel ratio ${PIXEL_RATIO}` +
      (values.label ? `, ${values.label}` : ''),
    machine.timerQuery
      ? 'gpu = EXT_disjoint_timer_query_webgl2; cpu = main thread submission; ms, median / p95'
      : 'NO TIMER QUERY: gpu is the wall time of a synced batch (submission included), not GPU time',
    'cpu and gpu: the worse of a still frame and one that uploads new positions first.',
    'Glow is the bloom of the library, at that resolution.',
  ];
  for (const graph of graphs) {
    lines.push(
      '',
      `${graph.nodeCount} nodes, ${graph.edges} edges (vault ${graph.vaultHash.slice(0, 8)}, layout ` +
        `${graph.layout.iterations} iterations${graph.layout.converged ? '' : ', not settled'}); before: CPU ` +
        `${graph.load.cpuBusyPercent}% busy, nvidia-smi use, memory, clock: ${graph.load.gpuBefore ?? 'n/a'}`,
      table(
        ['view, glow', 'gpu med', 'gpu p95', 'cpu med', 'cpu p95', 'synced', 'lit %'],
        graph.samples.map((s) => {
          const gpu = worst(s.gpuMs, s.gpuWithUploadMs);
          const cpu = worst(s.cpuMs, s.cpuWithUploadMs)!;
          return [
            `${s.width}x${s.height} ${glowName(s.glow)}${s.zoom === 1 ? '' : ` zoom x${s.zoom}`}`,
            gpu?.median ?? '-',
            gpu?.p95 ?? '-',
            cpu.median,
            cpu.p95,
            s.syncedFrameMs,
            Math.round(s.litShare * 1000) / 10,
          ];
        }),
      ),
    );
  }

  const models = ZOOMS.flatMap((zoom) =>
    GLOWS.map((glow) => {
      const points = graphs.flatMap((graph) =>
        RESOLUTIONS.map((size) => {
          const sample = sampleAt(graph, size, glow, zoom)!;
          return {
            pixels: size[0] * size[1],
            elements: graph.nodeCount + graph.edges,
            gpuMs: sample.gpuMs?.median ?? sample.syncedFrameMs,
          };
        }),
      );
      return { zoom, glow, ...fitModel(points) };
    }),
  );
  const estimates: Record<string, number | string>[] = [];
  // With one size, the pixel and the geometry terms cannot be told apart.
  if (graphs.length > 1) {
    lines.push(
      '',
      'Fit of the median gpu ms of a still frame: a * pixels + b * (nodes + edges) + c, per camera',
      table(
        ['view, glow', 'a ms/Mpx', 'b ms/M', 'c ms', 'max error'],
        models.map((m) => [
          `${viewName(m.zoom)}, ${glowName(m.glow)}`,
          (m.a * 1e6).toFixed(4),
          (m.b * 1e6).toFixed(3),
          m.c.toFixed(3),
          `${Math.round(m.maxError * 100)}%`,
        ]),
      ),
      '',
      'ESTIMATE, a model and not a measurement (expected error up to about 2x): GPU-bound FPS.',
      'The CPU, the browser compositor and vsync are not in it.',
    );
    for (const zoom of ZOOMS) {
      for (const [nodes, [width, height]] of ESTIMATED) {
        const graph = graphs.find((each) => each.nodeCount === nodes);
        // Zoomed in, only the largest graph is shown.
        if (!graph || (zoom !== 1 && nodes !== BUDGET.nodes)) continue;
        const rows = profiles.map((profile) => [
          profile.name,
          ...models
            .filter((model) => model.zoom === zoom)
            .map((model) => {
              const ms = estimateMs(model, reference, profile, width * height, graph.nodeCount + graph.edges);
              estimates.push({ profile: profile.id, zoom, nodes, width, height, glow: model.glow, ms, fps: 1000 / ms });
              return Math.round(1000 / ms);
            }),
        ]);
        lines.push('', `${nodes} nodes at ${width}x${height}, ${viewName(zoom)}, FPS by glow`);
        lines.push(table(['profile', ...GLOWS.map(glowName)], rows, 48));
      }
    }
  }

  const budgetGraph = graphs.find((graph) => graph.nodeCount === BUDGET.nodes);
  const overBudgetZoomed = budgetGraph
    ? [BUDGET_GLOW, 1].map((glow) => ({ glow, views: zoomedOverBudget(budgetGraph.samples, glow) }))
    : null;

  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    `${JSON.stringify(
      { createdAt: new Date().toISOString(), label: values.label ?? null, seed, frames, pixelRatio: PIXEL_RATIO, ...machine, graphs, models, estimates, overBudgetZoomed },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log(`${lines.join('\n')}\n\nsaved: ${out}`);

  if (!budgetGraph) return void console.log(`budget not checked: it needs ${BUDGET.nodes} nodes`);
  if (!reference.rendererMatch || !machine.renderer.includes(reference.rendererMatch)) {
    return void console.log(`budget not checked: it is stated for the ${reference.name}`);
  }
  if (!machine.timerQuery) throw new Error('budget not checked: no GPU timer query on this machine');
  const sample = sampleAt(budgetGraph, [BUDGET.width, BUDGET.height], BUDGET_GLOW)!;
  const gpu = worst(sample.gpuMs, sample.gpuWithUploadMs)!.p95;
  const cpu = worst(sample.cpuMs, sample.cpuWithUploadMs)!.p95;
  const verdict =
    `${BUDGET.nodes} nodes at ${BUDGET.width}x${BUDGET.height}, glow ${glowName(BUDGET_GLOW)}, p95: ` +
    `GPU ${gpu} ms (budget ${BUDGET.gpuMs}), CPU ${cpu} ms (budget ${BUDGET.cpuMs})`;
  if (gpu > BUDGET.gpuMs || cpu > BUDGET.cpuMs) throw new Error(`over budget with the whole graph in view: ${verdict}`);
  console.log(`within budget with the whole graph in view: ${verdict}`);
  for (const { glow, views } of overBudgetZoomed!) {
    if (views.length === 0) continue;
    console.log(`OVER BUDGET ZOOMED IN (same frame, glow ${glowName(glow)}, p95): ${views.join('; ')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  benchGraph(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
