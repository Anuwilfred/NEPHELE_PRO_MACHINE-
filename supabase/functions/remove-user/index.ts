// Admin-only: revoke someone's access. Deletes their actual Supabase Auth
// account (not just their role row) so it takes effect immediately -- they
// can't log back in with a still-valid session, the way just deleting
// user_roles and leaving the auth account behind could risk.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ message: "Not logged in." }, 401);

  const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !user) return json({ message: "Not logged in." }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: callerRole } = await admin
    .from("user_roles").select("role").eq("id", user.id).maybeSingle();
  if (callerRole?.role !== "admin") return json({ message: "Admins only." }, 403);

  let body: { userId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ message: "Invalid request body." }, 400);
  }
  if (!body.userId) return json({ message: "userId is required." }, 400);
  if (body.userId === user.id) return json({ message: "You can't remove your own access." }, 400);

  const { error: deleteErr } = await admin.auth.admin.deleteUser(body.userId);
  if (deleteErr) return json({ message: deleteErr.message }, 500);

  // user_roles row is removed automatically (ON DELETE CASCADE), but doesn't
  // hurt to be explicit in case that row somehow outlived the auth user.
  await admin.from("user_roles").delete().eq("id", body.userId);

  return json({ ok: true });
});
