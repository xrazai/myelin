// Typing latency of the editor (AGENTS.md, rule 6).
//   node scripts/bench.ts --editor            (or: node scripts/bench-editor.ts)
//   [--keys 200] [--out <file outside the repo>]
// Builds `bench-editor.page.ts` (the app's `cm-editor.ts` and theme) with Vite, opens it in
// the repo's Electron in a visible window, and types with real key events. Needs a desktop
// session. Per key, timed in the page:
//   work   keydown until the DOM is updated and laid out (main thread time; no paint).
//   frame  keydown until the next frame is painted: work, paint and the wait for vsync.
// Exits with 1 if a 10k-line case is over budget: p95 of `work` <= 16 ms (one 60 Hz frame).
// The 100-line case is the baseline: it shows how much the note's size costs.
// Run directly by Node (type stripping): erasable TypeScript only.

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const BUDGET_P95_WORK_MS = 16;
const CASES = [
  { name: '100 lines, middle', lines: 100, line: 43 },
  { name: '10k lines, top', lines: 10_000, line: 3 },
  { name: '10k lines, middle', lines: 10_000, line: 5003 },
  { name: '10k lines, end', lines: 10_000, line: 9998 },
];

/** One key, as `bench-editor.page.ts` times it. */
interface Sample {
  workMs: number;
  frameMs: number;
}

interface CaseResult {
  name: string;
  lines: number;
  /** Headings styled and raw marks left on screen before typing: live preview is at work. */
  headings: number;
  rawMarksAway: number;
  /** Characters the note grew by while typing. */
  typed: number;
  samples: Sample[];
}

const round = (value: number) => Math.round(value * 10) / 10;

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) => round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]!);
  return { p50: at(0.5), p95: at(0.95), max: round(sorted.at(-1)!) };
}

export async function benchEditor(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { keys: { type: 'string', default: '200' }, out: { type: 'string' } },
  });
  const keys = Number(values.keys);
  if (!Number.isInteger(keys) || keys < 20) throw new Error('keys must be an integer >= 20');
  const scripts = dirname(fileURLToPath(import.meta.url));
  const out = resolve(
    values.out ?? join(tmpdir(), 'myelin-bench', `${new Date().toISOString().replace(/[:.]/g, '-')}-editor.json`),
  );
  // Results are per machine: they are not committed.
  if (out.startsWith(resolve(scripts, '..'))) throw new Error(`output must be outside the repo: ${out}`);

  const work = await mkdtemp(join(tmpdir(), 'myelin-bench-editor-'));
  let report: { chrome: string; results: CaseResult[] };
  try {
    const { build } = await import('vite');
    await build({
      configFile: false,
      root: scripts,
      base: './',
      publicDir: false,
      logLevel: 'error',
      build: {
        outDir: join(work, 'page'),
        emptyOutDir: true,
        rolldownOptions: { input: join(scripts, 'bench-editor.page.html') },
      },
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // From Node, the `electron` package is the path of its binary.
    const electron = createRequire(import.meta.url)('electron') as unknown as string;
    const { stdout } = await promisify(execFile)(
      electron,
      [
        join(scripts, 'bench-editor.main.cjs'),
        join(work, 'page', 'bench-editor.page.html'),
        join(work, 'userData'),
        String(keys),
        JSON.stringify(CASES),
      ],
      { env, maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 },
    );
    const line = stdout.split('\n').find((text) => text.startsWith('BENCH '));
    if (!line) throw new Error(`no result from Electron: ${stdout}`);
    report = JSON.parse(line.slice('BENCH '.length)) as typeof report;
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }

  const results = report.results.map(({ samples, ...result }) => ({
    ...result,
    work: percentiles(samples.map((sample) => sample.workMs)),
    frame: percentiles(samples.map((sample) => sample.frameMs)),
    samples,
  }));
  const lines = [
    `Typing latency, ${keys} real key events per case, Chrome ${report.chrome}, ${cpus()[0]?.model.trim()}`,
    `${'ms'.padEnd(20)}${['work p50', 'p95', 'max', 'frame p50', 'p95', 'max'].map((head) => head.padStart(10)).join('')}`,
  ];
  for (const result of results) {
    const cells = [result.work, result.frame].flatMap(({ p50, p95, max }) => [p50, p95, max]);
    lines.push(`${result.name.padEnd(20)}${cells.map((cell) => String(cell).padStart(10)).join('')}`);
  }
  await mkdir(dirname(out), { recursive: true });
  await writeFile(
    out,
    `${JSON.stringify({ createdAt: new Date().toISOString(), chrome: report.chrome, keys, results }, null, 2)}\n`,
    'utf8',
  );
  console.log(`${lines.join('\n')}\n\nsaved: ${out}`);

  // A run where live preview or the typing did not happen would look fast: fail instead.
  for (const { name, headings, rawMarksAway, typed } of results) {
    if (headings === 0 || rawMarksAway > 1 || typed < keys / 2) {
      throw new Error(`"${name}" is not valid: ${JSON.stringify({ headings, rawMarksAway, typed })}`);
    }
  }
  const slow = results.filter((result) => result.lines >= 10_000 && result.work.p95 > BUDGET_P95_WORK_MS);
  if (slow.length > 0) {
    throw new Error(`over budget (p95 work > ${BUDGET_P95_WORK_MS} ms): ${slow.map((r) => r.name).join('; ')}`);
  }
  console.log(`within budget: p95 work <= ${BUDGET_P95_WORK_MS} ms on every 10k-line case`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  benchEditor(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
