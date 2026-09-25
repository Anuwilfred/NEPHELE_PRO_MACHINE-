# Vessel Dashboard

A live dashboard for Corvina Cloud devices — device list, live map, per-device
tag editing, and admin-managed logins — running entirely on Supabase's free
tier (no server of your own has to stay switched on).

## What's here

```
index.html              The dashboard itself (devices, map, tags, users)
accept-invite.html      Where an invited person sets their own password
supabase/
  migrations/0001_init.sql   Database tables, security rules, and grants
  functions/                 Small server-side pieces that need a secret key:
    ingest/                    polls Corvina Cloud and writes into the database
    bootstrap-admin/           creates the very first admin account
    invite-user/                admin: invite someone by email
    remove-user/                admin: revoke someone's access
    list-users/                 admin: see who has access / who's still pending
  post-deploy.sql          One-time SQL to run after deploying (schedules
                           the poller and the daily cleanup job)
```

## One-time setup

1. Create a free Supabase project (supabase.com — no card needed).
2. Run the SQL in `supabase/migrations/0001_init.sql` (Dashboard → SQL Editor).
3. Set these secrets (`supabase secrets set ...` via the Supabase CLI, or the
   Dashboard → Edge Functions → Secrets):
   `CORVINA_API_BASE_URL`, `CORVINA_API_KEY`, `CORVINA_ORG_ID`,
   `CORVINA_ORG_RESOURCE_ID`, `PUBLIC_ACCEPT_INVITE_URL` (where
   `accept-invite.html` is hosted).
4. Deploy the five functions in `supabase/functions/` with the Supabase CLI.
5. Run `supabase/post-deploy.sql` once in the SQL Editor (fill in your
   project ref and service_role key first, as its comments explain).
6. In `index.html` and `accept-invite.html`, fill in `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` (Project Settings → API).
7. Open `index.html` in a browser — first visit shows a "create the admin
   account" screen. After that, the admin invites everyone else by email
   from inside the app.

## How it stays live

`supabase/functions/ingest` is called every 2 minutes by a scheduled job
(`post-deploy.sql` sets this up) and polls Corvina in a loop for about two
minutes each time, so data lands every 5-10 seconds — no computer of yours
needs to stay switched on for it to keep working.
