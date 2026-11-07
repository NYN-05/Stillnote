// Converts legacy Markdown notes to sanitized HTML in place.
//   node scripts/convert-content.js [--dry-run] [--batch-size 100]
//
// Guarantees:
//   - id, user_id, title, pinned, created_at and updated_at are untouched;
//   - version is bumped by exactly one, so a stale offline client gets a 409
//     instead of overwriting the converted HTML;
//   - an advisory lock makes concurrent runs on several API instances safe;
//   - rows that fail conversion stay Markdown and are reported, never dropped.
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createPool, migrate } = require('../src/db');
const { convertMarkdownNotes } = require('../src/contentMigration');

const DEFAULT_BATCH_SIZE = 100;

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const batchSize = option('batch-size', DEFAULT_BATCH_SIZE);
  const pool = createPool({ max: 2 });
  try {
    await migrate(pool);
    const result = await convertMarkdownNotes(pool, { dryRun, batchSize });
    const verb = dryRun ? 'Would convert' : 'Converted';
    console.log(`${verb} ${result.converted} note(s); examined ${result.examined}, skipped ${result.skipped}, failed ${result.failed}.`);
    if (result.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Content conversion failed: ${error.message}`);
  process.exit(1);
});
