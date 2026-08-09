"use strict";
/* ============================================================
   Two-device sync test.

   Spins up the real server against a throwaway database and drives it
   over HTTP with two independent cookie jars — a "phone" and a "laptop".
   The cases that matter are the ones that quietly lose a coach's data:
   conflicting edits, a delete that has to reach the other device, and an
   offline device trying to resurrect something already deleted.

   Run with:  npm test
   ============================================================ */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

process.env.SESSION_SECRET = "test-secret";
process.env.DATABASE_FILE = path.join(__dirname, "..", "data", "test.db");
fs.rmSync(path.dirname(process.env.DATABASE_FILE), { recursive: true, force: true });

/* With no SMTP configured the mailer prints each message to stdout as a
   single block. Capture those so the tests can read emailed links the way
   a developer would — out of the terminal — and assert on who was sent
   what. Everything else still prints normally. */
const mailLog = [];
const realLog = console.log;
console.log = (...args) => {
  const line = args.join(" ");
  if (/EMAIL NOT SENT/.test(line)) mailLog.push(line);
  else realLog(...args);
};
/** Recipients of every captured email, in order. */
const recipients = () =>
  mailLog.flatMap(b => [...b.matchAll(/^\s*To:\s*(\S+)/gm)].map(m => m[1]));

const app = require("../server/index.js");
const server = app.listen(4321);
const BASE = "http://localhost:4321";

/** A device = an isolated cookie jar talking to the same server. */
function device(name) {
  let cookie = null;
  return {
    name,
    async call(pathname, body) {
      const r = await fetch(BASE + pathname, {
        method: body === undefined ? "GET" : "POST",
        headers: Object.assign({ "Content-Type": "application/json" }, cookie ? { Cookie: cookie } : {}),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const sc = r.headers.getSetCookie?.() || [];
      if (sc.length) cookie = sc.map(c => c.split(";")[0]).join("; ");
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }
  };
}

const iso = ms => new Date(ms).toISOString();
let pass = 0;
const ok = (label, cond) => { assert.ok(cond, "FAILED: " + label); console.log("  ok  " + label); pass++; };

(async () => {
  const A = device("phone"), B = device("laptop");

  /* ---- auth ---- */
  const signup = (email, password, extra) =>
    Object.assign({ email, password, ageAttested: true }, extra || {});

  let r = await A.call("/api/auth/register", signup("coach@example.com", "short"));
  ok("rejects a short password", r.status === 400);

  r = await A.call("/api/auth/register", signup("not-an-email", "longenough1"));
  ok("rejects a malformed email", r.status === 400);

  /* ---- 18+ attestation ---- */
  r = await A.call("/api/auth/register", { email: "minor@example.com", password: "correcthorse" });
  ok("refuses signup with no age attestation", r.status === 400 && /18 or older/.test(r.body.error));

  r = await A.call("/api/auth/register", { email: "minor@example.com", password: "correcthorse", ageAttested: false });
  ok("refuses signup when attestation is declined", r.status === 400);

  r = await A.call("/api/auth/register", { email: "minor@example.com", password: "correcthorse", ageAttested: "yes please" });
  ok("refuses a truthy-but-wrong attestation value", r.status === 400);

  r = await A.call("/api/auth/register", signup("Coach@Example.com ", "correcthorse"));
  ok("registers and normalises the email", r.status === 200 && r.body.user.email === "coach@example.com");

  r = await A.call("/api/auth/register", signup("coach@example.com", "correcthorse"));
  ok("blocks a duplicate signup", r.status === 409);

  r = await B.call("/api/auth/login", { email: "coach@example.com", password: "wrongpass1" });
  ok("rejects the wrong password", r.status === 401);

  r = await B.call("/api/auth/login", { email: "coach@example.com", password: "correcthorse" });
  ok("second device signs in", r.status === 200);

  r = await device("stranger").call("/api/sync", { since: 0, push: {} });
  ok("sync requires authentication", r.status === 401);

  /* ---- A creates data ---- */
  const t0 = Date.now();
  r = await A.call("/api/sync", { since: 0, push: {
    clients: [{ id: "c1", name: "Maya Chen", tags: ["tennis"], notes: [], updated_at: iso(t0) }],
    events:  [{ id: "e1", title: "Lesson", clientId: "c1", start: iso(t0 + 864e5), durationMin: 60, updated_at: iso(t0) }],
    profile: { name: "Alex Rivera", title: "Tennis Coach", updated_at: iso(t0) }
  }});
  ok("A pushes three records", r.body.applied === 3);
  const cursorA1 = r.body.cursor;

  /* ---- B pulls them ---- */
  r = await B.call("/api/sync", { since: 0, push: {} });
  ok("B receives the client", r.body.pull.clients.length === 1 && r.body.pull.clients[0].name === "Maya Chen");
  ok("B receives the event", r.body.pull.events.length === 1);
  ok("B receives the profile", r.body.pull.profile && r.body.pull.profile.name === "Alex Rivera");
  const cursorB1 = r.body.cursor;

  r = await B.call("/api/sync", { since: cursorB1, push: {} });
  ok("an incremental pull returns nothing new", r.body.pull.clients.length === 0 && r.body.pull.events.length === 0);

  /* ---- conflict ---- */
  await A.call("/api/sync", { since: cursorA1, push: {
    clients: [{ id: "c1", name: "Maya Chen-Alvarez", tags: ["tennis"], notes: [], updated_at: iso(t0 + 5000) }] }});
  r = await B.call("/api/sync", { since: cursorB1, push: {
    clients: [{ id: "c1", name: "STALE NAME", tags: [], notes: [], updated_at: iso(t0 + 1000) }] }});
  ok("an older write is rejected as stale", r.body.stale === 1 && r.body.applied === 0);
  ok("the losing device is corrected in the same response",
     r.body.pull.clients.length === 1 && r.body.pull.clients[0].name === "Maya Chen-Alvarez");

  r = await B.call("/api/sync", { since: r.body.cursor, push: {
    clients: [{ id: "c1", name: "Maya Alvarez", tags: ["tennis"], notes: [], updated_at: iso(t0 + 9000) }] }});
  ok("a newer write is applied", r.body.applied === 1);

  r = await A.call("/api/sync", { since: cursorA1, push: {} });
  ok("A converges on the newer name", r.body.pull.clients.some(c => c.name === "Maya Alvarez"));

  /* ---- deletes ---- */
  await A.call("/api/sync", { since: r.body.cursor, push: {
    events: [{ id: "e1", title: "Lesson", start: iso(t0 + 864e5), updated_at: iso(t0 + 10000), deleted: true }] }});
  r = await B.call("/api/sync", { since: cursorB1, push: {} });
  const del = r.body.pull.events.find(e => e.id === "e1");
  ok("the delete reaches the other device as a tombstone", del && del.deleted === true);

  r = await B.call("/api/sync", { since: r.body.cursor, push: {
    events: [{ id: "e1", title: "Lesson", start: iso(t0 + 864e5), updated_at: iso(t0 + 2000) }] }});
  ok("an offline device cannot resurrect a deleted record", r.body.stale === 1);

  /* ---- validation ---- */
  r = await A.call("/api/sync", { since: 0, push: { clients: [{ name: "no id, no timestamp" }] } });
  ok("a malformed record is rejected, not stored", r.body.invalid === 1);

  /* ---- snapshot ---- */
  r = await B.call("/api/snapshot");
  ok("the snapshot omits deleted records", r.body.events.length === 0 && r.body.clients.length === 1);
  ok("the snapshot carries the profile", r.body.profile.name === "Alex Rivera");

  /* ---- tenant isolation ---- */
  const C = device("other-coach");
  await C.call("/api/auth/register", signup("other@example.com", "anotherpass1"));
  r = await C.call("/api/snapshot");
  ok("a different coach sees none of it", r.body.clients.length === 0 && r.body.events.length === 0);

  /* ---- session revocation ---- */
  await A.call("/api/auth/logout-all", {});
  r = await B.call("/api/snapshot");
  ok("sign out everywhere revokes the other device", r.status === 401);

  /* ---- google degrades, never crashes ---- */
  const D = device("d");
  await D.call("/api/auth/login", { email: "other@example.com", password: "anotherpass1" });
  r = await D.call("/api/google/status");
  ok("google status reports unconfigured", r.status === 200 && r.body.configured === false);
  r = await D.call("/api/google/connect", {});
  ok("google connect fails with a clear message", r.status === 503 && r.body.error === "not_configured");

  /* ---- password reset ----
     Tokens are only ever emailed, so the test reads them out of the
     console fallback rather than the database — the same path a real
     user takes when SMTP isn't configured. */
  const linkFor = () => {
    const m = /\/reset\?token=([a-f0-9]{64})/.exec(mailLog.join("\n"));
    return m ? m[1] : null;
  };

  mailLog.length = 0;
  const E = device("reset-device");
  r = await E.call("/api/auth/forgot", { email: "nobody@example.com" });
  ok("forgot gives the same answer for an unknown email", r.status === 200 && r.body.ok === true);
  ok("...and sends nothing", linkFor() === null);

  mailLog.length = 0;
  r = await E.call("/api/auth/forgot", { email: "coach@example.com" });
  ok("forgot accepts a known email with the identical response", r.status === 200 && r.body.ok === true);
  const token1 = linkFor();
  ok("a reset token is emailed", !!token1);

  r = await E.call("/api/auth/reset?token=" + token1);
  ok("the token validates before asking for a password", r.body.valid === true);

  r = await E.call("/api/auth/reset?token=" + "0".repeat(64));
  ok("an unknown token does not validate", r.body.valid === false);

  r = await E.call("/api/auth/reset", { token: token1, password: "short" });
  ok("reset refuses a short password", r.status === 400);

  // Requesting again must invalidate the previous link.
  mailLog.length = 0;
  await E.call("/api/auth/forgot", { email: "coach@example.com" });
  const token2 = linkFor();
  ok("a second request issues a different token", !!token2 && token2 !== token1);
  r = await E.call("/api/auth/reset", { token: token1, password: "brandnewpass" });
  ok("the superseded token is refused", r.status === 400);

  // A live session that should not survive the reset.
  const F = device("stale-session");
  await F.call("/api/auth/login", { email: "coach@example.com", password: "correcthorse" });
  r = await F.call("/api/snapshot");
  ok("that session works before the reset", r.status === 200);

  r = await E.call("/api/auth/reset", { token: token2, password: "brandnewpass" });
  ok("reset succeeds with a valid token", r.status === 200 && r.body.ok === true);

  r = await F.call("/api/snapshot");
  ok("resetting revokes every existing session", r.status === 401);

  r = await E.call("/api/auth/reset", { token: token2, password: "yetanotherpass" });
  ok("the token cannot be used twice", r.status === 400);

  const G = device("post-reset");
  r = await G.call("/api/auth/login", { email: "coach@example.com", password: "correcthorse" });
  ok("the old password no longer works", r.status === 401);

  r = await G.call("/api/auth/login", { email: "coach@example.com", password: "brandnewpass" });
  ok("the new password works", r.status === 200);

  r = await G.call("/api/snapshot");
  ok("data survived the reset intact", r.body.clients.length === 1 && r.body.profile.name === "Alex Rivera");

  /* ---- changing the account email ---- */
  const emailLink = () => {
    const m = /\/confirm-email\?token=([a-f0-9]{64})/.exec(mailLog.join("\n"));
    return m ? m[1] : null;
  };

  r = await device("anon").call("/api/auth/email", { newEmail: "x@y.com", password: "brandnewpass" });
  ok("email change requires a session", r.status === 401);

  r = await G.call("/api/auth/email", { newEmail: "new@example.com", password: "wrongpassword" });
  ok("email change requires the correct password", r.status === 401);

  r = await G.call("/api/auth/email", { newEmail: "not-an-email", password: "brandnewpass" });
  ok("email change rejects a malformed address", r.status === 400);

  r = await G.call("/api/auth/email", { newEmail: "coach@example.com", password: "brandnewpass" });
  ok("email change rejects your own current address", r.status === 400);

  r = await G.call("/api/auth/email", { newEmail: "other@example.com", password: "brandnewpass" });
  ok("email change rejects an address already in use", r.status === 409);

  mailLog.length = 0;
  r = await G.call("/api/auth/email", { newEmail: "new@example.com", password: "brandnewpass" });
  ok("email change request accepted", r.status === 200 && r.body.ok === true);
  const chgToken = emailLink();
  ok("a confirmation token is emailed", !!chgToken);

  const to = recipients();
  ok("the confirmation goes to the new address", to.includes("new@example.com"));
  ok("the current address is warned as well", to.includes("coach@example.com"));
  ok("the warning to the old address carries no usable token",
     !/confirm-email\?token=/.test(mailLog.find(b => /To:\s*coach@example\.com/.test(b)) || ""));

  r = await G.call("/api/auth/login", { email: "coach@example.com", password: "brandnewpass" });
  ok("the old address still works before confirmation", r.status === 200);

  r = await G.call("/api/auth/email/confirm?token=" + chgToken);
  ok("the token previews the pending address", r.body.valid === true && r.body.newEmail === "new@example.com");

  r = await G.call("/api/auth/email/confirm", { token: chgToken });
  ok("confirming applies the change", r.status === 200 && r.body.email === "new@example.com");

  r = await G.call("/api/auth/email/confirm", { token: chgToken });
  ok("the confirmation token cannot be reused", r.status === 400);

  const H = device("after-email");
  r = await H.call("/api/auth/login", { email: "coach@example.com", password: "brandnewpass" });
  ok("the old address no longer signs in", r.status === 401);

  r = await H.call("/api/auth/login", { email: "new@example.com", password: "brandnewpass" });
  ok("the new address signs in", r.status === 200);

  r = await H.call("/api/snapshot");
  ok("data survived the email change", r.body.clients.length === 1);

  /* ---- consent fields round-trip through sync ---- */
  const consentAt = iso(t0);
  r = await H.call("/api/sync", { since: 0, push: { clients: [{
    id: "c2", name: "Jamie Lin", isMinor: true,
    guardian: { name: "Robin Lin", contact: "555-0199" },
    consent: { obtained: true, at: consentAt, method: "Signed form" },
    tags: [], notes: [], updated_at: iso(t0 + 20000)
  }]}});
  ok("a minor client with consent is accepted", r.body.applied === 1);

  const I = device("other-device");
  await I.call("/api/auth/login", { email: "new@example.com", password: "brandnewpass" });
  r = await I.call("/api/snapshot");
  const jamie = r.body.clients.find(c => c.id === "c2");
  ok("the minor flag survives sync", jamie && jamie.isMinor === true);
  ok("guardian details survive sync", jamie.guardian.name === "Robin Lin" && jamie.guardian.contact === "555-0199");
  ok("the consent record survives sync",
     jamie.consent.obtained === true && jamie.consent.at === consentAt && jamie.consent.method === "Signed form");

  /* ---- throttling ----
     Regression: the limiter once keyed on IP alone for bodies with no
     'email' field, so finishing a password reset ate the budget for
     changing an email. Buckets must be per route and per identity. */
  const T = device("throttle");
  const hammer = "hammer@example.com";
  let last;
  for (let i = 0; i < 11; i++) last = await T.call("/api/auth/login", { email: hammer, password: "nope12345" });
  ok("repeated login attempts are throttled", last.status === 429);

  r = await T.call("/api/auth/login", { email: "new@example.com", password: "brandnewpass" });
  ok("a different account is unaffected by that bucket", r.status === 200);

  r = await T.call("/api/auth/forgot", { email: hammer });
  ok("a different route is unaffected by that bucket", r.status === 200);

  console.log(`\n  ${pass} checks passed\n`);
  server.close();
  process.exit(0);
})().catch(e => {
  console.error("\n  " + e.message + "\n");
  server.close();
  process.exit(1);
});
