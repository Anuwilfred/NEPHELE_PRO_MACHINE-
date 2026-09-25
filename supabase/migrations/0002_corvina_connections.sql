-- Lets an admin connect the dashboard to one or more Corvina Cloud
-- organizations directly from the app's Settings screen, instead of an
-- Edge Function secret only Claude/the developer could change. The
-- ingest function reads every row here (service_role, bypasses RLS) once
-- per poll cycle and pulls in that organization's devices and tags.
--
-- Device/tag ids get namespaced with the connection id (see ingest) so two
-- different organizations can never collide even if Corvina hands back the
-- same raw device id for both.

CREATE TABLE IF NOT EXISTS corvina_connections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  api_base_url     TEXT NOT NULL,
  api_key          TEXT NOT NULL,
  org_id           TEXT NOT NULL,
  org_resource_id  TEXT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  created_by       UUID REFERENCES auth.users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE corvina_connections ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON corvina_connections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON corvina_connections TO service_role;

-- Same admin-only pattern as tag editing: viewers never see or touch this
-- table (it holds each organization's Corvina API key), only admins do.
CREATE POLICY "only admins can manage corvina connections" ON corvina_connections
  FOR ALL TO authenticated
  USING (is_admin(auth.uid()))
  WITH CHECK (is_admin(auth.uid()));
