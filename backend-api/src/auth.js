// Accounts, sessions, and email invites. Kept as a self-contained module
// (rather than spreading auth logic through index.js) so it's easy to see
// everything that touches who's allowed in.
//
// Design choices, and why:
//  - Passwords are hashed with bcryptjs (pure JS, no native build step --
//    matters because this has to install cleanly on a Windows machine with
//    no compiler installed).
//  - Sessions are a random token stored server-side (a `sessions` row), not
//    a JWT -- so "remove this person's access" (DELETE /api/auth/users/:id)
//    takes effect immediately, rather than waiting for a token to expire.
//  - Cookies are parsed by hand (a few lines below) instead of adding the
//    cookie-parser package -- one less dependency to install on a machine
//    that already had enough npm/network trouble earlier in this project.
//  - Roles are deliberately just two: 'admin' (can invite/remove people and
//    edit tag settings) and 'viewer' (can see everything, can't change
//    anything). Simple on purpose.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");

const SESSION_COOKIE = "vd_session";
const SESSION_DAYS = 30;
const INVITE_HOURS = 72;

// --- Schema (self-migrating, same pattern as ingestion-service/src/db.js) --

async function ensureAuthSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      invited_by    TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      token       TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'viewer',
      invited_by  TEXT REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ
    );
  `);
}

// Creates the very first admin account if the users table is still empty.
// ADMIN_EMAIL / ADMIN_PASSWORD come from the installer's setup form (see
// README) so there's always a way in on a brand new install.
async function bootstrapFirstAdmin(pool) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users");
  if (rows[0].n > 0) return;

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    console.warn(
      "No users exist yet and ADMIN_EMAIL/ADMIN_PASSWORD aren't set -- " +
        "nobody will be able to log in until an admin account exists."
    );
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
    [crypto.randomUUID(), email.toLowerCase().trim(), passwordHash]
  );
  console.log(`Created first admin account for ${email}.`);
}

// --- Cookies (parsed by hand -- see file header for why) -------------------

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token) {
  // COOKIE_SECURE=true once this sits behind HTTPS (e.g. a Cloudflare
  // Tunnel or a reverse proxy with a real certificate) -- until then it
  // defaults off so login still works over plain http on the local/
  // port-forwarded network this is running on today.
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE);
}

// --- Session lookups ---------------------------------------------------------

async function getUserFromRequest(pool, req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [token]
  );
  return rows[0] || null;
}

// --- Middleware --------------------------------------------------------------

function requireAuth(pool) {
  return async (req, res, next) => {
    const user = await getUserFromRequest(pool, req);
    if (!user) return res.status(401).json({ message: "Not logged in." });
    req.user = user;
    next();
  };
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Admins only." });
  }
  next();
}

// --- Email (invites) ----------------------------------------------------------
// Uses a Gmail/Google Workspace account's SMTP with an "App Password" (free,
// no card -- see README). If it isn't configured, invites still work: the
// admin just gets the invite link back in the response to share by hand.

function makeTransport() {
  if (!process.env.SMTP_USER || !process.env.SMTP_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_APP_PASSWORD,
    },
  });
}

async function sendInviteEmail(toEmail, link) {
  const transport = makeTransport();
  if (!transport) return { sent: false };

  await transport.sendMail({
    from: `"Vessel Dashboard" <${process.env.SMTP_USER}>`,
    to: toEmail,
    subject: "You've been invited to the Vessel Dashboard",
    text: `You've been given access to the vessel dashboard.\n\nSet your password here (link valid for 72 hours):\n${link}`,
    html: `<p>You've been given access to the vessel dashboard.</p><p><a href="${link}">Set your password</a> (link valid for 72 hours).</p>`,
  });
  return { sent: true };
}

// --- Routes ----------------------------------------------------------------

function createAuthRouter(express, pool) {
  const router = express.Router();

  // Lets the frontend show a "create your admin account" screen on a brand
  // new install instead of a login form -- no .env editing required. Still
  // works fine alongside ADMIN_EMAIL/ADMIN_PASSWORD (see bootstrapFirstAdmin
  // above) for anyone who prefers setting it that way; whichever happens
  // first wins, since both only ever act while the users table is empty.
  router.get("/setup-status", async (req, res) => {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users");
    res.json({ needsSetup: rows[0].n === 0 });
  });

  router.post("/setup", async (req, res) => {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users");
    if (rows[0].n > 0) {
      return res.status(409).json({ message: "Setup has already been completed." });
    }

    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
      [userId, email.toLowerCase().trim(), passwordHash]
    );

    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [token, userId]
    );
    setSessionCookie(res, token);
    res.json({ id: userId, email: email.toLowerCase().trim(), role: "admin" });
  });

  router.post("/login", async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [
      email.toLowerCase().trim(),
    ]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(password, user.password_hash));
    if (!ok) {
      return res.status(401).json({ message: "Incorrect email or password." });
    }

    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [token, user.id]
    );
    setSessionCookie(res, token);
    res.json({ id: user.id, email: user.email, role: user.role });
  });

  router.post("/logout", async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE];
    if (token) await pool.query("DELETE FROM sessions WHERE id = $1", [token]);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get("/me", async (req, res) => {
    const user = await getUserFromRequest(pool, req);
    if (!user) return res.status(401).json({ message: "Not logged in." });
    res.json(user);
  });

  // --- Admin-only: invite / list / remove people --------------------------

  router.post("/invite", requireAuth(pool), requireAdmin, async (req, res) => {
    const { email, role } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email is required." });
    const cleanRole = role === "admin" ? "admin" : "viewer";
    const cleanEmail = email.toLowerCase().trim();

    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [cleanEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: "That person already has an account." });
    }

    const token = crypto.randomBytes(24).toString("hex");
    await pool.query(
      `INSERT INTO invites (token, email, role, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '${INVITE_HOURS} hours')`,
      [token, cleanEmail, cleanRole, req.user.id]
    );

    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
    const link = `${base}/accept-invite.html?token=${token}`;

    let emailResult = { sent: false };
    try {
      emailResult = await sendInviteEmail(cleanEmail, link);
    } catch (err) {
      console.warn("Failed to send invite email:", err.message);
    }

    res.json({ link, emailSent: emailResult.sent });
  });

  router.get("/users", requireAuth(pool), requireAdmin, async (req, res) => {
    const { rows } = await pool.query(
      "SELECT id, email, role, created_at FROM users ORDER BY created_at"
    );
    const invites = await pool.query(
      `SELECT token, email, role, created_at, expires_at FROM invites
       WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at`
    );
    res.json({ users: rows, pendingInvites: invites.rows });
  });

  router.delete("/users/:id", requireAuth(pool), requireAdmin, async (req, res) => {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ message: "You can't remove your own access." });
    }
    await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  });

  router.delete("/invites/:token", requireAuth(pool), requireAdmin, async (req, res) => {
    await pool.query("DELETE FROM invites WHERE token = $1", [req.params.token]);
    res.json({ ok: true });
  });

  // --- Public: accepting an invite --------------------------------------

  router.get("/invites/:token", async (req, res) => {
    const { rows } = await pool.query(
      `SELECT email, role FROM invites WHERE token = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [req.params.token]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "This invite link is invalid or has expired." });
    }
    res.json(rows[0]);
  });

  router.post("/accept-invite", async (req, res) => {
    const { token, password } = req.body || {};
    if (!token || !password) {
      return res.status(400).json({ message: "Missing token or password." });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters." });
    }

    const { rows } = await pool.query(
      `SELECT email, role FROM invites WHERE token = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [token]
    );
    const invite = rows[0];
    if (!invite) {
      return res.status(404).json({ message: "This invite link is invalid or has expired." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [userId, invite.email, passwordHash, invite.role]
    );
    await pool.query("UPDATE invites SET accepted_at = now() WHERE token = $1", [token]);

    const user = (
      await pool.query("SELECT id, email, role FROM users WHERE email = $1", [invite.email])
    ).rows[0];

    const sessionToken = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
      [sessionToken, user.id]
    );
    setSessionCookie(res, sessionToken);
    res.json(user);
  });

  return router;
}

module.exports = {
  ensureAuthSchema,
  bootstrapFirstAdmin,
  requireAuth,
  requireAdmin,
  createAuthRouter,
};
