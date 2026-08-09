"use strict";
/* ============================================================
   Google Calendar — two-way sync, CoachDesk wins on conflict.

   How it works
   ------------
   PUSH: every local event carries googleEventId once it exists remotely.
         New locally  -> insert into Google.
         Changed locally -> patch Google (we overwrite, unconditionally —
                            that is what "CoachDesk wins" means).
         Deleted locally -> delete from Google.

   PULL: incremental via Google's syncToken. Events that originated in
         Google and have no local counterpart are imported. Events that
         DO have a local counterpart are ignored on pull — the local copy
         is authoritative and the next push will overwrite Google again.

   Privacy: client names are not written into Google event titles by
   default. Coaches routinely share their calendars, and leaking a client
   list into a shared calendar is a real harm. See TITLE_INCLUDES_CLIENT.
   ============================================================ */

const crypto = require("crypto");
const { google } = require("googleapis");
const { db, nextSeq } = require("./db");

const TITLE_INCLUDES_CLIENT = false;

const q = {
  acct:     db.prepare("SELECT * FROM google_accounts WHERE user_id=?"),
  saveAcct: db.prepare(`INSERT INTO google_accounts (user_id,email,refresh_token,calendar_id,sync_token,last_sync_at,connected_at)
                        VALUES (@user_id,@email,@refresh_token,@calendar_id,NULL,NULL,@connected_at)
                        ON CONFLICT(user_id) DO UPDATE SET
                          email=@email, refresh_token=@refresh_token, connected_at=@connected_at`),
  setToken: db.prepare("UPDATE google_accounts SET sync_token=?, last_sync_at=? WHERE user_id=?"),
  disconnect: db.prepare("DELETE FROM google_accounts WHERE user_id=?"),
  events:   db.prepare("SELECT * FROM records WHERE user_id=? AND kind='event'"),
  getRec:   db.prepare("SELECT * FROM records WHERE user_id=? AND kind='event' AND id=?"),
  upsert:   db.prepare(`INSERT INTO records (user_id,kind,id,data,updated_at,deleted,server_seq)
                        VALUES (@user_id,'event',@id,@data,@updated_at,@deleted,@server_seq)
                        ON CONFLICT(user_id,kind,id) DO UPDATE SET
                          data=@data, updated_at=@updated_at, deleted=@deleted, server_seq=@server_seq`),
  clients:  db.prepare("SELECT id,data FROM records WHERE user_id=? AND kind='client' AND deleted=0")
};

const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const uid = () => crypto.randomBytes(9).toString("hex");
const nowIso = () => new Date().toISOString();

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/api/google/callback"
  );
}

function clientFor(userId) {
  const acct = q.acct.get(userId);
  if (!acct) return null;
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: acct.refresh_token });
  return { auth, acct, cal: google.calendar({ version: "v3", auth }) };
}

/* --- OAuth ----------------------------------------------------------- */
// Short-lived CSRF states. In-memory is fine: a dropped state just means
// the coach clicks Connect again.
const states = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60e3;
  for (const [k, v] of states) if (v.at < cutoff) states.delete(k);
}, 60e3).unref?.();

function connect(req, res) {
  if (!configured()) {
    return res.status(503).json({ error: "not_configured",
      message: "Google credentials aren't set on the server. See .env.example for the setup steps." });
  }
  const state = crypto.randomBytes(16).toString("hex");
  states.set(state, { userId: req.user.id, at: Date.now() });
  const url = oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",            // force a refresh_token even on reconnect
    scope: ["https://www.googleapis.com/auth/calendar.events", "openid", "email"],
    state
  });
  res.json({ url });
}

async function callback(req, res) {
  const { code, state, error } = req.query;
  const send = msg => res.type("html").send(
    `<!doctype html><meta charset="utf-8"><title>CoachDesk</title>
     <body style="font:15px system-ui;padding:40px;max-width:520px;margin:auto;color:#1C1D1A;background:#F7F6F3">
     <p>${msg}</p><p><a href="/">Back to CoachDesk</a></p>
     <script>try{window.opener&&window.opener.postMessage({coachdesk:"google-done"},"*");setTimeout(()=>window.close(),1200)}catch(e){}</script>`);

  if (error) return send("Google connection was cancelled.");
  const s = states.get(String(state));
  states.delete(String(state));
  if (!s) return send("That connection link expired. Please try connecting again.");

  try {
    const auth = oauthClient();
    const { tokens } = await auth.getToken(String(code));
    if (!tokens.refresh_token) {
      return send("Google didn't return a refresh token. Remove CoachDesk at myaccount.google.com/permissions, then connect again.");
    }
    auth.setCredentials(tokens);
    let email = null;
    try {
      const info = await google.oauth2({ version: "v2", auth }).userinfo.get();
      email = info.data.email || null;
    } catch (_) { /* email is cosmetic */ }

    q.saveAcct.run({ user_id: s.userId, email, refresh_token: tokens.refresh_token,
      calendar_id: "primary", connected_at: nowIso() });
    send("Google Calendar connected. You can close this tab.");
  } catch (e) {
    console.error("google callback", e.message);
    send("Couldn't complete the Google connection: " + e.message);
  }
}

function status(req, res) {
  const acct = q.acct.get(req.user.id);
  res.json({
    configured: configured(),
    connected: !!acct,
    email: acct?.email || null,
    lastSyncAt: acct?.last_sync_at || null
  });
}

function disconnect(req, res) {
  q.disconnect.run(req.user.id);
  res.json({ ok: true });
}

/* --- mapping --------------------------------------------------------- */
function toGoogle(ev, clientName) {
  const start = new Date(ev.start);
  const end = new Date(start.getTime() + (ev.durationMin || 60) * 60000);
  const summary = TITLE_INCLUDES_CLIENT && clientName ? `${ev.title} — ${clientName}` : (ev.title || "Session");
  return {
    summary,
    location: ev.location || undefined,
    description: ev.notes || undefined,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    extendedProperties: { private: { coachdeskId: ev.id } }
  };
}

function fromGoogle(g) {
  const startStr = g.start?.dateTime || (g.start?.date ? g.start.date + "T09:00:00" : null);
  if (!startStr) return null;
  const start = new Date(startStr);
  const endStr = g.end?.dateTime || (g.end?.date ? g.end.date + "T10:00:00" : null);
  const end = endStr ? new Date(endStr) : new Date(start.getTime() + 3600e3);
  return {
    title: g.summary || "Busy",
    start: start.toISOString(),
    durationMin: Math.max(5, Math.round((end - start) / 60000)),
    location: g.location || "",
    notes: g.description || "",
    clientId: null,
    source: "google",
    googleEventId: g.id
  };
}

const readRec = r => Object.assign(JSON.parse(r.data), { id: r.id, updated_at: r.updated_at, deleted: !!r.deleted });

function writeRec(userId, ev, deleted) {
  const body = Object.assign({}, ev);
  delete body.updated_at; delete body.deleted;
  q.upsert.run({
    user_id: userId, id: ev.id, data: JSON.stringify(body),
    updated_at: ev.updated_at || nowIso(),
    deleted: deleted ? 1 : 0, server_seq: nextSeq(userId)
  });
}

/* --- the sync run ---------------------------------------------------- */
async function runSync(req, res) {
  const userId = req.user.id;
  if (!configured()) return res.status(503).json({ error: "not_configured", message: "Google credentials aren't set on the server." });
  const ctx = clientFor(userId);
  if (!ctx) return res.status(400).json({ error: "not_connected", message: "Connect a Google account first." });
  const { cal, acct } = ctx;

  const names = new Map(q.clients.all(userId).map(r => [r.id, (JSON.parse(r.data).name || "")]));
  const local = q.events.all(userId).map(readRec);
  const stats = { pushed: 0, updated: 0, deletedRemote: 0, imported: 0, errors: [] };

  /* ---- PUSH ---- */
  for (const ev of local) {
    try {
      if (ev.deleted) {
        if (ev.googleEventId) {
          await cal.events.delete({ calendarId: acct.calendar_id, eventId: ev.googleEventId })
            .catch(e => { if (![404, 410].includes(e.code)) throw e; });
          stats.deletedRemote++;
          const rec = q.getRec.get(userId, ev.id);
          if (rec) {
            const body = readRec(rec); delete body.googleEventId;
            db.transaction(() => writeRec(userId, body, true))();
          }
        }
        continue;
      }
      const payload = toGoogle(ev, names.get(ev.clientId));
      if (ev.googleEventId) {
        // CoachDesk wins: overwrite whatever is in Google, no comparison.
        await cal.events.update({ calendarId: acct.calendar_id, eventId: ev.googleEventId, requestBody: payload })
          .catch(async e => {
            if ([404, 410].includes(e.code)) {          // vanished remotely — recreate
              const created = await cal.events.insert({ calendarId: acct.calendar_id, requestBody: payload });
              ev.googleEventId = created.data.id;
              db.transaction(() => writeRec(userId, ev, false))();
            } else throw e;
          });
        stats.updated++;
      } else if (ev.source !== "google") {
        const created = await cal.events.insert({ calendarId: acct.calendar_id, requestBody: payload });
        ev.googleEventId = created.data.id;
        db.transaction(() => writeRec(userId, ev, false))();
        stats.pushed++;
      }
    } catch (e) {
      stats.errors.push(`${ev.title || ev.id}: ${e.message}`);
      if (stats.errors.length > 10) break;
    }
  }

  /* ---- PULL ---- */
  const known = new Set(q.events.all(userId).map(r => readRec(r).googleEventId).filter(Boolean));
  let pageToken, syncToken = acct.sync_token, newSyncToken = null;
  try {
    do {
      const params = { calendarId: acct.calendar_id, singleEvents: true, maxResults: 250, pageToken };
      if (syncToken) params.syncToken = syncToken;
      else { params.timeMin = new Date(Date.now() - 30 * 864e5).toISOString(); params.showDeleted = false; }

      let resp;
      try {
        resp = await cal.events.list(params);
      } catch (e) {
        // 410 = syncToken expired. Google's prescribed recovery is a full resync.
        if (e.code === 410 && syncToken) { syncToken = null; pageToken = undefined; continue; }
        throw e;
      }

      for (const g of resp.data.items || []) {
        const cdId = g.extendedProperties?.private?.coachdeskId;
        if (cdId || known.has(g.id)) continue;         // ours — local copy stays authoritative
        if (g.status === "cancelled") continue;
        const mapped = fromGoogle(g);
        if (!mapped) continue;
        mapped.id = uid();
        mapped.updated_at = nowIso();
        db.transaction(() => writeRec(userId, mapped, false))();
        known.add(g.id);
        stats.imported++;
      }
      pageToken = resp.data.nextPageToken;
      if (resp.data.nextSyncToken) newSyncToken = resp.data.nextSyncToken;
    } while (pageToken);

    q.setToken.run(newSyncToken || acct.sync_token, nowIso(), userId);
  } catch (e) {
    stats.errors.push("pull: " + e.message);
  }

  res.json(Object.assign({ ok: stats.errors.length === 0, at: nowIso() }, stats));
}

module.exports = { connect, callback, status, disconnect, runSync, configured };
