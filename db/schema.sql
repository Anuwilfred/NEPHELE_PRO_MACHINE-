-- Vessel dashboard: core schema
-- One Postgres database, TimescaleDB extension enabled, matching the
-- architecture doc's "Databases" block (metadata + tag history together).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Devices as they exist in Corvina Cloud
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,        -- Corvina device id
  name          TEXT NOT NULL,
  online        BOOLEAN NOT NULL DEFAULT false,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tag catalog: one row per tag, with the friendly metadata a person edits
-- in the Tag Management screen (phase 2 of the build plan)
CREATE TABLE IF NOT EXISTS tags (
  id            TEXT PRIMARY KEY,        -- Corvina tag id
  device_id     TEXT NOT NULL REFERENCES devices(id),
  source_name   TEXT NOT NULL,           -- name as Corvina reports it
  display_name  TEXT,                    -- friendly alias, editable later
  unit          TEXT,
  data_type     TEXT,                    -- e.g. 'number', 'bool', 'string'
  min_value     DOUBLE PRECISION,
  max_value     DOUBLE PRECISION,
  alarm_low     DOUBLE PRECISION,
  alarm_high    DOUBLE PRECISION,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Live cache: the current value of every tag, overwritten on every poll.
-- This is what a freshly opened dashboard reads first.
CREATE TABLE IF NOT EXISTS latest_values (
  tag_id        TEXT PRIMARY KEY REFERENCES tags(id),
  value_numeric DOUBLE PRECISION,
  value_text    TEXT,
  value_bool    BOOLEAN,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Full history, as a TimescaleDB hypertable, for charts and trends.
CREATE TABLE IF NOT EXISTS tag_history (
  time          TIMESTAMPTZ NOT NULL,
  tag_id        TEXT NOT NULL REFERENCES tags(id),
  value_numeric DOUBLE PRECISION,
  value_text    TEXT,
  value_bool    BOOLEAN
);

SELECT create_hypertable('tag_history', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS idx_tag_history_tag_time ON tag_history (tag_id, time DESC);

-- Keep tag history from growing forever on a free-tier disk.
-- 90 days is a starting point -- widen it once real usage/storage is known.
SELECT add_retention_policy('tag_history', INTERVAL '90 days', if_not_exists => TRUE);
