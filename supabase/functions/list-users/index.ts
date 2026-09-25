// Admin-only: the Users screen's data -- everyone with access, plus anyone
// invited but who hasn't set their password yet ("pending"). Needs the
// service-role key because "has this person accepted their invite yet" only
// lives on their Supabase Auth record (auth.users), which isn't exposed to
// the frontend directly.

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

  const { data: roles, error: rolesErr } = await admin
    .from("user_roles").select("id, email, role, created_at").order("created_at");
  if (rolesErr) return json({ message: rolesErr.message }, 500);

  // listUsers() is paginated (200/page by default) -- fine at the scale a
  // small team's install runs at; raise perPage if this ever grows large.
  const { data: authList, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) return json({ message: listErr.message }, 500);

  const byId = new Map(authList.users.map((u) => [u.id, u]));

  const activeUsers = [];
  const pendingInvites = [];
  for (const r of roles || []) {
    const authUser = byId.get(r.id);
    const accepted = !!authUser?.email_confirmed_at || !!authUser?.last_sign_in_at;
    if (accepted) {
      activeUsers.push(r);
    } else {
      pendingInvites.push({ ...r, invited_at: authUser?.invited_at ?? authUser?.created_at });
    }
  }

  return json({ users: activeUsers, pendingInvites });
});
