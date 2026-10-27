const DEFAULT_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173';

function int(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

// Read lazily so tests and scripts can set the environment before calling.
function loadConfig() {
  const production = process.env.NODE_ENV === 'production';
  return {
    production,
    port: int('PORT', 4000),
    host: process.env.HOST || '0.0.0.0',
    logLevel: process.env.LOG_LEVEL || (production ? 'info' : 'debug'),
    allowedOrigins: (process.env.CLIENT_ORIGINS || DEFAULT_ORIGINS)
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Set when behind nginx or a load balancer so request IPs (rate limiting, logs) are real.
    trustProxy: bool('TRUST_PROXY', false),
    redisUrl: process.env.REDIS_URL || '',
    cookieSecure: bool('COOKIE_SECURE', production),
    allowRegistration: bool('ALLOW_REGISTRATION', true),
    sessionTtlMs: int('SESSION_TTL_DAYS', 30) * 24 * 60 * 60 * 1000,
    rateLimitMax: int('RATE_LIMIT_MAX', 1200),
    rateLimitWindow: int('RATE_LIMIT_WINDOW_SECONDS', 60) * 1000,
    authRateLimitMax: int('AUTH_RATE_LIMIT_MAX', 10),
    workers: int('WEB_CONCURRENCY', 0),
    metricsEnabled: bool('METRICS_ENABLED', true),
    // Optional bearer token for /metrics. nginx never proxies /metrics, so it stays internal either way.
    metricsToken: process.env.METRICS_TOKEN || '',
    sentryDsn: process.env.SENTRY_DSN || '',
    environment: process.env.APP_ENV || (production ? 'production' : 'development'),
  };
}

module.exports = { loadConfig };
