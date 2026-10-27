const { randomUUID } = require('node:crypto');

const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_LENGTH = 500_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const SNIPPET_LENGTH = 200;

const FULL_COLUMNS = 'id, title, content, pinned, version, created_at, updated_at';
const SUMMARY_COLUMNS = `id, title, left(content, ${SNIPPET_LENGTH}) AS snippet, pinned, version, created_at, updated_at`;

class StoreError extends Error {
  constructor(message, statusCode = 500, code = 'STORE_ERROR', details) {
    super(message);
    this.name = 'StoreError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

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
      `INSERT INTO notes (user_id, id, title, content, pinned, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, id) DO NOTHING
       RETURNING ${FULL_COLUMNS}`,
      [userId, id, values.title, values.content, values.pinned, createdAt, updatedAt],
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
    const content = hasContent ? validateContent(input.content) : null;
    const pinned = hasPinned ? validatePinned(input.pinned) : null;
    const expectedVersion = hasOwn(input, 'version') && input.version !== null ? validateVersion(input.version) : null;
    const now = new Date();
    // Preserve the client timestamp when syncing an offline edit; otherwise use server time.
    const updatedAt = clampToNow(validTimestamp(input.updatedAt), now);

    const { rows } = await this.pool.query(
      `UPDATE notes
       SET title = COALESCE($2, title),
           content = COALESCE($3, content),
           pinned = COALESCE($7::boolean, pinned),
           version = version + 1,
           updated_at = $4
       WHERE user_id = $6 AND id = $1 AND deleted_at IS NULL AND ($5::integer IS NULL OR version = $5::integer)
       RETURNING ${FULL_COLUMNS}`,
      [id, title, content, updatedAt, expectedVersion, userId, pinned],
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
}

function toDocument(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
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
    title: hasOwn(input, 'title') ? validateTitle(input.title) : 'Untitled note',
    content: hasOwn(input, 'content') ? validateContent(input.content) : '',
    pinned: hasOwn(input, 'pinned') ? validatePinned(input.pinned) : false,
  };
}

function validateTitle(value) {
  if (typeof value !== 'string') {
    throw new StoreError('Title must be a string.', 400, 'INVALID_TITLE');
  }
  const title = value.trim() || 'Untitled note';
  if (title.length > MAX_TITLE_LENGTH) {
    throw new StoreError(`Title must be ${MAX_TITLE_LENGTH} characters or fewer.`, 400, 'TITLE_TOO_LONG');
  }
  return title;
}

function validateContent(value) {
  if (typeof value !== 'string') {
    throw new StoreError('Content must be a string.', 400, 'INVALID_CONTENT');
  }
  if (value.length > MAX_CONTENT_LENGTH) {
    throw new StoreError(`Content must be ${MAX_CONTENT_LENGTH} characters or fewer.`, 413, 'CONTENT_TOO_LARGE');
  }
  // Postgres text cannot hold NUL bytes.
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u0000/g, '');
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

module.exports = { DocumentStore, StoreError, MAX_TITLE_LENGTH, MAX_CONTENT_LENGTH };
