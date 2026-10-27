// Runs one API worker per CPU (or WEB_CONCURRENCY). Workers share the port and
// the same PostgreSQL database; Redis (REDIS_URL) keeps rate limits consistent between them.
const cluster = require('node:cluster');
const os = require('node:os');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

if (cluster.isPrimary) {
  const { loadConfig } = require('./src/config');
  const { createPool, migrate } = require('./src/db');

  (async () => {
    const pool = createPool({ max: 1 });
    const applied = await migrate(pool);
    await pool.end();
    if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

    const count = loadConfig().workers || os.availableParallelism();
    console.log(`Stillnote primary ${process.pid} starting ${count} worker(s)`);
    let stopping = false;
    const restarts = [];
    for (let index = 0; index < count; index += 1) cluster.fork();

    cluster.on('exit', (worker, code, signal) => {
      if (stopping) return;
      const now = Date.now();
      restarts.push(now);
      while (restarts.length && now - restarts[0] > 60_000) restarts.shift();
      if (restarts.length > count * 5) {
        console.error('Workers are crashing repeatedly; giving up.');
        process.exit(1);
      }
      console.error(`Worker ${worker.process.pid} exited (${signal || code}); restarting`);
      setTimeout(() => cluster.fork(), 500);
    });

    const stop = () => {
      stopping = true;
      for (const worker of Object.values(cluster.workers)) worker.process.kill('SIGTERM');
      setTimeout(() => process.exit(0), 12_000).unref();
      cluster.on('exit', () => {
        if (!Object.keys(cluster.workers).length) process.exit(0);
      });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  })().catch((error) => {
    console.error('Could not start Stillnote cluster:', error);
    process.exit(1);
  });
} else {
  require('./server')
    .start({ migrateOnStart: false })
    .catch((error) => {
      console.error('Worker failed to start:', error);
      process.exit(1);
    });
}
