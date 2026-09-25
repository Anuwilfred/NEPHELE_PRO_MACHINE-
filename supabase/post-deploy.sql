-- Run this ONCE in the Supabase Dashboard -> SQL Editor, AFTER the ingest
-- function has been deployed (supabase functions deploy ingest). It wires
-- up the two scheduled jobs: polling Corvina every 2 minutes, and trimming
-- old tag_history rows once a day.
--
-- Replace the two <PLACEHOLDER> values below before running:
--   <PROJECT_REF>          e.g. abcdefghijklmnop (from your project URL)
--   <SERVICE_ROLE_KEY>     Project Settings -> API -> service_role key
--
-- Storing the key in Vault (rather than typing it directly into the cron
-- job) means it's encrypted at rest and never shows up again in plain text
-- once this runs.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key');

select cron.schedule(
  'ingest-corvina',
  '*/2 * * * *',  -- every 2 minutes
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/ingest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

select cron.schedule(
  'trim-tag-history',
  '17 3 * * *',  -- once a day, an odd minute so it doesn't pile up with everyone else's midnight jobs
  $$ select trim_tag_history(); $$
);

-- To check it's actually running later:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
