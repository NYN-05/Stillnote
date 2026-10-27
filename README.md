# Stillnote

A quiet, Markdown-first note-taking app. Notes are saved on your device instantly, synced to a server in the background, and stay usable offline.

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS 4, Radix UI primitives, CodeMirror 6, TanStack Query, Zustand, React Router, installable as a PWA.
- **Backend:** Node 22, Fastify 5, PostgreSQL 16, Redis 7 (optional, for shared rate limits), argon2 password hashing.
- **Ops:** Docker images, nginx, Prometheus metrics, JSON logs, optional Sentry, backup/restore scripts, GitHub Actions CI.

## Contents

[Quick start](#quick-start) · [Architecture](#architecture) · [Scripts](#scripts) · [Configuration](#configuration) · [Deploying](#deploying-with-docker) · [Operations](#operations) · [Testing and CI](#testing-and-ci) · [API](#api) · [Security](#security-notes) · [Limits](#known-limits)

## Quick start

Requires Node.js 20 or later (22 recommended) and Docker.

```bash
npm install
npm run db:up        # PostgreSQL on :5432 and Redis on :6379 (docker compose)
npm run dev          # API on :4000, web on :5173 (Vite proxies /api)
```

Open <http://localhost:5173> and create an account. Migrations run automatically when the API starts.

## Architecture

```text
Browser ──► nginx ──► api (Fastify) ×N ──► PostgreSQL   notes, users, sessions
  │  static files   │  /api/*               Redis       rate-limit counters (optional)
  │                 └──► /metrics (internal only)
  └─ IndexedDB: full offline copy per account, sync engine
```

**Offline-first sync.** Every edit is applied and stored in the browser's IndexedDB immediately, then uploaded after a short pause. `client/src/lib/engine.ts` is a plain, tested class that owns this: ordered uploads per note, a version number on every write so a stale write gets a `409` instead of silently overwriting, deletes remembered until the server confirms them, and a merge on start, on reconnect and every 20 seconds while offline. The note list loads without note text and each note's text is fetched when opened, so opening the app costs the same with ten notes or ten thousand.

**Accounts.** Email and password; sessions are random tokens in an `HttpOnly`, `SameSite=Lax` cookie, stored hashed. Every query is scoped to the signed-in user.

**Client structure.** The URL decides which note is open (`/notes/:id`). TanStack Query handles the session; the sync engine handles notes (a local-first store does not fit a request-cache model, so it is deliberately separate); Zustand holds UI preferences; CodeMirror and the Markdown renderer load only when a note is opened.

## Scripts

| Command                                          | What it does                                           |
| ------------------------------------------------ | ------------------------------------------------------ |
| `npm run dev`                                    | API and web with live reload                           |
| `npm run db:up` / `db:down`                      | Start / stop local PostgreSQL and Redis                |
| `npm run db:migrate`                             | Apply pending migrations by hand                       |
| `npm run db:claim -- you@example.com`            | Give notes that predate accounts to an account         |
| `npm run db:import -- you@example.com file.json` | Import the old JSON store into an account              |
| `npm run lint` / `format` / `typecheck`          | ESLint, Prettier, TypeScript                           |
| `npm test` / `npm run test:client`               | API tests (real PostgreSQL) / sync-engine tests        |
| `npm run e2e`                                    | Browser tests against a running stack (`E2E_BASE_URL`) |
| `npm run verify`                                 | Everything CI runs, in order                           |
| `npm run build`                                  | Production client build                                |
| `npm start` / `npm run start:cluster`            | One API process / one per CPU                          |

A Husky pre-commit hook runs ESLint and Prettier on staged files.

## Configuration

Copy `.env.example` to `.env` for local runs. Defaults suit development.

| Variable                                       | Default                      | Purpose                                                            |
| ---------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`                                 | local compose database       | PostgreSQL connection                                              |
| `PG_POOL_MAX`                                  | `20`                         | Connections per API process                                        |
| `REDIS_URL`                                    | empty                        | Share rate limits across processes; empty keeps counters in memory |
| `CLIENT_ORIGINS`                               | `localhost:5173` and `:4173` | Origins allowed to call the API                                    |
| `TRUST_PROXY`                                  | `false`                      | Set `true` behind nginx or a load balancer so IPs are real         |
| `COOKIE_SECURE`                                | `true` in production         | Send the session cookie only over HTTPS                            |
| `ALLOW_REGISTRATION`                           | `true`                       | Set `false` once your accounts exist                               |
| `SESSION_TTL_DAYS`                             | `30`                         | Session lifetime                                                   |
| `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_SECONDS`  | `1200`, `60`                 | Requests per window per user (per IP when signed out)              |
| `AUTH_RATE_LIMIT_MAX`                          | `10`                         | Sign-in / register attempts per minute per IP                      |
| `METRICS_ENABLED`, `METRICS_TOKEN`             | `true`, empty                | `GET /metrics`; optional bearer token                              |
| `SENTRY_DSN`                                   | empty                        | Enables error reporting when set                                   |
| `LOG_LEVEL`, `WEB_CONCURRENCY`, `PORT`, `HOST` | `info`, CPU count, `4000`    | Logging, cluster size, listen address                              |

## Deploying with Docker

`docker-compose.prod.yml` runs nginx (static client and `/api` proxy), the API, PostgreSQL and Redis. Only the web port is published.

```bash
cp .env.production.example .env.production      # set POSTGRES_PASSWORD and PUBLIC_ORIGIN
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --scale api=3   # more API replicas
```

- Put a TLS-terminating proxy or load balancer in front of the web port. The app must be served from one origin (nginx serves the files and proxies `/api`), because the session cookie is same-site.
- API replicas can start together: the migration runner takes a database lock. nginx re-resolves `api` every 10 seconds, so scaling needs no restart.
- To use prebuilt images, set `STILLNOTE_API_IMAGE` and `STILLNOTE_WEB_IMAGE`. CI publishes both to GitHub Container Registry on pushes to `main` and on `v*` tags.
- nginx sends a strict Content-Security-Policy (`script-src 'self'`), caches hashed assets for a year, and always revalidates `index.html` and the service worker. `/metrics` is never exposed through it.

## Operations

**Backups.** `ops/backup.sh [dir]` writes a verified, compressed dump and keeps the newest 14 (`KEEP` to change). `ops/restore.sh file.dump` replaces the database from a dump, stopping the API during the restore. Both take `COMPOSE_FILE` and `ENV_FILE`. Schedule the backup (cron) and copy dumps off the host. A restore was tested end to end: data deleted, restored from a dump, and the account and note came back intact.

```bash
ENV_FILE=.env.production ops/backup.sh /var/backups/stillnote
ENV_FILE=.env.production ops/restore.sh /var/backups/stillnote/stillnote-20260101T000000Z.dump
```

**Metrics.** `GET /metrics` on each API container (internal network): request latency histograms by method, route template and status, PostgreSQL pool gauges, and Node process metrics. Run one process per container and scrape each; under `start:cluster` a scrape reaches one worker only.

**Logs and health.** JSON logs (pino) with an `x-request-id` on every response, cookies redacted. `/api/health/live` is process liveness; `/api/health/ready` checks the database (`503` if down) and reports Redis, which does not fail readiness because rate limiting fails open.

**Errors.** With `SENTRY_DSN` set, unexpected (5xx) errors are reported with the request id and route.

**Accounts.** Existing notes from before accounts live under a placeholder user until `npm run db:claim`. Soft-deleted notes stay in the table.

## Testing and CI

| Layer               | Tool          | What is covered                                                                                                                                                                           |
| ------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API and data        | `node --test` | Per-user isolation, versions and conflicts, pagination, sessions, rate limits, origin guard, metrics, error capture, against real PostgreSQL in a throwaway schema                        |
| Sync engine         | Vitest        | Offline start, ordered saves, conflicts both ways, tombstones, 404 and 409 recovery, merge rules                                                                                          |
| Browser, full stack | Playwright    | Sign-up and sign-in, formatting, split preview, reload persistence, offline edits syncing back, account isolation, script injection, CSP violations, accessibility (axe, light and dark) |

`.github/workflows/ci.yml` runs lint, formatting, types, API and client tests and the build; then starts the production compose stack (nginx, two API replicas, PostgreSQL, Redis) and runs the browser suite against it; then, on `main` and tags, publishes the images. Testing the nginx stack rather than the dev server is deliberate: it caught a CSP-blocked inline script and font that dev mode hides.

## Load testing

`loadtest/` holds a [k6](https://k6.io) kit (`winget install k6`, or see k6.io). It seeds 500 accounts and 10,000 notes (about 3 KB each) directly in SQL, so the test needs no sign-in, then drives a realistic mix at a fixed request rate: 70% saves, 20% opening a note, 10% loading the list.

```bash
export COMPOSE_FILE=docker-compose.prod.yml ENV_FILE=.env.production
npm run loadtest:seed                       # or: npm run loadtest:seed -- 1000 20; add -- --cleanup to remove it
npm run loadtest -- --rates 100,300,600,1000 --duration 60s --base-url http://localhost:8080
```

Pass criteria per step: p95 under 150 ms, p99 under 400 ms, error rate under 0.1%, no dropped iterations. Failures are broken down by HTTP status. The runner writes raw summaries to `loadtest/results/`.

**Measured** on one Windows 11 machine (16 threads) where the load generator, Docker Desktop, nginx, the API and PostgreSQL all share the same CPUs, so treat these as a floor:

| Setup                  | Request rate | p50     | p95        | p99        | Errors             |
| ---------------------- | ------------ | ------- | ---------- | ---------- | ------------------ |
| 1 API replica          | 100 / s      | 5 ms    | 8 ms       | 11 ms      | 0%                 |
| 1 API replica          | 1,000 / s    | 3 ms    | 9 ms       | 18 ms      | 0%                 |
| 1 API replica          | 1,600 / s    | 6 ms    | 25 ms      | 60 ms      | 0%                 |
| 1 API replica          | 2,000 / s    | 879 ms  | 1,448 ms   | 2,824 ms   | queueing (1,764/s) |
| 2 replicas, 3 minutes  | 300 / s      | 4 ms    | 11 ms      | 14 ms      | 0%, memory flat    |
| 3 replicas             | 2,500 / s    | 12 ms   | 360 ms     | 641 ms     | 0%, near ceiling   |

So the target of 100 requests per second has roughly 16 times headroom on a single API process within the latency goals. One Node process uses about one core (about 97% CPU at saturation), PostgreSQL reaches about 180% CPU on this write-heavy mix, and the practical limit on this machine is about 1,700 req/s for one replica and about 2,500 req/s for three.

Two real problems showed up and are fixed: nginx originally opened a new connection to the API per request and ran out of ports at about 1,000 req/s (`Address not available`, answered as 502); it now keeps a pool of connections open. Node's keep-alive timeout is set above nginx's so idle connections are not closed under it. Re-run the sweep after any change to the proxy, database or API.

## API

Auth endpoints set or clear the `sid` cookie. All `/api/documents` endpoints require a session and only see the signed-in user's notes (`401` otherwise; another user's note is a `404`). Errors are `{ "error": { "code", "message", "details"? } }`.

| Method   | Endpoint                        | Purpose                                                                                                                  |
| -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST`   | `/api/auth/register`            | Create an account (`email`, `password` of 10 to 128 characters) and sign in                                              |
| `POST`   | `/api/auth/login`               | Sign in                                                                                                                  |
| `POST`   | `/api/auth/logout`              | End the session                                                                                                          |
| `GET`    | `/api/auth/me`                  | The signed-in user, or `401`                                                                                             |
| `GET`    | `/api/documents?limit=&cursor=` | Summaries without text (`id`, `title`, `snippet`, `pinned`, `version`, timestamps), newest first                         |
| `GET`    | `/api/documents/:id`            | One note with its text                                                                                                   |
| `POST`   | `/api/documents`                | Create (optional `id`, `title`, `content`, `pinned`)                                                                     |
| `PUT`    | `/api/documents/:id`            | Update `title`, `content` and/or `pinned`; `version` makes it conditional (`409 VERSION_CONFLICT` with the current note) |
| `DELETE` | `/api/documents/:id`            | Delete (soft)                                                                                                            |
| `GET`    | `/api/health/live`, `/ready`    | Liveness, readiness                                                                                                      |
| `GET`    | `/metrics`                      | Prometheus metrics (internal; optional bearer token)                                                                     |

Titles are limited to 120 characters and note text to 500,000.

## Security notes

- Passwords: argon2id. Sessions: random 256-bit tokens, only their SHA-256 stored, revocable on logout. Unknown emails cost the same time as wrong passwords.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production. Unsafe requests from origins outside `CLIENT_ORIGINS` are rejected.
- Markdown preview never renders raw HTML and strips unsafe URL schemes (tested). Links open in a new tab with `noopener`.
- Rate limits protect sign-in per IP and everything else per account.
- Run the stack behind HTTPS. Sign-up is open by default, and an "email already exists" answer reveals registered emails; set `ALLOW_REGISTRATION=false` once you have your accounts.

## Known limits

- Conflict handling is "newer edit wins", decided with the editing device's clock, and you are told when the server's version replaces yours. It is not a merge: simultaneous edits to one note from two devices keep one version.
- Notes you have never opened on this device cannot be read offline, and search inside them covers only the first 200 characters until they are opened.
- No password reset, email verification, folders or tags yet.
- Signing out keeps this device's offline copy; clear the site's data on a shared computer.

## Project structure

```text
stillnote/
├── client/                 React app (Vite, TypeScript)
│   ├── src/lib/            engine.ts (sync), db.ts (IndexedDB), api.ts, merge.ts, format.ts
│   ├── src/components/     editor, sidebar, command palette, ui/ primitives
│   ├── src/routes/         auth, notes, settings
│   ├── nginx/              production web server config
│   └── Dockerfile
├── server/                 Fastify API
│   ├── src/                app.js, auth.js, documentStore.js, db.js, metrics.js, config.js
│   ├── migrations/         numbered SQL files, applied at startup
│   ├── scripts/            import and claim tools
│   ├── test/
│   └── Dockerfile
├── e2e/                    Playwright suite
├── loadtest/               k6 script, SQL seed data, rate-sweep runner
├── ops/                    backup.sh, restore.sh
├── scripts/verify.mjs      local CI
├── docker-compose.yml      dev PostgreSQL and Redis
├── docker-compose.prod.yml full stack
└── .github/                CI and Dependabot
```
