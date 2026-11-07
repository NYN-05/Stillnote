const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { loadConfig } = require('./src/config');
const { createPool, migrate } = require('./src/db');
const { DocumentStore } = require('./src/documentStore');
const { AuthService } = require('./src/auth');
const { buildApp } = require('./src/app');
const { createMetrics } = require('./src/metrics');
const { CollaborationHub } = require('./src/collaboration');

function createRedis(url) {
  if (!url) return null;
  const Redis = require('ioredis');
  const client = new Redis(url, {
    maxRetriesPerRequest: 1, // fail fast; rate limiting fails open
    enableOfflineQueue: false,
    connectTimeout: 2000,
  });
  client.on('error', () => undefined); // surfaced through /api/health/ready instead
  return client;
}

// `migrateOnStart` is false for cluster workers, whose primary migrates once.
async function start({ migrateOnStart = true } = {}) {
  const config = loadConfig();
  const pool = createPool();
  if (migrateOnStart) {
    const applied = await migrate(pool);
    if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
  }
  const redis = createRedis(config.redisUrl);
  const auth = new AuthService(pool, config);

  // Error reporting is opt-in: nothing is loaded or sent without a DSN.
  let captureError = null;
  if (config.sentryDsn) {
    const Sentry = require('@sentry/node');
    Sentry.init({ dsn: config.sentryDsn, environment: config.environment, tracesSampleRate: 0 });
    captureError = (error, request) =>
      Sentry.captureException(error, { tags: { requestId: request.id, route: request.routeOptions?.url } });
  }

  const app = await buildApp({
    config,
    store: new DocumentStore(pool),
    auth,
    redis,
    metrics: config.metricsEnabled ? createMetrics({ pool }) : null,
    captureError,
  });
  const collaboration = new CollaborationHub({ store: new DocumentStore(pool), logger: app.log });
  const WebSocket = require('ws');
  const websocketServer = new WebSocket.Server({ noServer: true });
  app.server.on('upgrade', async (request, socket, head) => {
    const match = request.url?.match(/^\/ws\/documents\/([^/?]+)$/);
    if (!match) return;
    const token = (request.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('sid='))
      ?.slice(4);
    const user = token ? await auth.resolve(token).catch(() => null) : null;
    if (!user) return socket.destroy();
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      collaboration.open(user.id, decodeURIComponent(match[1]), client).catch(() => client.close());
    });
  });
  app.addHook('onClose', async () => {
    await collaboration.close();
    websocketServer.close();
    await pool.end().catch(() => undefined);
    redis?.disconnect();
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), 10_000).unref();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  return app;
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Could not start Stillnote API:', error);
    process.exit(1);
  });
}

module.exports = { start };
