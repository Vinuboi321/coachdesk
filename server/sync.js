"use strict";
/* ============================================================
   Delta sync — multi-device convergence.

   Protocol
   --------
   POST /api/sync  { since: <int>, push: { clients[], events[], profile? } }
   ->              { cursor: <int>, pull: { clients[], events[], profile? }, applied, rejected }

   'since' is a server sequence number, not a timestamp. The server hands
   back a new cursor each round; the device stores it and sends it next
   time. Because the counter only ever advances on the server, a device
   with a wrong clock can't skip records.

   Conflict resolution is last-write-wins on the device's logical
   'updated_at'. When an incoming record is older than what's stored, the
   write is rejected and the stored version is returned in the same
   response — so the losing device corrects itself immediately rather
   than sitting on a stale value.

   Deletes are soft (deleted = 1). A hard delete is invisible to a device
   that was offline when it happened: it would re-upload the record and
   resurrect it. Tombstones are the fix.
   ============================================================ */

const { db, nextSeq, currentSeq } = require("./db");

const KINDS = ["client", "event"];
const MAX_PUSH = 2000;          // ceiling per request, keeps one device from monopolising
const MAX_FIELD = 20000;        // per-record JSON ceiling

const q = {
  get:      db.prepare("SELECT * FROM records WHERE user_id=? AND kind=? AND id=?"),
  upsert:   db.prepare(`INSERT INTO records (user_id,kind,id,data,updated_at,deleted,server_seq)
                        VALUES (@user_id,@kind,@id,@data,@updated_at,@deleted,@server_seq)
                        ON CONFLICT(user_id,kind,id) DO UPDATE SET
                          data=@data, updated_at=@updated_at, deleted=@deleted, server_seq=@server_seq`),
  since:    db.prepare("SELECT kind,id,data,updated_at,deleted FROM records WHERE user_id=? AND server_seq>? ORDER BY server_seq"),
  profile:  db.prepare("SELECT * FROM profiles WHERE user_id=?"),
  setProf:  db.prepare(`INSERT INTO profiles (user_id,data,updated_at,server_seq) VALUES (?,?,?,?)
                        ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,
                          updated_at=excluded.updated_at, server_seq=excluded.server_seq`),
  allRecs:  db.prepare("SELECT kind,id,data,updated_at,deleted FROM records WHERE user_id=? AND deleted=0")
};

const isoOrNull = v => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Newer wins; ties go to the stored copy so repeat pushes are no-ops. */
const incomingWins = (incoming, stored) => !stored || incoming > stored.updated_at;

function validate(rec) {
  if (!rec || typeof rec !== "object") return "not an object";
  if (typeof rec.id !== "string" || !rec.id || rec.id.length > 64) return "bad id";
  const at = isoOrNull(rec.updated_at);
  if (!at) return "missing or invalid updated_at";
  return null;
}

/**
 * Apply one incoming record. Returns 'applied' | 'stale' | 'invalid'.
 * Must run inside a transaction (it allocates a sequence number).
 */
function applyRecord(userId, kind, rec) {
  const bad = validate(rec);
  if (bad) return { status: "invalid", reason: bad };

  const updated_at = isoOrNull(rec.updated_at);
  const stored = q.get.get(userId, kind, rec.id);
  if (!incomingWins(updated_at, stored)) return { status: "stale", stored };

  const body = Object.assign({}, rec);
  delete body.updated_at;
  delete body.deleted;
  const data = JSON.stringify(body);
  if (data.length > MAX_FIELD) return { status: "invalid", reason: "record too large" };

  q.upsert.run({
    user_id: userId, kind, id: rec.id, data, updated_at,
    deleted: rec.deleted ? 1 : 0,
    server_seq: nextSeq(userId)
  });
  return { status: "applied" };
}

const hydrate = r => Object.assign(JSON.parse(r.data), {
  id: r.id, updated_at: r.updated_at, deleted: !!r.deleted
});

function handleSync(req, res) {
  const userId = req.user.id;
  const since = Number.isFinite(+req.body?.since) ? Math.max(0, Math.floor(+req.body.since)) : 0;
  const push = req.body?.push || {};

  const counts = { applied: 0, stale: 0, invalid: 0 };
  const problems = [];

  try {
    db.transaction(() => {
      for (const kind of KINDS) {
        const list = Array.isArray(push[kind + "s"]) ? push[kind + "s"] : [];
        if (list.length > MAX_PUSH) throw new Error(`Too many ${kind}s in one push (max ${MAX_PUSH})`);
        for (const rec of list) {
          const r = applyRecord(userId, kind, rec);
          counts[r.status]++;
          if (r.status === "invalid") problems.push({ kind, id: rec?.id, reason: r.reason });
        }
      }

      // Profile: singleton, same last-write-wins rule.
      if (push.profile && typeof push.profile === "object") {
        const at = isoOrNull(push.profile.updated_at);
        if (at) {
          const cur = q.profile.get(userId);
          if (!cur || at > cur.updated_at) {
            const body = Object.assign({}, push.profile);
            delete body.updated_at;
            q.setProf.run(userId, JSON.stringify(body), at, nextSeq(userId));
            counts.applied++;
          } else counts.stale++;
        } else counts.invalid++;
      }
    })();
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Everything the device hasn't seen — including records it just lost a
  // conflict on, which is what makes a stale device self-correct.
  const rows = q.since.all(userId, since);
  const pull = { clients: [], events: [] };
  for (const r of rows) {
    if (r.kind === "client") pull.clients.push(hydrate(r));
    else if (r.kind === "event") pull.events.push(hydrate(r));
  }

  const prof = q.profile.get(userId);
  if (prof && prof.server_seq > since) {
    pull.profile = Object.assign(JSON.parse(prof.data), { updated_at: prof.updated_at });
  }

  res.json({
    cursor: currentSeq(userId),
    pull,
    applied: counts.applied,
    stale: counts.stale,
    invalid: counts.invalid,
    problems: problems.slice(0, 20)
  });
}

/** Full snapshot — used by a device signing in fresh, and by export. */
function handleSnapshot(req, res) {
  const userId = req.user.id;
  const rows = q.allRecs.all(userId);
  const out = { clients: [], events: [] };
  for (const r of rows) {
    if (r.kind === "client") out.clients.push(hydrate(r));
    else if (r.kind === "event") out.events.push(hydrate(r));
  }
  const prof = q.profile.get(userId);
  out.profile = prof ? Object.assign(JSON.parse(prof.data), { updated_at: prof.updated_at }) : {};
  out.cursor = currentSeq(userId);
  res.json(out);
}

module.exports = { handleSync, handleSnapshot, applyRecord, hydrate, q };
