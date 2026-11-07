const { markdownToHtml, htmlToPlainText, policy } = require('./content');

const CONVERSION_LOCK_ID = 727_002;
const EMPTY_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Converts every row tagged `markdown` to sanitized HTML.
 *
 * The row's identity, owner, title, pin, created_at and updated_at are left
 * alone. `version` is bumped by exactly one, so a client holding the old
 * version gets a 409 instead of overwriting the converted content.
 *
 * An advisory lock makes concurrent calls from several API instances safe.
 * The scan is keyset-based, so failed rows are reported and skipped without
 * blocking the rest of the migration.
 */
async function convertMarkdownNotes(pool, { dryRun = false, batchSize = 100, log = console } = {}) {
  const size = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 100;
  const client = await pool.connect();
  const result = { converted: 0, skipped: 0, failed: 0, examined: 0, failures: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [CONVERSION_LOCK_ID]);

    let cursor = { userId: EMPTY_UUID, id: '' };
    for (;;) {
      const { rows } = await client.query(
        `SELECT user_id, id, content, version
         FROM notes
         WHERE content_format = 'markdown' AND (user_id, id) > ($1::uuid, $2::text)
         ORDER BY user_id, id
         LIMIT $3`,
        [cursor.userId, cursor.id, size],
      );
      if (rows.length === 0) break;
      cursor = { userId: rows[rows.length - 1].user_id, id: rows[rows.length - 1].id };

      for (const row of rows) {
        result.examined += 1;
        let html;
        try {
          html = markdownToHtml(row.content);
          if (html.length > policy.maxContentLength) {
            throw new Error(`converted HTML is ${html.length} characters (limit ${policy.maxContentLength})`);
          }
        } catch (error) {
          result.failed += 1;
          result.failures.push({ userId: row.user_id, id: row.id, message: error.message });
          log.error(`FAILED ${row.user_id}/${row.id}: ${error.message}`);
          continue;
        }

        if (dryRun) {
          log.log(`WOULD CONVERT ${row.user_id}/${row.id} (version ${row.version} -> ${row.version + 1})`);
          result.converted += 1;
          continue;
        }

        const update = await client.query(
          `UPDATE notes
           SET content = $4,
               content_format = 'html',
               content_schema_version = $5,
               plain_text = $6,
               version = version + 1
           WHERE user_id = $1 AND id = $2 AND content_format = 'markdown' AND version = $3`,
          [row.user_id, row.id, row.version, html, policy.schemaVersion, htmlToPlainText(html)],
        );
        if (update.rowCount === 1) {
          result.converted += 1;
        } else {
          result.skipped += 1;
          log.warn(`SKIPPED ${row.user_id}/${row.id}: changed while converting`);
        }
      }
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [CONVERSION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

module.exports = { convertMarkdownNotes };
