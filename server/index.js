"use strict";
require("dotenv").config();

const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");

const auth = require("./auth");
const mailer = require("./mailer");
const parser = require("./parse");
const demo = require("./demo");
const { handleSync, handleSnapshot } = require("./sync");
const googleRoutes = require("./google");

/* Free hosting tiers usually have no persistent disk, so the database is
   lost on restart. When that's the case we say so in the UI rather than
   letting someone lose real work without warning. */
const EPHEMERAL = String(process.env.EPHEMERAL_STORAGE || "") === "true";

if (!process.env.SESSION_SECRET) {
  console.warn("\n  ! SESSION_SECRET is not set. Copy .env.example to .env before using this for anything real.\n");
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(express.json({ limit: "6mb" }));   // a large sync push is legitimately big
app.use(cookieParser(process.env.SESSION_SECRET || "dev-secret"));
app.use(auth.attachUser);

/* Modest in-memory throttle on auth endpoints. Not a substitute for a real
   rate limiter behind a proxy, but it stops trivial credential stuffing
   against a local instance.

   The bucket is keyed by IP *and route* *and* whichever identity the body
   carries. Keying on IP alone would lump unrelated endpoints together —
   finishing a password reset would eat the budget for changing an email,
   and everyone behind one office NAT would share a single allowance. */
const WINDOW_MS = 15 * 60e3;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

// Bounded cleanup so the map can't grow without limit on a long-lived process.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, v] of attempts) if (v.at < cutoff) attempts.delete(k);
}, 5 * 60e3).unref?.();

function throttle(req, res, next) {
  const who = String(req.body?.email || req.body?.newEmail || "").toLowerCase();
  const key = `${req.ip}|${req.path}|${who}`;
  const now = Date.now();

  let rec = attempts.get(key);
  if (!rec || now - rec.at > WINDOW_MS) rec = { n: 0, at: now };
  if (rec.n >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: "Too many attempts. Wait 15 minutes and try again." });
  }
  rec.n++;
  attempts.set(key, rec);
  next();
}

/* --- auth --- */
app.post("/api/auth/register", throttle, auth.register);
app.post("/api/auth/login",    throttle, auth.login);
app.post("/api/auth/logout",   auth.logout);
app.post("/api/auth/logout-all", auth.requireUser, auth.logoutEverywhere);

/* Also carries the flags the sign-in screen needs before anyone is
   authenticated, saving a second round trip on first paint. */
app.get("/api/auth/me", (req, res) => res.json({
  user: req.user,
  demo: demo.enabled(),
  ephemeral: EPHEMERAL
}));

/* One-click public demo. Resets the workspace each time so every visitor
   gets a clean, populated account rather than the last person's edits. */
app.post("/api/auth/demo", throttle, (req, res) => {
  if (!demo.enabled()) return res.status(404).json({ error: "The demo isn't enabled on this server." });
  try {
    const id = demo.userId() || demo.ensureDemoUser();
    demo.resetDemoData(id);
    auth.createSessionFor(res, id);
    res.json({ user: { id, email: demo.email() }, demo: true });
  } catch (e) {
    console.error("demo login failed", e);
    res.status(500).json({ error: "Couldn't start the demo." });
  }
});

/* Reset requests are throttled harder than login: this endpoint sends
   email, so abusing it burns someone else's inbox, not just CPU. */
app.post("/api/auth/forgot", throttle, auth.forgot);
app.get ("/api/auth/reset",  auth.checkReset);
app.post("/api/auth/reset",  throttle, auth.reset);

/* Changing the login email. The request needs a live session AND the
   current password; confirmation deliberately does not, because the
   coach may open the link in a browser they aren't signed in on. */
app.post("/api/auth/email",         auth.requireUser, throttle, auth.requestEmailChange);
app.get ("/api/auth/email/confirm", auth.checkEmailChange);
app.post("/api/auth/email/confirm", throttle, auth.confirmEmailChange);

/* --- sync --- */
app.post("/api/sync",     auth.requireUser, handleSync);
app.get ("/api/snapshot", auth.requireUser, handleSnapshot);

/* --- google calendar --- */
app.get ("/api/google/status",     auth.requireUser, googleRoutes.status);
app.post("/api/google/connect",    auth.requireUser, googleRoutes.connect);
app.get ("/api/google/callback",   googleRoutes.callback);
app.post("/api/google/sync",       auth.requireUser, googleRoutes.runSync);
app.post("/api/google/disconnect", auth.requireUser, googleRoutes.disconnect);

/* AI parsing fallback. Signed-in only — it spends money on the operator's
   API key, so it isn't an open endpoint. */
app.post("/api/parse", auth.requireUser, parser.handleParse);

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  google: googleRoutes.configured(),
  email: mailer.configured(),
  ai: parser.configured()
}));

/* --- static frontend --- */
app.use(express.static(path.join(__dirname, "..", "public"), { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  if (demo.enabled()) {
    try { demo.ensureDemoUser(); }
    catch (e) { console.error("  ! Couldn't provision the demo account:", e.message); }
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  CoachDesk running at http://localhost:${PORT}`);
    console.log(`  Google Calendar: ${googleRoutes.configured() ? "credentials found" : "not configured (optional)"}`);
    console.log(`  Email:           ${mailer.configured() ? "SMTP configured" : "not configured — reset links print here"}`);
    console.log(`  AI parsing:      ${parser.configured() ? "enabled (fallback only)" : "off — rules only"}`);
    console.log(`  Public demo:     ${demo.enabled() ? "on — " + demo.email() : "off"}`);
    if (EPHEMERAL) console.log(`  Storage:         ephemeral — data resets on restart`);
    console.log("");
  });
}

module.exports = app;
