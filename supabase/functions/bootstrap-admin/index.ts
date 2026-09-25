// Creates the very first admin account -- the in-browser "set up your admin
// account" screen (no .env editing) calls this once, on a brand new
// install. Refuses to run again once anyone exists, so it's safe to leave
// deployed permanently rather than a one-shot script you have to remove.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { count, error: countErr } = await admin
    .from("user_roles")
    .select("id", { count: "exact", head: true });
  if (countErr) {
    return new Response(JSON.stringify({ message: countErr.message }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // GET: just answers "does this install still need a first admin?" -- the
  // frontend calls this on every page load, before anyone is signed in, to
  // decide whether to show the setup screen or the login screen.
  if (req.method === "GET") {
    return new Response(JSON.stringify({ needsSetup: (count ?? 0) === 0 }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  if ((count ?? 0) > 0) {
    return new Response(JSON.stringify({ message: "Setup has already been completed." }), {
      status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ message: "Invalid request body." }), {
      status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  const email = body.email?.toLowerCase().trim();
  const password = body.password;
  if (!email || !password) {
    return new Response(JSON.stringify({ message: "Email and password are required." }), {
      status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
  if (password.length < 8) {
    return new Response(JSON.stringify({ message: "Password must be at least 8 characters." }), {
      status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (createErr || !created.user) {
    return new Response(JSON.stringify({ message: createErr?.message || "Could not create account." }), {
      status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  await admin.from("user_roles").insert({ id: created.user.id, email, role: "admin" });

  return new Response(JSON.stringify({ id: created.user.id, email, role: "admin" }), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
});
