const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createPool, migrate } = require('../src/db');
const { DocumentStore } = require('../src/documentStore');
const { AuthService } = require('../src/auth');
const { buildApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createMetrics } = require('../src/metrics');

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
  return { store, pool, userId };
}

test('starts empty and creates documents with normalized titles and stable IDs', async (t) => {
  const { store, userId } = await makeEnv(t);
  assert.deepEqual((await store.list(userId)).documents, []);
  const document = await store.create(userId, { id: 'note-a', title: '  Project notes  ', content: 'first line\nsecond line' });
  assert.equal(document.id, 'note-a');
  assert.equal(document.title, 'Project notes');
  assert.equal(document.content, 'first line\nsecond line');
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
  assert.equal((await store.get(userId, 'big')).content.length, 5000);
});

test('updates partial fields, bumps the version, and keeps the client timestamp', async (t) => {
  const { store, userId } = await makeEnv(t);
  const created = await store.create(userId, { id: 'note-b', title: 'Draft', content: 'old content' });
  const updated = await store.update(userId, 'note-b', { content: 'new content', updatedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(updated.title, 'Draft');
  assert.equal(updated.content, 'new content');
  assert.equal(updated.version, 2);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, '2020-01-01T00:00:00.000Z');
  assert.equal((await store.get(userId, 'note-b')).content, 'new content');
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
  assert.equal((await store.get(userId, 'note-c')).content, 'safe');
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
      error.details.current.content === 'two' &&
      error.details.current.version === 2,
  );
  assert.equal((await store.get(userId, 'v')).content, 'two');
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
  assert.equal(pinned.content, 'body');
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
  assert.equal((await store.get(userId, 'shared-id')).content, 'private');
  assert.equal((await store.get(other, 'shared-id')).content, 'also private');
  await store.create(userId, { id: 'only-mine' });
  assert.equal(await store.get(other, 'only-mine'), null);
  await assert.rejects(store.update(other, 'only-mine', { content: 'hax' }), { statusCode: 404 });
  await assert.rejects(store.delete(other, 'only-mine'), { statusCode: 404 });
  assert.equal((await store.list(other)).documents.length, 1);
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
  assert.equal((await alice('/documents/h1')).body.document.content, 'hi');
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
  assert.equal(conflict.body.error.details.current.content, 'v2');

  assert.equal((await alice('/documents/h1', { method: 'PUT', body: '{bad' })).body.error.code, 'INVALID_JSON');
  assert.equal((await alice('/documents?cursor=zzz')).status, 400);
  assert.equal((await alice('/documents/h1', { method: 'DELETE' })).status, 204);
  const missing = await alice('/nothing');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'ROUTE_NOT_FOUND');
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
