"use strict";
/* ============================================================
   Public demo account.

   Most people who open a portfolio link will not create an account. So
   when PUBLIC_DEMO=true there's a one-click way in, landing on a
   populated workspace rather than an empty one.

   The data resets on every demo sign-in. That keeps the demo honest
   (nobody inherits a previous visitor's mess) and means the shared
   account can't be vandalised for long. The trade-off is that two people
   poking at it simultaneously will reset each other — acceptable, and
   far better than an empty app or a defaced one.
   ============================================================ */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db, nextSeq } = require("./db");
// Shared with the browser build so the hosted demo and the static demo
// can't drift apart. UMD wrapper makes it loadable both ways.
const { buildSeed } = require("../public/seed.js");

const ENABLED = String(process.env.PUBLIC_DEMO || "") === "true";
const EMAIL = (process.env.DEMO_EMAIL || "demo@coachdesk.app").toLowerCase();

const uid = () => crypto.randomBytes(9).toString("hex");
const nowIso = () => new Date().toISOString();

const q = {
  byEmail:  db.prepare("SELECT * FROM users WHERE email = ?"),
  insert:   db.prepare(`INSERT INTO users (id,email,password_hash,created_at,seq,age_attested,age_attested_at)
                        VALUES (?,?,?,?,0,1,?)`),
  wipeRecs: db.prepare("DELETE FROM records WHERE user_id = ?"),
  addRec:   db.prepare(`INSERT INTO records (user_id,kind,id,data,updated_at,deleted,server_seq)
                        VALUES (@user_id,@kind,@id,@data,@updated_at,0,@server_seq)`),
  setProf:  db.prepare(`INSERT INTO profiles (user_id,data,updated_at,server_seq) VALUES (?,?,?,?)
                        ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,
                          updated_at=excluded.updated_at, server_seq=excluded.server_seq`)
};


/** Wipe and repopulate the demo workspace. */
function resetDemoData(userId) {
  const { clients, events, profile } = buildSeed(uid);
  const stamp = nowIso();

  db.transaction(() => {
    q.wipeRecs.run(userId);
    for (const rec of clients) {
      const body = Object.assign({}, rec); delete body.id;
      q.addRec.run({ user_id: userId, kind: "client", id: rec.id,
        data: JSON.stringify(Object.assign(body, { id: rec.id })),
        updated_at: stamp, server_seq: nextSeq(userId) });
    }
    for (const rec of events) {
      const body = Object.assign({}, rec);
      q.addRec.run({ user_id: userId, kind: "event", id: rec.id,
        data: JSON.stringify(body),
        updated_at: stamp, server_seq: nextSeq(userId) });
    }
    q.setProf.run(userId, JSON.stringify(profile), stamp, nextSeq(userId));
  })();
}

/** Called once at boot. Safe to run repeatedly. */
function ensureDemoUser() {
  if (!ENABLED) return null;
  let u = q.byEmail.get(EMAIL);
  if (!u) {
    const id = crypto.randomBytes(16).toString("hex");
    const hash = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10);
    q.insert.run(id, EMAIL, hash, nowIso(), nowIso());
    u = q.byEmail.get(EMAIL);
  }
  resetDemoData(u.id);
  return u.id;
}

module.exports = {
  enabled: () => ENABLED,
  email: () => EMAIL,
  ensureDemoUser,
  resetDemoData,
  userId: () => (q.byEmail.get(EMAIL) || {}).id || null
};
