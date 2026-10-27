const { randomUUID } = require('node:crypto');
const Fastify = require('fastify');
const { StoreError } = require('./documentStore');

const SESSION_COOKIE = 'sid';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// `redis` is optional; without it, rate-limit counters live in this process only.
// `metrics` ({ registry, duration }) enables /metrics; `captureError` receives unexpected (5xx) errors.
async function buildApp({ config, store, auth, redis = null, logger, metrics = null, captureError = null }) {
  const app = Fastify({
    logger: logger ?? {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
    },
    bodyLimit: 1024 * 1024,
    // Must exceed nginx's upstream keepalive_timeout (60s), or Node closes idle connections that
    // nginx is about to reuse and the client sees an occasional 502.
    keepAliveTimeout: 65_000,
    trustProxy: config.trustProxy,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  // Fastify rejects an empty body that carries a JSON content type. Some clients send that
  // for logout or DELETE, so treat it as "no body"; malformed JSON still fails the same way.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (!body) return done(null, undefined);
    return parseJson(request, body, done);
  });

  // Registered first so every plugin and route context inherits these handlers.
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send({ error: { code: 'ROUTE_NOT_FOUND', message: 'API endpoint not found.' } });
  });

  app.setErrorHandler((error, request, reply) => {
    const known = {
      FST_ERR_CTP_INVALID_JSON_BODY: [400, 'INVALID_JSON', 'Request body contains malformed JSON.'],
      FST_ERR_CTP_EMPTY_JSON_BODY: [400, 'INVALID_JSON', 'Request body is empty.'],
      FST_ERR_CTP_BODY_TOO_LARGE: [413, 'REQUEST_TOO_LARGE', 'Request body exceeds the 1 MB limit.'],
      FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.'],
    }[error.code];
    if (known) return reply.code(known[0]).send({ error: { code: known[1], message: known[2] } });

    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      captureError?.(error, request);
      return reply.code(500).send({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected server error occurred.' } });
    }
    return reply.code(status).send({
      error: {
        code: typeof error.code === 'string' && !error.code.startsWith('FST_') ? error.code : 'BAD_REQUEST',
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  });

  await app.register(require('@fastify/helmet'), { crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(require('@fastify/cors'), {
    origin(origin, callback) {
      // Requests from CLI tools and same-origin server calls have no Origin header.
      if (!origin || config.allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new StoreError('This origin is not allowed by CORS.', 403, 'CORS_ORIGIN_DENIED'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'X-Request-Id'],
    maxAge: 600,
  });
  await app.register(require('@fastify/cookie'));
  await app.register(require('@fastify/compress'), { global: true, threshold: 1024 });
  await app.register(require('@fastify/rate-limit'), {
    global: true,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
    hook: 'preHandler', // runs after the session is resolved, so signed-in users are limited per account
    keyGenerator: (request) => request.user?.id ?? request.ip,
    allowList: (request) => request.url.startsWith('/api/health') || request.url === '/metrics',
    nameSpace: 'stillnote-rl:',
    skipOnError: true, // a Redis outage must not take the API down
    ...(redis ? { redis } : {}),
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(`Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`), {
        statusCode: 429,
        code: 'RATE_LIMITED',
      }),
  });

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    // Cookie auth must not be usable by a form or script on another site.
    const origin = request.headers.origin;
    if (!SAFE_METHODS.has(request.method) && origin && !config.allowedOrigins.includes(origin)) {
      throw new StoreError('This origin is not allowed.', 403, 'CORS_ORIGIN_DENIED');
    }
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) request.user = await auth.resolve(token);
  });

  const requireAuth = async (request) => {
    if (!request.user) throw new StoreError('Sign in to continue.', 401, 'UNAUTHENTICATED');
  };

  const setSessionCookie = (reply, token) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: Math.floor(config.sessionTtlMs / 1000),
    });

  // ---- metrics ------------------------------------------------------------
  if (metrics) {
    app.addHook('onResponse', async (request, reply) => {
      // Label by route template (/api/documents/:id), never by raw URL, to keep cardinality bounded.
      const route = request.routeOptions?.url ?? 'unmatched';
      if (route === '/metrics') return;
      metrics.duration.observe({ method: request.method, route, status: reply.statusCode }, reply.elapsedTime / 1000);
    });
    app.get('/metrics', { logLevel: 'warn' }, async (request, reply) => {
      if (config.metricsToken && request.headers.authorization !== `Bearer ${config.metricsToken}`) {
        return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Metrics token required.' } });
      }
      return reply.type(metrics.registry.contentType).send(await metrics.registry.metrics());
    });
  }

  // ---- health -------------------------------------------------------------
  const quiet = { logLevel: 'warn' };
  app.get('/api/health/live', quiet, async () => ({ status: 'ok' }));
  const ready = async (_request, reply) => {
    const checks = { database: 'up', redis: redis ? 'up' : 'disabled' };
    try {
      await store.ping();
    } catch {
      checks.database = 'down';
    }
    if (redis) {
      try {
        await redis.ping();
      } catch {
        checks.redis = 'down';
      }
    }
    // Redis only backs rate limiting, which fails open, so it does not fail readiness.
    const healthy = checks.database === 'up';
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'unavailable', ...checks, timestamp: new Date().toISOString() });
  };
  app.get('/api/health/ready', quiet, ready);
  app.get('/api/health', quiet, ready);

  // ---- auth ---------------------------------------------------------------
  const authLimit = { rateLimit: { max: config.authRateLimitMax, timeWindow: 60_000, keyGenerator: (request) => request.ip } };
  const credentials = (request) => (isObject(request.body) ? request.body : {});

  app.post('/api/auth/register', { config: authLimit }, async (request, reply) => {
    const { email, password } = credentials(request);
    const { user, token } = await auth.register(email, password);
    setSessionCookie(reply, token);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', { config: authLimit }, async (request, reply) => {
    const { email, password } = credentials(request);
    const { user, token } = await auth.login(email, password);
    setSessionCookie(reply, token);
    return { user };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await auth.logout(request.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request) => ({ user: request.user }));

  // ---- notes (every query is scoped to the signed-in user) ----------------
  await app.register(async (notes) => {
    notes.addHook('preHandler', requireAuth);

    notes.get('/api/documents', async (request) => {
      const { documents, nextCursor } = await store.list(request.user.id, {
        limit: request.query.limit,
        cursor: request.query.cursor,
      });
      return { documents, nextCursor };
    });

    notes.get('/api/documents/:id', async (request) => {
      const document = await store.get(request.user.id, request.params.id);
      if (!document) throw new StoreError('Document not found.', 404, 'DOCUMENT_NOT_FOUND');
      return { document };
    });

    notes.post('/api/documents', async (request, reply) => {
      const document = await store.create(request.user.id, request.body);
      return reply.code(201).send({ document });
    });

    notes.put('/api/documents/:id', async (request) => {
      const document = await store.update(request.user.id, request.params.id, request.body);
      return { document };
    });

    notes.delete('/api/documents/:id', async (request, reply) => {
      await store.delete(request.user.id, request.params.id);
      return reply.code(204).send();
    });
  });

  return app;
}

module.exports = { buildApp, SESSION_COOKIE };
