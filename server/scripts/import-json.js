// One-off import of the legacy JSON store into an existing account:
//   node scripts/import-json.js you@example.com [path/to/documents.json]
const fs = require('node:fs/promises');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createPool, migrate } = require('../src/db');
const { DocumentStore } = require('../src/documentStore');

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) throw new Error('Usage: import-json.js <email of an existing account> [documents.json]');
  const file = path.resolve(process.argv[3] || path.join(__dirname, '..', 'data', 'documents.json'));
  const items = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(items)) throw new Error('The JSON store root must be an array.');

  const pool = createPool();
  try {
    await migrate(pool);
    const owner = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
    if (!owner) throw new Error(`No account for ${email}. Register it first.`);
    const store = new DocumentStore(pool);
    let imported = 0;
    let skipped = 0;
    for (const item of items) {
      try {
        await store.create(owner.id, item);
        imported += 1;
      } catch (error) {
        skipped += 1;
        console.warn(`Skipped ${item?.id ?? '(no id)'}: ${error.message}`);
      }
    }
    console.log(`Imported ${imported} document(s), skipped ${skipped}, from ${file}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
