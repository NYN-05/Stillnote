const client = require('prom-client');

// Prometheus metrics for one API process. In Docker, run one process per container and
// let Prometheus scrape each; under `start:cluster` a scrape reaches a single worker.
function createMetrics({ pool }) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const duration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency by route template, method and status.',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  new client.Gauge({
    name: 'pg_pool_connections',
    help: 'PostgreSQL pool connections by state.',
    labelNames: ['state'],
    registers: [registry],
    collect() {
      this.set({ state: 'total' }, pool.totalCount);
      this.set({ state: 'idle' }, pool.idleCount);
      this.set({ state: 'waiting' }, pool.waitingCount);
    },
  });

  return { registry, duration };
}

module.exports = { createMetrics };
