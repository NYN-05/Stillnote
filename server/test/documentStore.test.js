const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPool, migrate } = require('../src/db');
const { DocumentStore } = require('../src/documentStore');
const { AuthService } = require('../src/auth');
const { buildApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createMetrics } = require('../src/metrics');
const { convertMarkdownNotes } = require('../src/contentMigration');

// Each test gets its own schema so it never touches real notes.
async function makeEnv(t) {
  const schema = `test_${randomUUID().replace(/-/g, '')}`;
  const admin = createPool({ max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = createPool({ max: 5, options: `-c search_path=${schema}` });
  await migrate(pool);
  t.after(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const store = new DocumentStore(pool);
  const userId = (await pool.query("INSERT INTO users (email, password_hash) VALUES ('owner@example.com', '!') RETURNING id")).rows[0].id;
  return { store, pool, schema, userId };
}

test('starts empty and creates documents with normalized titles and stable IDs', async (t) => {
  const { store, userId } = await makeEnv(t);
  assert.deepEqual((await store.list(userId)).documents, []);
  const document = await store.create(userId, { id: 'note-a', title: '  Project notes  ', content: 'first line\nsecond line' });
  assert.equal(document.id, 'note-a');
  assert.equal(document.title, 'Project notes');
  assert.equal(document.content, '<p>first line<br />\nsecond line</p>\n');
  assert.equal(document.contentFormat, 'html');
  assert.equal(document.contentSchemaVersion, 1);
  assert.equal(document.version, 1);
  assert.ok(Number.isFinite(Date.parse(document.createdAt)));
  assert.equal((await store.list(userId)).documents.length, 1);
});

test('list returns summaries without full content', async (t) => {
  const { store, userId } = await makeEnv(t);
  await store.create(userId, { id: 'big', title: 'Big', content: 'x'.repeat(5000) });
  const [summary] = (await store.list(userId)).documents;
  assert.equal(summary.content, undefined);
  assert.equal(summary.snippet.length, 200);
  assert.equal(summary.contentFormat, 'html');
  const full = await store.get(userId, 'big');
  assert.ok(full.content.startsWith('<p>'));
  assert.ok(full.content.includes('x'.repeat(5000)));
});

test('list snippets come from plain text, never HTML or Markdown syntax', async (t) => {
  const { store, userId } = await makeEnv(t);
  await store.create(userId, {
    id: 'rich',
    title: 'Rich',
    content: '<p>Hello <strong>world</strong> &amp; <a href="https://example.com">friends</a></p>',
    contentFormat: 'html',
  });
  const [summary] = (await store.list(userId)).documents;
  assert.equal(summary.snippet, 'Hello world & friends');
});

test('updates partial fields, bumps the version, and keeps the client timestamp', async (t) => {
  const { store, userId } = await makeEnv(t);
  const created = await store.create(userId, { id: 'note-b', title: 'Draft', content: 'old content' });
  const updated = await store.update(userId, 'note-b', { content: 'new content', updatedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(updated.title, 'Draft');
  assert.equal(updated.content, '<p>new content</p>\n');
  assert.equal(updated.version, 2);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, '2020-01-01T00:00:00.000Z');
  assert.equal((await store.get(userId, 'note-b')).content, '<p>new content</p>\n');
});

test('future client timestamps are clamped to server time', async (t) => {
  const { store, userId } = await makeEnv(t);
  await store.create(userId, { id: 'future', title: 'F' });
  const updated = await store.update(userId, 'future', { content: 'x', updatedAt: '2999-01-01T00:00:00.000Z' });
  assert.ok(Date.parse(updated.updatedAt) <= Date.now());
});

test('rejects invalid updates and duplicate IDs without changing stored data', async (t) => {
  const { store, userId } = await makeEnv(t);
  await store.create(userId, { id: 'note-c', title: 'Valid title', content: 'safe' });
  await assert.rejects(store.create(userId, { id: 'note-c', title: 'duplicate', content: '' }), { statusCode: 409 });
  await assert.rejects(store.update(userId, 'note-c', { title: 123 }), { statusCode: 400 });
  await assert.rejects(store.update(userId, 'note-c', {}), { statusCode: 400 });
  await assert.rejects(store.update(userId, 'note-c', { content: 'x', version: 0 }), { code: 'INVALID_VERSION' });
  await assert.rejects(store.update(userId, 'missing', { content: 'x' }), { statusCode: 404 });
  assert.equal((await store.get(userId, 'note-c')).content, '<p>safe</p>\n');
});

test('a stale version is rejected with the current document', async (t) => {
  const { store, userId } = await makeEnv(t);
  await store.create(userId, { id: 'v', title: 'V', content: 'one' });
  await store.update(userId, 'v', { content: 'two', version: 1 });
  await assert.rejects(
    store.update(userId, 'v', { content: 'stale', version: 1 }),
    (error) =>
      error.statusCode === 409 &&
      error.code === 'VERSION_CONFLICT' &&
      error.details.current.content === '<p>two</p>\n' &&
      error.details.current.version === 2,
  );
  assert.equal((await store.get(userId, 'v')).content, '<p>two</p>\n');
});

test('concurrent writers on the same version: exactly one wins', async (t) => {
  const { store, userId } = await makeEnv(t);
  await store.create(userId, { id: 'race', title: 'R', content: '0' });
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, index) => store.update(userId, 'race', { content: String(index), version: 1 })),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await store.get(userId, 'race')).version, 2);
});

test('delete is soft: hidden from reads, unknown or repeated deletes 404, ID cannot be reused', async (t) => {
  const { store, pool, userId } = await makeEnv(t);
  await store.create(userId, { id: 'note-d', title: 'Delete me', content: 'temporary' });
  await store.delete(userId, 'note-d');
  assert.equal(await store.get(userId, 'note-d'), null);
  assert.deepEqual((await store.list(userId)).documents, []);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM notes')).rows[0].n, 1);
  await assert.rejects(store.delete(userId, 'note-d'), { statusCode: 404 });
  await assert.rejects(store.update(userId, 'note-d', { content: 'zombie' }), { statusCode: 404 });
  await assert.rejects(store.create(userId, { id: 'note-d' }), { statusCode: 409 });
});

test('keyset pagination walks every document exactly once, newest first', async (t) => {
  const { store, userId } = await makeEnv(t);
  for (let index = 0; index < 25; index += 1) {
    // Several rows share a timestamp to exercise the id tie-breaker.
    await store.create(userId, {
      id: `n-${String(index).padStart(2, '0')}`,
      title: `T${index}`,
      updatedAt: `2024-01-01T00:00:${String(Math.floor(index / 3)).padStart(2, '0')}.000Z`,
    });
  }
  const seen = [];
  let cursor;
  let pages = 0;
  do {
    const page = await store.list(userId, { limit: 10, cursor });
    seen.push(...page.documents.map((document) => document.id));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, 25);
  const buckets = seen.map((id) => Math.floor(Number(id.slice(2)) / 3));
  assert.deepEqual(
    buckets,
    [...buckets].sort((a, b) => b - a),
  );
  await assert.rejects(store.list(userId, { cursor: 'not-a-cursor' }), { code: 'INVALID_CURSOR' });
});

test('pinning is stored, listed, and bumps the version without touching content', async (t) => {
  const { store, userId } = await makeEnv(t);
  const created = await store.create(userId, { id: 'p', title: 'P', content: 'body' });
  assert.equal(created.pinned, false);
  const pinned = await store.update(userId, 'p', { pinned: true });
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.content, '<p>body</p>\n');
  assert.equal(pinned.version, 2);
  assert.equal((await store.list(userId)).documents[0].pinned, true);
  await assert.rejects(store.update(userId, 'p', { pinned: 'yes' }), { code: 'INVALID_PINNED' });
  assert.equal((await store.create(userId, { id: 'q', pinned: true })).pinned, true);
});

test('users are isolated: same note ID, no cross-reads, writes, or deletes', async (t) => {
  const { store, pool, userId } = await makeEnv(t);
  const other = (await pool.query("INSERT INTO users (email, password_hash) VALUES ('other@example.com', '!') RETURNING id")).rows[0].id;
  await store.create(userId, { id: 'shared-id', title: 'Mine', content: 'private' });
  await store.create(other, { id: 'shared-id', title: 'Theirs', content: 'also private' });
  assert.equal((await store.get(userId, 'shared-id')).content, '<p>private</p>\n');
  assert.equal((await store.get(other, 'shared-id')).content, '<p>also private</p>\n');
  await store.create(userId, { id: 'only-mine' });
  assert.equal(await store.get(other, 'only-mine'), null);
  await assert.rejects(store.update(other, 'only-mine', { content: 'hax' }), { statusCode: 404 });
  await assert.rejects(store.delete(other, 'only-mine'), { statusCode: 404 });
  assert.equal((await store.list(other)).documents.length, 1);
});

// ---- content format / conversion ----------------------------------------

test('HTML writes are sanitized and carry explicit format metadata', async (t) => {
  const { store, pool, userId } = await makeEnv(t);
  const document = await store.create(userId, {
    id: 'rich',
    title: 'Rich',
    content: '<p onclick="steal()">Hello <strong>world</strong><script>alert(1)</script></p>',
    contentFormat: 'html',
    contentSchemaVersion: 1,
  });
  assert.equal(document.content, '<p>Hello <strong>world</strong></p>');
  assert.equal(document.contentFormat, 'html');
  assert.equal(document.contentSchemaVersion, 1);
  const stored = (await pool.query('SELECT content, content_format, plain_text FROM notes WHERE id = $1', ['rich'])).rows[0];
  assert.equal(stored.content_format, 'html');
  assert.equal(stored.plain_text, 'Hello world');
});

test('unsupported formats and schema versions are rejected without writing', async (t) => {
  const { store, userId } = await makeEnv(t);
  await assert.rejects(store.create(userId, { id: 'bad-format', content: 'x', contentFormat: 'text' }), {
    statusCode: 400,
    code: 'INVALID_CONTENT_FORMAT',
  });
  await assert.rejects(store.create(userId, { id: 'bad-schema', content: 'x', contentFormat: 'html', contentSchemaVersion: 99 }), {
    statusCode: 400,
    code: 'UNSUPPORTED_CONTENT_SCHEMA',
  });
  assert.equal(await store.get(userId, 'bad-format'), null);
  assert.equal(await store.get(userId, 'bad-schema'), null);
});

test('unconverted Markdown rows are served as HTML and persist when saved', async (t) => {
  const { store, pool, userId } = await makeEnv(t);
  await pool.query(
    `INSERT INTO notes (user_id, id, title, content, content_format, version, pinned, created_at, updated_at)
     VALUES ($1, 'legacy-live', 'Legacy', $2, 'markdown', 3, true, '2020-01-01T00:00:00Z', '2021-01-01T00:00:00Z')`,
    [userId, '# Old\n\nBody with **bold**'],
  );

  const read = await store.get(userId, 'legacy-live');
  assert.equal(read.contentFormat, 'html');
  assert.match(read.content, /<h1>Old<\/h1>/);
  assert.match(read.content, /<strong>bold<\/strong>/);
  assert.equal(read.version, 3);
  assert.equal(read.pinned, true);

  const saved = await store.update(userId, 'legacy-live', {
    content: read.content,
    contentFormat: 'html',
    contentSchemaVersion: 1,
    version: 3,
  });
  assert.equal(saved.version, 4);
  assert.equal(saved.contentFormat, 'html');
  const row = (await pool.query('SELECT content_format, plain_text FROM notes WHERE id = $1', ['legacy-live'])).rows[0];
  assert.equal(row.content_format, 'html');
  assert.equal(row.plain_text, 'Old Body with bold');
});

test('conversion preserves identity, ownership, timestamps and pin while bumping version once', async (t) => {
  const { pool, userId } = await makeEnv(t);
  await pool.query(
    `INSERT INTO notes (user_id, id, title, content, content_format, version, pinned, created_at, updated_at)
     VALUES ($1, 'convert-me', 'Keep title', $2, 'markdown', 7, true, '2020-01-01T00:00:00Z', '2021-02-03T04:05:06Z')`,
    [userId, '# Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |'],
  );

  const result = await convertMarkdownNotes(pool, { log: { log() {}, error() {}, warn() {} } });
  assert.deepEqual(
    { converted: result.converted, skipped: result.skipped, failed: result.failed },
    { converted: 1, skipped: 0, failed: 0 },
  );

  const row = (
    await pool.query(
      'SELECT id, user_id, title, content, content_format, content_schema_version, plain_text, version, pinned, created_at, updated_at FROM notes WHERE id = $1',
      ['convert-me'],
    )
  ).rows[0];
  assert.equal(row.user_id, userId);
  assert.equal(row.title, 'Keep title');
  assert.equal(row.content_format, 'html');
  assert.equal(row.content_schema_version, 1);
  assert.match(row.content, /<h1>Heading<\/h1>/);
  assert.match(row.content, /<table>/);
  assert.equal(row.plain_text, 'Heading a b 1 2');
  assert.equal(row.version, 8);
  assert.equal(row.pinned, true);
  assert.equal(row.created_at.toISOString(), '2020-01-01T00:00:00.000Z');
  assert.equal(row.updated_at.toISOString(), '2021-02-03T04:05:06.000Z');

  const again = await convertMarkdownNotes(pool, { log: { log() {}, error() {}, warn() {} } });
  assert.equal(again.converted, 0);
  assert.equal(again.examined, 0);
});

test('conversion dry-run reports rows without changing them', async (t) => {
  const { pool, userId } = await makeEnv(t);
  await pool.query(
    `INSERT INTO notes (user_id, id, title, content, content_format, version)
     VALUES ($1, 'dry', 'Dry', '# Still Markdown', 'markdown', 2)`,
    [userId],
  );
  const result = await convertMarkdownNotes(pool, {
    dryRun: true,
    log: { log() {}, error() {}, warn() {} },
  });
  assert.equal(result.converted, 1);
  const row = (await pool.query('SELECT content, content_format, version FROM notes WHERE id = $1', ['dry'])).rows[0];
  assert.equal(row.content, '# Still Markdown');
  assert.equal(row.content_format, 'markdown');
  assert.equal(row.version, 2);
});

test('a row whose conversion would exceed the limit stays Markdown and is reported', async (t) => {
  const { pool, userId } = await makeEnv(t);
  await pool.query(
    `INSERT INTO notes (user_id, id, title, content, content_format, version)
     VALUES ($1, 'too-big', 'Big', $2, 'markdown', 2)`,
    [userId, 'a'.repeat(499_999)],
  );
  const result = await convertMarkdownNotes(pool, { log: { log() {}, error() {}, warn() {} } });
  assert.equal(result.failed, 1);
  assert.equal(result.converted, 0);
  assert.equal(result.failures[0].id, 'too-big');
  const row = (await pool.query('SELECT content_format, version FROM notes WHERE id = $1', ['too-big'])).rows[0];
  assert.equal(row.content_format, 'markdown');
  assert.equal(row.version, 2);
});

test('a stale offline client cannot overwrite converted HTML', async (t) => {
  const { store, pool, userId } = await makeEnv(t);
  await pool.query(
    `INSERT INTO notes (user_id, id, title, content, content_format, version)
     VALUES ($1, 'race-convert', 'Race', '# New format', 'markdown', 4)`,
    [userId],
  );
  await convertMarkdownNotes(pool, { log: { log() {}, error() {}, warn() {} } });
  await assert.rejects(store.update(userId, 'race-convert', { content: 'stale markdown', contentFormat: 'markdown', version: 4 }), {
    statusCode: 409,
    code: 'VERSION_CONFLICT',
  });
  const row = (await pool.query('SELECT content, content_format, version FROM notes WHERE id = $1', ['race-convert'])).rows[0];
  assert.equal(row.content_format, 'html');
  assert.match(row.content, /<h1>New format<\/h1>/);
  assert.equal(row.version, 5);
});

// ---- HTTP + auth ----------------------------------------------------------

async function makeServer(t, overrides = {}, appOptions = {}) {
  const env = await makeEnv(t);
  const config = { ...loadConfig(), logLevel: 'silent', rateLimitMax: 1000, authRateLimitMax: 100, ...overrides };
  const auth = new AuthService(env.pool, { sessionTtlMs: config.sessionTtlMs, allowRegistration: config.allowRegistration, cacheTtlMs: 0 });
  const app = await buildApp({ config, store: env.store, auth, logger: false, ...appOptions });
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}/api`;

  // A tiny cookie-jar client: one per simulated browser.
  const client = () => {
    let cookie = '';
    const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.startsWith('sid=;') || /sid=;/.test(setCookie) ? '' : setCookie.split(';')[0];
      const text = await response.text();
      return { status: response.status, headers: response.headers, setCookie, body: text ? JSON.parse(text) : null };
    };
    return call;
  };
  return { ...env, client, base, app };
}

const PASSWORD = 'correct horse battery';

test('HTTP: register, sign in/out, cookie flags, and protected routes', async (t) => {
  const { client } = await makeServer(t);
  const anon = client();
  assert.equal((await anon('/documents')).status, 401);
  assert.equal((await anon('/auth/me')).status, 401);
  assert.equal((await anon('/health/live')).status, 200);

  const alice = client();
  assert.equal(
    (await alice('/auth/register', { method: 'POST', body: { email: 'bad', password: PASSWORD } })).body.error.code,
    'INVALID_EMAIL',
  );
  assert.equal(
    (await alice('/auth/register', { method: 'POST', body: { email: 'a@example.com', password: 'short' } })).body.error.code,
    'INVALID_PASSWORD',
  );
  const registered = await alice('/auth/register', { method: 'POST', body: { email: ' Alice@Example.com ', password: PASSWORD } });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.user.email, 'alice@example.com');
  assert.match(registered.setCookie, /HttpOnly/i);
  assert.match(registered.setCookie, /SameSite=Lax/i);
  assert.equal(JSON.stringify(registered.body).includes('password'), false);
  assert.equal((await alice('/auth/me')).body.user.email, 'alice@example.com');

  assert.equal(
    (await client()('/auth/register', { method: 'POST', body: { email: 'alice@example.com', password: PASSWORD } })).body.error.code,
    'EMAIL_TAKEN',
  );

  const second = client();
  assert.equal(
    (await second('/auth/login', { method: 'POST', body: { email: 'alice@example.com', password: 'wrong password!' } })).status,
    401,
  );
  assert.equal((await second('/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: PASSWORD } })).status, 401);
  assert.equal((await second('/auth/login', { method: 'POST', body: { email: 'ALICE@example.com', password: PASSWORD } })).status, 200);
  assert.equal((await second('/auth/me')).status, 200);

  // A JSON content type with an empty body (what many clients send for logout) is accepted.
  assert.equal((await second('/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status, 204);
  assert.equal((await second('/auth/me')).status, 401);
  assert.equal((await alice('/auth/me')).status, 200, 'logging out one session leaves others signed in');
});

test('HTTP: notes CRUD, conflict payload, isolation between accounts, error shapes', async (t) => {
  const { client } = await makeServer(t);
  const alice = client();
  const bob = client();
  await alice('/auth/register', { method: 'POST', body: { email: 'alice@example.com', password: PASSWORD } });
  await bob('/auth/register', { method: 'POST', body: { email: 'bob@example.com', password: PASSWORD } });

  const created = await alice('/documents', { method: 'POST', body: { id: 'h1', title: 'HTTP', content: 'hi' } });
  assert.equal(created.status, 201);
  assert.equal((await alice('/documents/h1')).body.document.content, '<p>hi</p>\n');
  assert.equal((await alice('/documents/h1')).body.document.contentFormat, 'html');
  assert.equal((await alice('/documents/h1')).body.document.contentSchemaVersion, 1);
  assert.equal((await alice('/documents/nope')).status, 404);
  assert.equal((await alice('/documents?limit=1')).body.nextCursor, null);

  // Bob cannot see, change, or delete Alice's note, and learns nothing about it.
  assert.equal((await bob('/documents/h1')).status, 404);
  assert.equal((await bob('/documents/h1', { method: 'PUT', body: { content: 'hax' } })).status, 404);
  assert.equal((await bob('/documents/h1', { method: 'DELETE' })).status, 404);
  assert.deepEqual((await bob('/documents')).body.documents, []);

  const ok = await alice('/documents/h1', { method: 'PUT', body: { content: 'v2', version: 1 } });
  assert.equal(ok.body.document.version, 2);
  const conflict = await alice('/documents/h1', { method: 'PUT', body: { content: 'stale', version: 1 } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');
  assert.equal(conflict.body.error.details.current.content, '<p>v2</p>\n');

  assert.equal((await alice('/documents/h1', { method: 'PUT', body: '{bad' })).body.error.code, 'INVALID_JSON');
  assert.equal((await alice('/documents?cursor=zzz')).status, 400);
  assert.equal((await alice('/documents/h1', { method: 'DELETE' })).status, 204);
  const missing = await alice('/nothing');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'ROUTE_NOT_FOUND');
});

test('HTTP: two API instances share one database and session store', async (t) => {
  const env = await makeEnv(t);
  const config = { ...loadConfig(), logLevel: 'silent', rateLimitMax: 1000, authRateLimitMax: 100 };
  const poolB = createPool({ max: 5, options: `-c search_path=${env.schema}` });
  const apps = [];
  const make = async (pool) => {
    const auth = new AuthService(pool, { sessionTtlMs: config.sessionTtlMs, allowRegistration: true, cacheTtlMs: 0 });
    const app = await buildApp({ config, store: new DocumentStore(pool), auth, logger: false });
    await app.listen({ port: 0, host: '127.0.0.1' });
    apps.push(app);
    return app;
  };
  t.after(async () => {
    await Promise.all(apps.map((app) => app.close()));
    await poolB.end();
  });
  const appA = await make(env.pool);
  const appB = await make(poolB);

  const registered = await appA.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'multi@example.com', password: PASSWORD },
  });
  assert.equal(registered.statusCode, 201);
  const cookie = registered.headers['set-cookie'].split(';')[0];

  const created = await appA.inject({
    method: 'POST',
    url: '/api/documents',
    headers: { cookie },
    payload: { id: 'shared', title: 'Across instances', content: '# First' },
  });
  assert.equal(created.statusCode, 201);

  // Instance B resolves the same session cookie and database row.
  const read = await appB.inject({ method: 'GET', url: '/api/documents/shared', headers: { cookie } });
  assert.equal(read.statusCode, 200);
  assert.match(read.json().document.content, /<h1>First<\/h1>/);
  assert.equal(read.json().document.version, 1);

  const updated = await appB.inject({
    method: 'PUT',
    url: '/api/documents/shared',
    headers: { cookie },
    payload: { content: '<p>Second</p>', contentFormat: 'html', contentSchemaVersion: 1, version: 1 },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().document.version, 2);

  // Instance A rejects the now-stale write and returns B's current document.
  const stale = await appA.inject({
    method: 'PUT',
    url: '/api/documents/shared',
    headers: { cookie },
    payload: { content: 'stale', version: 1 },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'VERSION_CONFLICT');
  assert.equal(stale.json().error.details.current.content, '<p>Second</p>');
});

test('HTTP: request IDs, health, origin guard, and oversized bodies', async (t) => {
  const { client, app } = await makeServer(t);
  const user = client();
  const health = await user('/health', { headers: { 'x-request-id': 'trace-me-123' } });
  assert.equal(health.status, 200);
  assert.equal(health.body.database, 'up');
  assert.equal(health.headers.get('x-request-id'), 'trace-me-123');
  assert.ok((await user('/health/ready')).headers.get('x-request-id'));

  await user('/auth/register', { method: 'POST', body: { email: 'c@example.com', password: PASSWORD } });
  const evil = await user('/documents', { method: 'POST', body: { id: 'x' }, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error.code, 'CORS_ORIGIN_DENIED');
  const allowed = await user('/documents', { method: 'POST', body: { id: 'y' }, headers: { origin: 'http://localhost:5173' } });
  assert.equal(allowed.status, 201);

  // The server may answer 413 or drop the connection before the upload finishes; either rejects it.
  const huge = await user('/documents', { method: 'POST', body: JSON.stringify({ id: 'z', content: 'a'.repeat(1_100_000) }) }).catch(
    () => ({ status: 'connection closed' }),
  );
  assert.ok(huge.status === 413 || huge.status === 'connection closed', `unexpected status ${huge.status}`);
  if (huge.status === 413) assert.equal(huge.body.error.code, 'REQUEST_TOO_LARGE');
  assert.ok(app);
});

test('HTTP: rate limits apply per account and slow down credential guessing per IP', async (t) => {
  const { client } = await makeServer(t, { rateLimitMax: 8, authRateLimitMax: 3 });
  const guesser = client();
  const statuses = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    statuses.push((await guesser('/auth/login', { method: 'POST', body: { email: 'x@example.com', password: 'wrong password!' } })).status);
  }
  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401]);
  assert.deepEqual(statuses.slice(3), [429, 429]);
});

test('HTTP: the general rate limit is per signed-in account, not shared', async (t) => {
  const { client } = await makeServer(t, { rateLimitMax: 6 });
  const alice = client();
  const bob = client();
  await alice('/auth/register', { method: 'POST', body: { email: 'alice@example.com', password: PASSWORD } });
  await bob('/auth/register', { method: 'POST', body: { email: 'bob@example.com', password: PASSWORD } });
  const aliceStatuses = [];
  for (let index = 0; index < 8; index += 1) aliceStatuses.push((await alice('/documents')).status);
  assert.ok(aliceStatuses.includes(429), 'alice is eventually limited');
  assert.equal((await bob('/documents')).status, 200, 'bob is unaffected by alice');
  const limited = await alice('/documents');
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
});

test('HTTP: closed registration', async (t) => {
  const { client } = await makeServer(t, { allowRegistration: false });
  const response = await client()('/auth/register', { method: 'POST', body: { email: 'z@example.com', password: PASSWORD } });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'REGISTRATION_CLOSED');
});

test('metrics: route-templated latency histogram, token guard, and error capture', async (t) => {
  const env = await makeEnv(t);
  const captured = [];
  const brokenStore = Object.assign(Object.create(env.store), {
    list: async () => {
      throw new Error('database exploded');
    },
  });
  const config = { ...loadConfig(), logLevel: 'silent', rateLimitMax: 1000, authRateLimitMax: 100, metricsToken: 'secret-token' };
  const auth = new AuthService(env.pool, { sessionTtlMs: config.sessionTtlMs });
  const app = await buildApp({
    config,
    store: brokenStore,
    auth,
    logger: false,
    metrics: createMetrics({ pool: env.pool }),
    captureError: (error, request) => captured.push([error.message, request.id]),
  });
  t.after(() => app.close());

  await app.inject({ method: 'GET', url: '/api/health/live' });
  const register = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'm@example.com', password: PASSWORD } });
  const cookie = register.headers['set-cookie'].split(';')[0];
  const failing = await app.inject({ method: 'GET', url: '/api/documents', headers: { cookie } });
  assert.equal(failing.statusCode, 500);
  assert.equal(failing.json().error.code, 'INTERNAL_SERVER_ERROR');
  assert.equal(failing.body.includes('exploded'), false, 'internals are not leaked to the client');
  assert.equal(captured.length, 1);
  assert.equal(captured[0][0], 'database exploded');

  assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 401);
  const scrape = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer secret-token' } });
  assert.equal(scrape.statusCode, 200);
  assert.match(scrape.body, /http_request_duration_seconds_count\{method="POST",route="\/api\/auth\/register",status="201"\} 1/);
  assert.match(scrape.body, /route="\/api\/documents",status="500"/);
  assert.match(scrape.body, /pg_pool_connections\{state="total"\}/);
  assert.match(scrape.body, /process_cpu_user_seconds_total/);
});
