const { randomUUID } = require('node:crypto');
const { StoreError } = require('./storeError');
const { markdownToHtml, normalizeContent, policy } = require('./content');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const SNIPPET_LENGTH = 200;

const FULL_COLUMNS = 'id, title, content, content_format, content_schema_version, pinned, version, created_at, updated_at';
// List snippets come from `plain_text`, so users never see HTML tags or Markdown syntax.
// Legacy rows that have not been converted yet fall back to their raw content.
const SUMMARY_COLUMNS = `id, title,
  left(CASE WHEN content_format = 'html' THEN plain_text ELSE content END, ${SNIPPET_LENGTH}) AS snippet,
  content_format, content_schema_version, pinned, version, created_at, updated_at`;

class DocumentStore {
  constructor(pool) {
    this.pool = pool;
  }

  async ping() {
    await this.pool.query('SELECT 1');
  }

  // Returns summaries (no full content) newest first. `cursor` is opaque to callers.
  async list(userId, { limit = DEFAULT_PAGE_SIZE, cursor } = {}) {
    const pageSize = clampLimit(limit);
    const after = cursor ? decodeCursor(cursor) : null;
    const { rows } = await this.pool.query(
      `SELECT ${SUMMARY_COLUMNS} FROM notes
       WHERE user_id = $1 AND deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR (updated_at, id) < ($2::timestamptz, $3::text))
       ORDER BY updated_at DESC, id DESC
       LIMIT $4`,
      [userId, after?.updatedAt ?? null, after?.id ?? null, pageSize + 1],
    );
    const hasMore = rows.length > pageSize;
    const page = hasMore ? rows.slice(0, pageSize) : rows;
    return {
      documents: page.map(toSummary),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    };
  }

  async get(userId, id) {
    const { rows } = await this.pool.query(`SELECT ${FULL_COLUMNS} FROM notes WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`, [
      userId,
      id,
    ]);
    return rows[0] ? toDocument(rows[0]) : null;
  }

  async create(userId, input) {
    const values = validateInput(input);
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : randomUUID();
    if (id.length > 100) {
      throw new StoreError('Document ID must be 100 characters or fewer.', 400, 'INVALID_ID');
    }
    const now = new Date();
    const createdAt = clampToNow(validTimestamp(input.createdAt), now);
    const updatedAt = clampToNow(validTimestamp(input.updatedAt), now);

    // Soft-deleted rows keep their ID, so a re-create of a deleted ID also conflicts.
    const { rows } = await this.pool.query(
      `INSERT INTO notes (user_id, id, title, content, content_format, content_schema_version, plain_text, pinned, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, id) DO NOTHING
       RETURNING ${FULL_COLUMNS}`,
      [
        userId,
        id,
        values.title,
        values.content,
        values.contentFormat,
        values.contentSchemaVersion,
        values.plainText,
        values.pinned,
        createdAt,
        updatedAt,
      ],
    );
    if (!rows[0]) throw new StoreError('A document with this ID already exists.', 409, 'DOCUMENT_EXISTS');
    return toDocument(rows[0]);
  }

  // `input.version`, when present, makes the write conditional on the stored version.
  async update(userId, id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new StoreError('Request body must be a JSON object.', 400, 'INVALID_BODY');
    }
    const hasTitle = hasOwn(input, 'title');
    const hasContent = hasOwn(input, 'content');
    const hasPinned = hasOwn(input, 'pinned');
    if (!hasTitle && !hasContent && !hasPinned) {
      throw new StoreError('Provide a title, content, and/or pinned to update.', 400, 'EMPTY_UPDATE');
    }
    const title = hasTitle ? validateTitle(input.title) : null;
    // A legacy client sends content with no format; it is converted to HTML here,
    // so Markdown can never be stored under an HTML tag by accident.
    const content = hasContent
      ? normalizeContent({
          content: input.content,
          contentFormat: input.contentFormat,
          contentSchemaVersion: input.contentSchemaVersion,
        })
      : null;
    const pinned = hasPinned ? validatePinned(input.pinned) : null;
    const expectedVersion = hasOwn(input, 'version') && input.version !== null ? validateVersion(input.version) : null;
    const now = new Date();
    // Preserve the client timestamp when syncing an offline edit; otherwise use server time.
    const updatedAt = clampToNow(validTimestamp(input.updatedAt), now);

    const { rows } = await this.pool.query(
      `UPDATE notes
       SET title = COALESCE($2, title),
           content = COALESCE($3, content),
           content_format = COALESCE($4, content_format),
           content_schema_version = COALESCE($5, content_schema_version),
           plain_text = COALESCE($6, plain_text),
           pinned = COALESCE($10::boolean, pinned),
           version = version + 1,
           updated_at = $7
       WHERE user_id = $9 AND id = $1 AND deleted_at IS NULL AND ($8::integer IS NULL OR version = $8::integer)
       RETURNING ${FULL_COLUMNS}`,
      [
        id,
        title,
        content?.content ?? null,
        content?.contentFormat ?? null,
        content?.contentSchemaVersion ?? null,
        content?.plainText ?? null,
        updatedAt,
        expectedVersion,
        userId,
        pinned,
      ],
    );
    if (rows[0]) return toDocument(rows[0]);

    // Nothing updated: either the note is gone or the caller's version is stale.
    const current = await this.get(userId, id);
    if (!current) throw new StoreError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
    throw new StoreError('The document was changed by another session.', 409, 'VERSION_CONFLICT', { current });
  }

  async delete(userId, id) {
    const { rowCount } = await this.pool.query(
      'UPDATE notes SET deleted_at = now(), version = version + 1 WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL',
      [userId, id],
    );
    if (rowCount === 0) throw new StoreError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
  }

  async getCollaborationState(userId, id) {
    const { rows } = await this.pool.query('SELECT state FROM document_collaboration WHERE user_id = $1 AND document_id = $2', [
      userId,
      id,
    ]);
    return rows[0]?.state ?? null;
  }

  async saveCollaborationState(userId, id, state, content) {
    const normalized = normalizeContent({ content, contentFormat: 'html', contentSchemaVersion: policy.schemaVersion });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE notes
         SET content = $3, content_format = 'html', content_schema_version = $4,
             plain_text = $5, version = version + 1, updated_at = now()
         WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
         RETURNING version`,
        [userId, id, normalized.content, normalized.contentSchemaVersion, normalized.plainText],
      );
      if (!rows[0]) throw new StoreError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
      await client.query(
        `INSERT INTO document_collaboration (user_id, document_id, state)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, document_id)
         DO UPDATE SET state = EXCLUDED.state, updated_at = now()`,
        [userId, id, state],
      );
      await client.query(
        `INSERT INTO document_versions (user_id, document_id, version, content)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [userId, id, rows[0].version, normalized.content],
      );
      await client.query('COMMIT');
      return rows[0].version;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listVersions(userId, id) {
    const { rows } = await this.pool.query(
      `SELECT version, content, created_at
       FROM document_versions
       WHERE user_id = $1 AND document_id = $2
       ORDER BY version DESC LIMIT 50`,
      [userId, id],
    );
    return rows.map((row) => ({ version: row.version, content: row.content, createdAt: row.created_at.toISOString() }));
  }

  async restoreVersion(userId, id, version) {
    const { rows } = await this.pool.query(
      'SELECT content FROM document_versions WHERE user_id = $1 AND document_id = $2 AND version = $3',
      [userId, id, version],
    );
    if (!rows[0]) throw new StoreError('Document version not found.', 404, 'VERSION_NOT_FOUND');
    return this.update(userId, id, { content: rows[0].content, contentFormat: 'html' });
  }
}

function toDocument(row) {
  // A row that has not been converted yet is served as sanitized HTML so every
  // client sees one format. Saving the note persists that HTML.
  const legacy = row.content_format === 'markdown';
  return {
    id: row.id,
    title: row.title,
    content: legacy ? markdownToHtml(row.content) : row.content,
    contentFormat: 'html',
    contentSchemaVersion: legacy ? policy.schemaVersion : row.content_schema_version,
    pinned: row.pinned,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSummary(row) {
  return {
    id: row.id,
    title: row.title,
    snippet: row.snippet,
    contentFormat: 'html',
    contentSchemaVersion: policy.schemaVersion,
    pinned: row.pinned,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new StoreError('Request body must be a JSON object.', 400, 'INVALID_BODY');
  }
  return {
    title: hasOwn(input, 'title') ? validateTitle(input.title) : policy.defaultNoteTitle,
    ...normalizeContent({
      content: hasOwn(input, 'content') ? input.content : '',
      contentFormat: input.contentFormat,
      contentSchemaVersion: input.contentSchemaVersion,
    }),
    pinned: hasOwn(input, 'pinned') ? validatePinned(input.pinned) : false,
  };
}

function validateTitle(value) {
  if (typeof value !== 'string') {
    throw new StoreError('Title must be a string.', 400, 'INVALID_TITLE');
  }
  const title = value.trim() || policy.defaultNoteTitle;
  if (title.length > policy.maxTitleLength) {
    throw new StoreError(`Title must be ${policy.maxTitleLength} characters or fewer.`, 400, 'TITLE_TOO_LONG');
  }
  return title;
}

function validatePinned(value) {
  if (typeof value !== 'boolean') {
    throw new StoreError('Pinned must be true or false.', 400, 'INVALID_PINNED');
  }
  return value;
}

function validateVersion(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new StoreError('Version must be a positive integer.', 400, 'INVALID_VERSION');
  }
  return value;
}

function validTimestamp(value) {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

// A client clock running ahead must not pin a note to the top of the list forever.
function clampToNow(date, now) {
  return date && date.getTime() <= now.getTime() ? date : now;
}

function clampLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.updated_at.toISOString(), row.id])).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [updatedAt, id] = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof id !== 'string' || !Number.isFinite(Date.parse(updatedAt))) throw new Error('bad cursor');
    return { updatedAt, id };
  } catch {
    throw new StoreError('Cursor is invalid.', 400, 'INVALID_CURSOR');
  }
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

module.exports = { DocumentStore };
