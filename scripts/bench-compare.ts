// Compares `bench.ts` results of a base and a PR and prints a Markdown table (`.github/workflows/bench.yml`).
//   node scripts/bench-compare.ts --base <folder of JSON files> --pr <folder of JSON files>
//                                 [--note <text>] [--out <file>]
// Each side may have several files (one per invocation): their runs are pooled.
// A regression is a warning in the table, never a failing exit code: shared runners are noisy.
// Run directly by Node (type stripping): erasable TypeScript only, `node:*` imports only.
// `bench.ts` is imported for types only: the base may be older than this script.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { BenchReport, SizeResult } from './bench.ts';

/** Identifies the PR comment, so the workflow updates it instead of adding another. */
export const MARKER = '<!-- myelin-bench -->';

/** A metric is flagged only if all hold: see `verdict`. */
export const THRESHOLD_PERCENT = 15;
export const FLOOR_MS = 20;

export type Verdict = 'slower' | 'noisy' | 'ok';

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/**
 * `slower`: the median grew by more than the threshold and the floor, and every PR run was slower
 * than every base run. `noisy`: the median grew that much, but the runs of both sides overlap.
 */
export function verdict(base: number[], pr: number[]): Verdict {
  const before = median(base);
  const delta = median(pr) - before;
  if (delta <= FLOOR_MS || delta <= (before * THRESHOLD_PERCENT) / 100) return 'ok';
  return Math.min(...pr) > Math.max(...base) ? 'slower' : 'noisy';
}

/** Why two reports cannot be compared at all, or null. Vaults are checked per size. */
function mismatch(a: BenchReport, b: BenchReport): string | null {
  if (a.format !== b.format) return `JSON format differs (${a.format} and ${b.format})`;
  if (a.runtime !== b.runtime) return `runtime differs (${a.runtime} and ${b.runtime})`;
  return null;
}

interface Pooled {
  hash: string;
  runs: SizeResult['runs'];
  metrics: string[];
}

/** One side's runs by vault size. Throws if its own files do not match each other. */
function pool(side: string, reports: BenchReport[]): Map<number, Pooled> {
  const sizes = new Map<number, Pooled>();
  for (const report of reports) {
    const reason = mismatch(reports[0]!, report);
    if (reason) throw new Error(`${side} results do not match each other: ${reason}`);
    for (const { notes, vault, runs, summary } of report.results) {
      const found = sizes.get(notes);
      if (!found) sizes.set(notes, { hash: vault.hash, runs: [...runs], metrics: Object.keys(summary) });
      else if (found.hash !== vault.hash) throw new Error(`${side} results do not match each other: vault hash`);
      else found.runs.push(...runs);
    }
  }
  return sizes;
}

const values = (pooled: Pooled, metric: string) =>
  pooled.runs.map((run) => (run as unknown as Record<string, number>)[metric]!);

const ms = (value: number) => `${Math.round(value)} ms`;
const range = (numbers: number[]) => `${ms(median(numbers))} (${Math.round(Math.min(...numbers))}-${Math.round(Math.max(...numbers))})`;
const signed = (value: number) => `${value > 0 ? '+' : ''}${value}`;
const short = (report: BenchReport) => report.versions.commit?.slice(0, 7) ?? 'unknown';

function versions({ versions: v }: BenchReport): string {
  return `Node ${v.node}, SQLite ${v.sqlite}, better-sqlite3 ${v.betterSqlite3}, index schema ${v.indexSchema}`;
}

export function compare(base: BenchReport[], pr: BenchReport[], note?: string): string {
  const lines = [MARKER, '### Benchmark: base vs PR', ''];
  const footer = () => [...(note ? ['', note] : [])];
  if (pr.length === 0) {
    lines.push('❌ **No result for the PR:** its benchmark did not finish. See the run log.');
    return [...lines, ...footer(), ''].join('\n');
  }
  const head = pr[0]!;
  const after = pool('PR', pr);
  const before = pool('base', base);
  const global = base.length === 0 ? 'the base produced no result (no benchmark there, or it failed)' : mismatch(base[0]!, head);
  if (global) lines.push(`ℹ️ **Base not comparable:** ${global}. PR numbers only.`, '');

  let slower = 0;
  const tables: string[] = [];
  for (const [notes, current] of after) {
    const old = before.get(notes);
    const reason =
      global ??
      (!old ? 'the base has no result for this size' : old.hash !== current.hash ? 'the vaults differ (other hash)' : null);
    tables.push(`**${notes} notes** (vault \`${current.hash.slice(0, 8)}\`, runs: base ${reason ? '—' : old!.runs.length}, PR ${current.runs.length})`, '');
    if (reason && !global) tables.push(`ℹ️ **Base not comparable:** ${reason}. PR numbers only.`, '');
    tables.push('| metric | base | PR | delta | |', '| --- | ---: | ---: | ---: | --- |');
    for (const metric of current.metrics) {
      const name = metric.replace(/Ms$/, '');
      const now = values(current, metric);
      if (reason || !old!.metrics.includes(metric)) {
        tables.push(`| ${name} | — | ${range(now)} | — | |`);
        continue;
      }
      const then = values(old!, metric);
      const delta = median(now) - median(then);
      const percent = median(then) > 0 ? ` (${signed(Math.round((delta / median(then)) * 1000) / 10)}%)` : '';
      const found = verdict(then, now);
      if (found === 'slower') slower++;
      const flag = { slower: '⚠️ slower', noisy: 'noisy: runs overlap', ok: '' }[found];
      tables.push(`| ${name} | ${range(then)} | ${range(now)} | ${signed(Math.round(delta))} ms${percent} | ${flag} |`);
    }
    tables.push('');
  }

  if (slower > 0) {
    lines.push(`⚠️ **${slower} metric(s) slower than the base** by more than ${THRESHOLD_PERCENT}%. Not a blocking check.`, '');
  } else if (!global) {
    lines.push('No regression flagged.', '');
  }
  lines.push(...tables);
  lines.push(
    `Median (min-max) in ms. ⚠️ = median more than ${THRESHOLD_PERCENT}% and ${FLOOR_MS} ms slower, ` +
      'and no PR run as fast as the slowest base run. cold, warm and reopen include a vault scan.',
    '',
    `Runtime ${head.runtime}, ${head.machine.cpu}, ${head.machine.threads} threads.`,
  );
  if (!global) lines.push(`Base \`${short(base[0]!)}\`: ${versions(base[0]!)}.`);
  lines.push(`PR \`${short(head)}\`: ${versions(head)}.`);
  return [...lines, ...footer(), ''].join('\n');
}

/** Every `*.json` in a folder. A missing folder is a side with no result. */
async function readReports(folder: string): Promise<BenchReport[]> {
  const names = await readdir(folder).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  return Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map(async (name) => JSON.parse(await readFile(join(folder, name), 'utf8')) as BenchReport),
  );
}

async function main(): Promise<void> {
  const { values: options } = parseArgs({
    options: {
      base: { type: 'string' },
      pr: { type: 'string' },
      note: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!options.base || !options.pr) throw new Error('--base and --pr are required');
  const markdown = compare(await readReports(options.base), await readReports(options.pr), options.note);
  if (options.out) await writeFile(options.out, markdown, 'utf8');
  console.log(markdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
