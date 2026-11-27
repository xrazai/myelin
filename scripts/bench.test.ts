import { expect, test } from 'vitest';
import { formatReport, METRICS, runBench, stats } from './bench';

test('summarizes repeated measurements', () => {
  expect(stats([30, 10, 20])).toEqual({ min: 10, median: 20, max: 30, spreadPercent: 100 });
  expect(stats([10, 20])).toEqual({ min: 10, median: 15, max: 20, spreadPercent: 66.7 });
});

// Also what catches a change in the index that breaks the benchmark.
test('measures a small vault in its own process', async () => {
  const report = await runBench({ sizes: [100], runs: 2, seed: 1, runtime: 'node' });
  expect(report.runtime).toBe('node');
  expect(report.versions.electron).toBeNull();
  const [result] = report.results;
  expect(result!.vault.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(result!.runs).toHaveLength(2);
  expect(result!.runs[0]!.sync.cold).toMatchObject({ notes: 100, indexed: 100, failed: 0 });
  expect(result!.runs[0]!.sync.reopen).toMatchObject({ notes: 100, indexed: 0, failed: 0 });
  for (const metric of METRICS) expect(result!.summary[metric].median).toBeGreaterThan(0);
  expect(formatReport(report)).toContain('100 notes');
}, 60_000);
