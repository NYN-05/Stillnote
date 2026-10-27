// Sweeps request rates with k6 and prints one comparison table.
//   node loadtest/run.mjs                                   # rates 100,300,600,1000 for 60s each
//   node loadtest/run.mjs --rates 100,200 --duration 30s --base-url http://localhost:8080
// Environment: K6 (path to the k6 binary), BASE_URL. Seed the database first (loadtest/seed.sh).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, index, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[index + 1]]] : pairs), []),
);
const rates = (args.rates || '100,300,600,1000').split(',').map(Number);
const duration = args.duration || '60s';
const baseUrl = args['base-url'] || process.env.BASE_URL || 'http://localhost:8080';
const outDir = join(import.meta.dirname, 'results');
mkdirSync(outDir, { recursive: true });

const k6 = [process.env.K6, 'k6', 'C:\\Program Files\\k6\\k6.exe'].filter(Boolean).find((candidate) => {
  const probe = spawnSync(candidate, ['version'], { stdio: 'ignore' });
  return probe.status === 0;
});
if (!k6) {
  console.error('k6 not found. Install it (winget install k6) or set K6 to the binary path.');
  process.exit(2);
}

const ms = (value) => (value === undefined ? '-' : value < 10 ? value.toFixed(1) : Math.round(value).toString());
const rows = [];

for (const rate of rates) {
  const summaryFile = join(outDir, `summary-${rate}rps.json`);
  console.log(`\n=== ${rate} req/s for ${duration} ===`);
  const result = spawnSync(
    k6,
    [
      'run',
      '--quiet',
      '--summary-export',
      summaryFile,
      '-e',
      `BASE_URL=${baseUrl}`,
      '-e',
      `RATE=${rate}`,
      '-e',
      `DURATION=${duration}`,
      join(import.meta.dirname, 'k6.js'),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  if (!existsSync(summaryFile)) {
    console.error(`k6 produced no summary for ${rate} req/s (exit ${result.status}).`);
    continue;
  }
  const { metrics } = JSON.parse(readFileSync(summaryFile, 'utf8'));
  const latency = metrics.http_req_duration;
  const dropped = metrics.dropped_iterations?.count ?? 0;
  const failedByStatus = Object.entries(metrics)
    .filter(([name, metric]) => name.startsWith('failed_by_status{status:') && metric.count > 0)
    .map(([name, metric]) => `${name.match(/status:(\d+)/)[1]}×${metric.count}`)
    .join(' ');
  rows.push({
    'target/s': rate,
    'achieved/s': Math.round(metrics.http_reqs.rate),
    'p50 ms': ms(latency.med),
    'p95 ms': ms(latency['p(95)']),
    'p99 ms': ms(latency['p(99)']),
    'max ms': ms(latency.max),
    'errors %': (100 * (metrics.http_req_failed.value ?? 0)).toFixed(2),
    dropped,
    'failures (status×count)': failedByStatus || '-',
    // k6 exits with 99 when any threshold fails (its summary file encodes this inversely).
    thresholds: result.status === 0 ? 'pass' : result.status === 99 ? 'FAIL' : `error ${result.status}`,
  });
}

console.log('\nBase URL:', baseUrl, '| duration per step:', duration);
console.table(rows);

// A failing step fails the run, so CI can gate on it (a sweep that probes for the ceiling will exit 1 by design).
if (rows.length === 0 || rows.some((row) => row.thresholds !== 'pass')) process.exitCode = 1;
