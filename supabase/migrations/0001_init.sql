-- Vessel dashboard: Supabase schema.
--
-- Replaces the old self-hosted Postgres + TimescaleDB schema (db/schema.sql).
-- Two changes from that version, both forced by moving to Supabase:
--
-- 1. TimescaleDB is deprecated on new Supabase projects (and its retention-
--    policy feature is Community-Edition-only, which Supabase doesn't ship)
--    -- so tag_history is a plain indexed table, with a pg_cron job doing
--    the same "drop anything older than 90 days" job a Timescale retention
--    policy used to do.
-- 2. Supabase now requires (since its Oct 2026 security default) that every
--    table get an EXPLICIT grant before it's reachable through the API --
--    on top of enabling Row Level Security and writing a policy. All three
--    are done together below for every table. This is a good thing: it's
--    what gives us "viewers can read, only admins can edit" for free.

-- ---------------------------------------------------------------------------
-- Tables (same shape as before)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  online        BOOLEAN NOT NULL DEFAULT false,
  last_seen_at  TIMESTAMPTZ,
  geo_lat       DOUBLE PRECISION,
  geo_lng       DOUBLE PRECISION,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tags (
  id            TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL REFERENCES devices(id),
  source_name   TEXT NOT NULL,
  display_name  TEXT,
  unit          TEXT,
  data_type     TEXT,
  min_value     DOUBLE PRECISION,
  max_value     DOUBLE PRECISION,
  alarm_low     DOUBLE PRECISION,
  alarm_high    DOUBLE PRECISION,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS latest_values (
  tag_id        TEXT PRIMARY KEY REFERENCES tags(id),
  value_numeric DOUBLE PRECISION,
  value_text    TEXT,
  value_bool    BOOLEAN,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tag_history (
  time          TIMESTAMPTZ NOT NULL,
  tag_id        TEXT NOT NULL REFERENCES tags(id),
  value_numeric DOUBLE PRECISION,
  value_text    TEXT,
  value_bool    BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_tag_history_tag_time ON tag_history (tag_id, time DESC);

-- Who's allowed in, and what they can do. Passwords/sessions themselves are
-- handled by Supabase Auth (auth.users) -- this table just adds the one
-- thing Supabase Auth doesn't have built in: a role per person.
CREATE TABLE IF NOT EXISTS user_roles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  invited_by  UUID REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily cleanup instead of a Timescale retention policy (see header note).
-- pg_cron + this DELETE together are the free-tier equivalent.
CREATE OR REPLACE FUNCTION trim_tag_history() RETURNS void AS $$
  DELETE FROM tag_history WHERE time < now() - INTERVAL '90 days';
$$ LANGUAGE sql;

-- ---------------------------------------------------------------------------
-- Helper: is this user an admin? (used by policies below)
-- SECURITY DEFINER so a regular user's RLS restrictions on user_roles don't
-- block the policy check itself from reading it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_admin(uid UUID) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles WHERE id = uid AND role = 'admin'
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Is this user still an active member at all (any role)? Removing someone's
-- user_roles row (see the invite-user/remove-user functions) is what
-- revokes access -- but being logged in (authenticated) alone is NOT
-- enough to read data below; they must also still have a role row.
CREATE OR REPLACE FUNCTION has_role(uid UUID) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM user_roles WHERE id = uid);
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ---------------------------------------------------------------------------
-- Grants + RLS + policies -- every table gets all three together.
-- ---------------------------------------------------------------------------

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON devices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON devices TO service_role;
CREATE POLICY "any signed-in person can read devices" ON devices
  FOR SELECT TO authenticated USING (has_role(auth.uid()));

ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
GRANT SELECT, UPDATE ON tags TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tags TO service_role;
CREATE POLICY "any signed-in person can read tags" ON tags
  FOR SELECT TO authenticated USING (has_role(auth.uid()));
CREATE POLICY "only admins can edit tags" ON tags
  FOR UPDATE TO authenticated
  USING (is_admin(auth.uid())) WITH CHECK (is_admin(auth.uid()));

ALTER TABLE latest_values ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON latest_values TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON latest_values TO service_role;
CREATE POLICY "any signed-in person can read latest values" ON latest_values
  FOR SELECT TO authenticated USING (has_role(auth.uid()));

ALTER TABLE tag_history ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON tag_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON tag_history TO service_role;
CREATE POLICY "any signed-in person can read tag history" ON tag_history
  FOR SELECT TO authenticated USING (has_role(auth.uid()));

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON user_roles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_roles TO service_role;
CREATE POLICY "read your own row, or every row if you're an admin" ON user_roles
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR is_admin(auth.uid()));

-- Realtime: lets the dashboard get pushed updates the instant ingestion
-- writes a row, instead of polling every few seconds.
ALTER PUBLICATION supabase_realtime ADD TABLE devices;
ALTER PUBLICATION supabase_realtime ADD TABLE latest_values;
