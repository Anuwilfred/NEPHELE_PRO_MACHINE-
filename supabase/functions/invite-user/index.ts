// Admin-only: invite someone by email. Uses the service-role key to call
// Supabase Auth's inviteUserByEmail (which only works with that key, never
// from the browser) -- that's why this has to be an Edge Function rather
// than something the frontend does directly. Supabase sends the actual
// email itself (free tier, no SMTP setup needed); the link in it lands the
// person on accept-invite.html, where they set their own password.

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

  // A client bound to the CALLER's own session, just to find out who they
  // are -- separate from the admin client below, which acts with full
  // privileges once we've confirmed the caller is allowed to.
  const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await asCaller.auth.getUser();
  if (userErr || !user) return json({ message: "Not logged in." }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: callerRole } = await admin
    .from("user_roles").select("role").eq("id", user.id).maybeSingle();
  if (callerRole?.role !== "admin") return json({ message: "Admins only." }, 403);

  let body: { email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return json({ message: "Invalid request body." }, 400);
  }
  const email = body.email?.toLowerCase().trim();
  if (!email) return json({ message: "Email is required." }, 400);
  const role = body.role === "admin" ? "admin" : "viewer";

  const redirectTo = Deno.env.get("PUBLIC_ACCEPT_INVITE_URL") || undefined;
  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo });

  if (inviteErr || !invited.user) {
    // Most common case: that email already has an account.
    return json({ message: inviteErr?.message || "Could not send invite." }, 409);
  }

  await admin.from("user_roles").insert({
    id: invited.user.id, email, role, invited_by: user.id,
  });

  return json({ ok: true, email, role });
});
