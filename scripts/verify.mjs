// Runs the same checks as CI, in order, and stops at the first failure.
// A script (not `a && b` in package.json) so it behaves the same in bash, cmd and PowerShell.
import { spawnSync } from 'node:child_process';

const steps = [
  ['Lint', 'lint'],
  ['Formatting', 'format:check'],
  ['Types', 'typecheck'],
  ['API tests (needs PostgreSQL: npm run db:up)', 'test'],
  ['Client tests', 'test:client'],
  ['Build', 'build'],
];

for (const [label, script] of steps) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\nFailed at "${label}".`);
    process.exit(result.status ?? 1);
  }
}
console.log('\nAll checks passed.');
