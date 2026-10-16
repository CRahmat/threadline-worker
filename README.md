# Threadline Worker

Standalone HTTP worker for Threadline post publishing and background processing. The web application remains the owner of Prisma schema changes and database migrations.

## Local development

1. Copy `.env.example` to `.env` and set the worker secrets.
2. Run `npm install` and `npm run db:generate`.
3. Run `npm run dev`.
4. Check `GET /healthz`; invoke `GET /api/cron/post-worker` with `Authorization: Bearer <CRON_SECRET>`.

`POST /api/cron/post-worker` accepts `{}` for a batch or `{ "scheduleId": "..." }` for a single queued post.

## Deploy

Build and run the included Docker image on a container host, or use Node.js 20 with `npm ci && npm run db:generate && npm run build`, then `npm start`. Set `PORT`, `DATABASE_URL`, `CRON_SECRET`, `THREADS_TOKEN_ENCRYPTION_KEY`, `QSTASH_TOKEN`, and `WORKER_BASE_URL` in the host secret manager. Set `APP_INTERNAL_URL` to the web app origin reachable by this worker (the worker falls back to `PUBLIC_BASE_URL`) for the independent inbox sync scheduler. It polls `/api/cron/inbox-sync` every 60 seconds by default (`INBOX_SYNC_POLL_INTERVAL_MS` can be set from 30 seconds to 15 minutes); the app reads the actual sync interval from `inbox_sync_settings` (`id = global`, default 5 minutes), so polling does not force an early sync. Inbox sync no longer runs inside each post publishing request. Set the Threads app and image/storage values needed by the jobs in use. Do not run Prisma migrations from this repository.

On the web app, set `WORKER_BASE_URL` to this service's public HTTPS origin. QStash scheduler and job delivery will then target this worker.
