const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const DEFAULT_DATABASE_URL = 'postgres://stillnote:stillnote@localhost:5432/stillnote';
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATION_LOCK_ID = 727_001;

function createPool(options = {}) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
    max: Number.parseInt(process.env.PG_POOL_MAX || '20', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...options,
  });
  // An idle client dropping its connection must not crash the process.
  pool.on('error', (error) => console.error('[Stillnote DB] idle client error:', error.message));
  return pool;
}

// Applies pending migrations in filename order. An advisory lock lets several
// server processes start at once without racing each other.
async function migrate(pool, directory = MIGRATIONS_DIR) {
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((row) => row.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(directory, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error.message}`, { cause: error });
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}

module.exports = { createPool, migrate, DEFAULT_DATABASE_URL };
