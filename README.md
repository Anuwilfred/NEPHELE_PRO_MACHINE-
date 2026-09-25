# Vessel dashboard — Phase 1: Corvina connection

This is the first phase of the build plan from the architecture doc: prove
the pipe works — Corvina Cloud → Ingestion Service → Postgres → Backend API
— before anything else (tag management UI, charts, drag-and-drop) gets built
on top of it.

## What's here

```
db/schema.sql          Postgres + TimescaleDB schema (devices, tags, latest
                        values, tag history)
ingestion-service/      Polls Corvina Cloud, writes into Postgres
backend-api/             Reads Postgres, serves it as JSON (/health,
                        /api/tags/latest)
docker-compose.yml      Runs all three together for local testing
```

## What YOU need to fill in before this goes live

This scaffold is wired and syntax-checked, but it can't talk to your real
Corvina account yet without three things from you:

1. **Your Corvina API base URL** and **credentials** — either a project API
   key, or a client ID/secret — go into `ingestion-service/.env` (copy
   `.env.example` to `.env` first).
2. **The three endpoint paths**, also in that `.env` file:
   `CORVINA_DEVICES_PATH`, `CORVINA_TAGS_PATH_TEMPLATE`,
   `CORVINA_LIVE_VALUES_PATH_TEMPLATE`. The defaults are a reasonable guess
   at REST conventions — they are **not** confirmed against Corvina's actual
   API. Open your project's Swagger/OpenAPI reference in the Corvina
   developer portal (or send me a screenshot of it, the way you described
   the device/tag/live-data screens earlier) and I'll set these exactly.
3. **The response shape** — once real data comes back from your account,
   the field-mapping in `ingestion-service/src/index.js` (where it reads
   `tag.id`, `tag.name`, `reading.tagId`, `reading.value`, etc.) may need a
   small adjustment to match your account's actual JSON field names.

Nothing else needs to change once those three are confirmed — the auth,
polling loop, and database writes are already built for both of Corvina's
auth modes (API key or OAuth2 client credentials).

## Running it locally

```bash
cp ingestion-service/.env.example ingestion-service/.env   # then edit it
cp backend-api/.env.example backend-api/.env
docker compose up --build
```

Then check:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/tags/latest
```

The second call should return one row per tag once the ingestion service
has completed its first poll — that's Phase 1 done.

## Where this runs for real, for free

Per the architecture doc: this whole `docker-compose.yml` maps directly
onto one Oracle Cloud "Always Free" VM (it never sleeps, unlike most free
hosting tiers, which matters because the ingestion service has to keep
polling whether or not anyone's looking at a dashboard). The code lives in
GitHub (free plan), which can deploy to that VM via GitHub Actions.

## Next phases (not built yet)

2. Tag management — a screen to rename/alias tags, set units and alarm
   thresholds (edits the `tags` table already in place).
3. Charts and widgets rendering against `/api/tags/latest` and history.
4. Drag-and-drop dashboard canvas.
5. Widget import/export as JSON templates.
6. Sharing — email invites, roles, per-dashboard permissions.
