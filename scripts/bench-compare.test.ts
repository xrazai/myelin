import { expect, test } from 'vitest';
import type { BenchReport } from './bench';
import { compare, MARKER, verdict } from './bench-compare';

/** Only what the comparison reads. */
function report(coldMs: number, change: { format?: number; runtime?: string; hash?: string } = {}): BenchReport {
  return {
    format: change.format ?? 1,
    runtime: change.runtime ?? 'node',
    machine: { cpu: 'cpu', threads: 4 },
    versions: { node: '24', sqlite: '3', betterSqlite3: '13', indexSchema: 1, commit: 'abcdef012345' },
    results: [
      {
        notes: 10000,
        vault: { hash: change.hash ?? 'aaaaaaaaaaaa' },
        summary: { coldMs: {} },
        runs: [{ coldMs }],
      },
    ],
  } as unknown as BenchReport;
}

test('flags a regression only above the threshold, the floor and the base runs', () => {
  expect(verdict([1000, 1010, 1020], [1300, 1310, 1320])).toBe('slower');
  expect(verdict([1000, 1010, 1400], [1300, 1310, 1320])).toBe('noisy');
  expect(verdict([1000, 1010, 1020], [1100, 1110, 1120])).toBe('ok');
  // +100%, but only 10 ms.
  expect(verdict([10, 10, 10], [20, 20, 20])).toBe('ok');
  expect(verdict([1300, 1310, 1320], [1000, 1010, 1020])).toBe('ok');
});

test('pools the runs of each side into one table', () => {
  const markdown = compare([report(1000), report(1100)], [report(1500), report(1600)], 'a note');
  expect(markdown.startsWith(MARKER)).toBe(true);
  expect(markdown).toContain('runs: base 2, PR 2');
  expect(markdown).toContain('| cold | 1050 ms (1000-1100) | 1550 ms (1500-1600) | +500 ms (+47.6%) | ⚠️ slower |');
  expect(markdown).toContain('1 metric(s) slower');
  expect(markdown).toContain('a note');
});

test('says when the base is not comparable, without base numbers or deltas', () => {
  const cases: [BenchReport[], string][] = [
    [[], 'the base produced no result'],
    [[report(1000, { format: 2 })], 'JSON format differs'],
    [[report(1000, { runtime: 'electron-as-node' })], 'runtime differs'],
    [[report(1000, { hash: 'bbbbbbbbbbbb' })], 'the vaults differ'],
  ];
  for (const [base, reason] of cases) {
    const markdown = compare(base, [report(2000)]);
    expect(markdown).toContain(`**Base not comparable:** ${reason}`);
    expect(markdown).toContain('| cold | — | 2000 ms (2000-2000) | — | |');
    expect(markdown).not.toContain('1000 ms');
    expect(markdown).not.toContain('slower than the base');
  }
});

test('reports a PR without results and rejects a side that mixes vaults', () => {
  expect(compare([report(1000)], [])).toContain('No result for the PR');
  expect(() => compare([], [report(1), report(1, { hash: 'bbbbbbbbbbbb' })])).toThrow('do not match each other');
});
