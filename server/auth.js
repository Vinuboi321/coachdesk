"use strict";
/* ============================================================
   Authentication — email + password, server-side sessions.

   Sessions are rows in SQLite rather than stateless JWTs so that
   "sign out everywhere" is a DELETE and not a wait-for-expiry. The
   cookie is httpOnly + sameSite=lax, so page JavaScript can never read
   the token — an XSS bug in the frontend can't exfiltrate a session.
   ============================================================ */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db } = require("./db");
const mailer = require("./mailer");

const COOKIE = "cd_session";
const SESSION_DAYS = 30;
const RESET_TTL_MIN = 60;
const PROD = process.env.NODE_ENV === "production";
const MIN_PASSWORD = 8;

const uid = () => crypto.randomBytes(16).toString("hex");
const now = () => new Date().toISOString();

const q = {
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  userById:    db.prepare("SELECT id, email, created_at FROM users WHERE id = ?"),
  insertUser:  db.prepare(`INSERT INTO users (id,email,password_hash,created_at,seq,age_attested,age_attested_at)
                           VALUES (?,?,?,?,0,1,?)`),
  insertSess:  db.prepare("INSERT INTO sessions (token,user_id,created_at,expires_at) VALUES (?,?,?,?)"),
  sessByToken: db.prepare("SELECT * FROM sessions WHERE token = ?"),
  delSess:     db.prepare("DELETE FROM sessions WHERE token = ?"),
  delUserSess: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  purge:       db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  initProfile: db.prepare("INSERT OR IGNORE INTO profiles (user_id,data,updated_at,server_seq) VALUES (?,?,?,0)"),

  setPassword:  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
  insertReset:  db.prepare("INSERT INTO password_resets (token_hash,user_id,created_at,expires_at,used_at) VALUES (?,?,?,?,NULL)"),
  resetByHash:  db.prepare("SELECT * FROM password_resets WHERE token_hash = ?"),
  useReset:     db.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ?"),
  clearResets:  db.prepare("DELETE FROM password_resets WHERE user_id = ?"),
  purgeResets:  db.prepare("DELETE FROM password_resets WHERE expires_at < ?"),

  fullUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
  setEmail:     db.prepare("UPDATE users SET email = ? WHERE id = ?"),
  insertChg:    db.prepare("INSERT INTO email_changes (token_hash,user_id,new_email,created_at,expires_at,used_at) VALUES (?,?,?,?,?,NULL)"),
  chgByHash:    db.prepare("SELECT * FROM email_changes WHERE token_hash = ?"),
  useChg:       db.prepare("UPDATE email_changes SET used_at = ? WHERE token_hash = ?"),
  clearChgs:    db.prepare("DELETE FROM email_changes WHERE user_id = ?"),
  purgeChgs:    db.prepare("DELETE FROM email_changes WHERE expires_at < ?")
};

// Opportunistic cleanup on boot.
q.purge.run(now());
q.purgeResets.run(now());
q.purgeChgs.run(now());

const normalizeEmail = e => String(e || "").trim().toLowerCase();
const validEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e);

function setCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: PROD,
    maxAge: SESSION_DAYS * 864e5,
    path: "/"
  });
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  q.insertSess.run(token, userId, now(), exp);
  setCookie(res, token);
  return token;
}

/** Populates req.user when a valid session cookie is present. Never rejects. */
function attachUser(req, _res, next) {
  req.user = null;
  const token = req.cookies?.[COOKIE];
  if (token) {
    const s = q.sessByToken.get(token);
    if (s && new Date(s.expires_at) > new Date()) {
      req.user = q.userById.get(s.user_id) || null;
      req.sessionToken = token;
    }
  }
  next();
}

/** Gate for anything touching a coach's data. */
function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not signed in" });
  next();
}

function register(req, res) {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  // CoachDesk is a professional tool for coaches, who must be adults.
  // Checked on the server as well as the UI — a checkbox in the browser
  // is a suggestion, not a control.
  const attested = req.body?.ageAttested === true || req.body?.ageAttested === "true";

  if (!validEmail(email)) return res.status(400).json({ error: "That doesn't look like a valid email address." });
  if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password needs to be at least ${MIN_PASSWORD} characters.` });
  if (!attested) return res.status(400).json({ error: "You need to confirm you're 18 or older to use CoachDesk." });
  if (q.userByEmail.get(email)) return res.status(409).json({ error: "An account with that email already exists." });

  const id = uid();
  const hash = bcrypt.hashSync(password, 12);
  const at = now();
  db.transaction(() => {
    q.insertUser.run(id, email, hash, at, at);
    q.initProfile.run(id, JSON.stringify({}), at);
  })();

  createSession(res, id);
  res.json({ user: { id, email } });
}

function login(req, res) {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const u = q.userByEmail.get(email);

  // Same message and comparable timing whether the email exists or not,
  // so this endpoint can't be used to enumerate registered coaches.
  const ok = u ? bcrypt.compareSync(password, u.password_hash)
               : bcrypt.compareSync(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiuO");
  if (!u || !ok) return res.status(401).json({ error: "Email or password is incorrect." });

  q.initProfile.run(u.id, JSON.stringify({}), now());
  createSession(res, u.id);
  res.json({ user: { id: u.id, email: u.email } });
}

function logout(req, res) {
  if (req.sessionToken) q.delSess.run(req.sessionToken);
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
}

function logoutEverywhere(req, res) {
  q.delUserSess.run(req.user.id);
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
}

function me(req, res) {
  res.json({ user: req.user });
}

/* ============================================================
   Password reset
   ------------------------------------------------------------
   The token is random, emailed in the clear, and stored only as a
   SHA-256 hash — so a leaked database still can't be used to take over
   accounts. It is single use and expires in an hour.

   /forgot always answers "check your email", whether or not the address
   is registered. Anything else turns this endpoint into a way to find
   out which coaches have accounts.
   ============================================================ */

const hashToken = t => crypto.createHash("sha256").update(t).digest("hex");

function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host")}`;
}

async function forgot(req, res) {
  const email = normalizeEmail(req.body?.email);
  const generic = { ok: true, message: "If that email has an account, a reset link is on its way." };

  if (!validEmail(email)) return res.json(generic);
  const u = q.userByEmail.get(email);
  if (!u) return res.json(generic);           // same answer, deliberately

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + RESET_TTL_MIN * 60e3).toISOString();

  db.transaction(() => {
    q.clearResets.run(u.id);                  // one live link at a time
    q.insertReset.run(hashToken(token), u.id, now(), expires);
  })();

  const link = `${baseUrl(req)}/reset?token=${token}`;
  await mailer.send({
    to: email,
    subject: "Reset your CoachDesk password",
    text:
`Someone asked to reset the password for your CoachDesk account.

Open this link to choose a new one:

${link}

The link works once and expires in ${RESET_TTL_MIN} minutes.

If this wasn't you, you can ignore this email — your password hasn't
changed. Resetting it will sign you out on all your devices.`
  });

  res.json(generic);
}

/** Lets the reset screen show "this link has expired" before asking for a password. */
function checkReset(req, res) {
  const token = String(req.query?.token || "");
  const row = token ? q.resetByHash.get(hashToken(token)) : null;
  const valid = !!row && !row.used_at && new Date(row.expires_at) > new Date();
  res.json({ valid });
}

function reset(req, res) {
  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");

  if (password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password needs to be at least ${MIN_PASSWORD} characters.` });
  }
  const row = token ? q.resetByHash.get(hashToken(token)) : null;
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) {
    return res.status(400).json({ error: "This reset link has expired or already been used. Request a new one." });
  }

  const hash = bcrypt.hashSync(password, 12);
  db.transaction(() => {
    q.setPassword.run(hash, row.user_id);
    q.useReset.run(now(), row.token_hash);
    q.clearResets.run(row.user_id);
    // Anyone already signed in — including whoever prompted the reset —
    // gets kicked out. A reset that leaves an attacker's session alive
    // has not actually recovered the account.
    q.delUserSess.run(row.user_id);
  })();

  res.json({ ok: true, message: "Password updated. Sign in with your new password." });
}

/* ============================================================
   Changing the account email
   ------------------------------------------------------------
   The email address is the login *and* the only recovery route, so
   changing it is a high-value target: an attacker on a stolen session
   who can swap the address owns the account permanently.

   Three guards:
     1. Re-authenticate with the current password. A hijacked cookie
        alone isn't enough.
     2. The new address must confirm via an emailed link. A typo can't
        silently strand the account somewhere unreachable.
     3. The old address is told what's happening, so a legitimate owner
        finds out while they can still act.
   ============================================================ */

async function requestEmailChange(req, res) {
  const newEmail = normalizeEmail(req.body?.newEmail);
  const password = String(req.body?.password || "");
  const user = q.fullUserById.get(req.user.id);

  if (!validEmail(newEmail)) return res.status(400).json({ error: "That doesn't look like a valid email address." });
  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "That password isn't right." });
  }
  if (newEmail === user.email) return res.status(400).json({ error: "That's already your email address." });
  if (q.userByEmail.get(newEmail)) {
    // Deliberate: the person is already authenticated, so telling them
    // the address is taken reveals nothing they couldn't learn by trying
    // to register it, and a vague error here is genuinely unhelpful.
    return res.status(409).json({ error: "Another account already uses that email address." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + RESET_TTL_MIN * 60e3).toISOString();
  db.transaction(() => {
    q.clearChgs.run(user.id);
    q.insertChg.run(hashToken(token), user.id, newEmail, now(), expires);
  })();

  const link = `${baseUrl(req)}/confirm-email?token=${token}`;
  await mailer.send({
    to: newEmail,
    subject: "Confirm your new CoachDesk email",
    text:
`Confirm this address to finish moving your CoachDesk account to it:

${link}

The link works once and expires in ${RESET_TTL_MIN} minutes.
Until you open it, your account still uses ${user.email}.

If you weren't expecting this, ignore it — nothing has changed.`
  });

  // Told, not asked: this is the old owner's early warning.
  await mailer.send({
    to: user.email,
    subject: "Someone asked to change your CoachDesk email",
    text:
`A request was made to change the email on your CoachDesk account to:

  ${newEmail}

If that was you, open the link we sent to the new address to finish.

If it wasn't you, someone may have access to your account. Change your
password now — that signs out every device, including theirs. The change
cannot complete until the new address confirms it.`
  });

  res.json({ ok: true, message: `Check ${newEmail} for a confirmation link. Your address stays the same until you open it.` });
}

function checkEmailChange(req, res) {
  const token = String(req.query?.token || "");
  const row = token ? q.chgByHash.get(hashToken(token)) : null;
  const valid = !!row && !row.used_at && new Date(row.expires_at) > new Date();
  res.json({ valid, newEmail: valid ? row.new_email : null });
}

function confirmEmailChange(req, res) {
  const token = String(req.body?.token || "");
  const row = token ? q.chgByHash.get(hashToken(token)) : null;
  if (!row || row.used_at || new Date(row.expires_at) <= new Date()) {
    return res.status(400).json({ error: "This confirmation link has expired or already been used." });
  }
  // Re-checked at the moment of use: the address may have been claimed
  // between the request and the click.
  if (q.userByEmail.get(row.new_email)) {
    return res.status(409).json({ error: "Another account has claimed that email address since you asked." });
  }

  db.transaction(() => {
    q.setEmail.run(row.new_email, row.user_id);
    q.useChg.run(now(), row.token_hash);
    q.clearChgs.run(row.user_id);
    q.clearResets.run(row.user_id);   // old reset links pointed at the old address
  })();

  res.json({ ok: true, email: row.new_email, message: "Email address updated. Use it to sign in from now on." });
}

module.exports = {
  attachUser, requireUser, register, login, logout, logoutEverywhere, me,
  forgot, reset, checkReset,
  requestEmailChange, checkEmailChange, confirmEmailChange,
  // Exposed so the public demo can start a session without a password.
  // Nothing else should use this.
  createSessionFor: createSession,
  COOKIE
};
