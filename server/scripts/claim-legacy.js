// Moves notes that predate user accounts to a real account:
//   node scripts/claim-legacy.js you@example.com
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { createPool } = require('../src/db');

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) throw new Error('Usage: claim-legacy.js <email of an existing account>');
  const pool = createPool();
  try {
    const target = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0];
    if (!target) throw new Error(`No account for ${email}. Register it first.`);
    const result = await pool.query(
      `UPDATE notes SET user_id = $1
       WHERE user_id = (SELECT id FROM users WHERE email = 'legacy@stillnote.local')`,
      [target.id],
    );
    console.log(`Moved ${result.rowCount} note(s) to ${email}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
