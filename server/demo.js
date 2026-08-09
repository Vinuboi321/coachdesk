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

/** Days from today at a given hour, as an ISO string. */
function at(dayOffset, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function buildSeed() {
  const c = {
    maya:   uid(), jacob: uid(), daniel: uid(),
    amara:  uid(), leo:   uid(), priya:  uid()
  };

  const clients = [
    { id: c.maya, name: "Maya Chen", phone: "555-0142", email: "maya.chen@example.com",
      tags: ["tennis", "competitive"], isMinor: false, guardian: null, consent: null,
      fields: { Level: "Advanced", Goal: "Consistent backhand under pressure", Handedness: "Right" },
      notes: [
        { id: uid(), at: at(-2, 17), text: "Backhand slice much steadier. Still dropping the shoulder on high balls — drilled it for 20 minutes." },
        { id: uid(), at: at(-9, 17), text: "First session back after the wrist strain. Kept it light, no overheads." }
      ], created: at(-120, 9) },

    { id: c.jacob, name: "Jacob Smith", phone: "469-312-4412", email: "",
      tags: ["tennis", "intermediate"], isMinor: false, guardian: null, consent: null,
      fields: { Age: "19", Level: "Intermediate", Goal: "Break into college club team" },
      notes: [{ id: uid(), at: at(-4, 16), text: "Serve toss is inconsistent when he's tired. Worth filming next week." }],
      created: at(-31, 9) },

    // Consent recorded — shows the good path.
    { id: c.leo, name: "Leo Park", phone: "555-0188", email: "",
      tags: ["swimming", "junior"], isMinor: true,
      guardian: { name: "Hana Park", contact: "555-0177" },
      consent: { obtained: true, at: at(-60, 10), method: "Signed form" },
      fields: { Age: "16", Event: "200m freestyle", "Best time": "2:04.8" },
      notes: [{ id: uid(), at: at(-3, 7), text: "Turns are costing him nearly a second each. Wall work every session until it sticks." }],
      created: at(-64, 9) },

    // Consent NOT recorded — this is what the warning banner is for.
    { id: c.amara, name: "Amara Okafor", phone: "555-0165", email: "",
      tags: ["athletics", "junior"], isMinor: true,
      guardian: { name: "Chidi Okafor", contact: "chidi.okafor@example.com" },
      consent: { obtained: false },
      fields: { Age: "15", Event: "400m" },
      notes: [], created: at(-8, 9) },

    { id: c.daniel, name: "Daniel Ortiz", phone: "", email: "d.ortiz@example.com",
      tags: ["executive", "leadership"], isMinor: false, guardian: null, consent: null,
      fields: { Focus: "Communicating under pressure", Company: "Northwind Logistics" },
      notes: [{ id: uid(), at: at(-6, 11), text: "Wants to work on running a room when he's the least senior person in it." }],
      created: at(-45, 9) },

    { id: c.priya, name: "Priya Nair", phone: "555-0101", email: "",
      tags: ["swimming", "beginner"], isMinor: false, guardian: null, consent: null,
      fields: { Goal: "Comfortable in deep water by spring" },
      notes: [], created: at(-12, 9) }
  ];

  const events = [
    { id: uid(), title: "Lesson",  clientId: c.maya,   start: at(0, 16),  durationMin: 60, location: "Court 3",  notes: "" },
    { id: uid(), title: "Lesson",  clientId: c.jacob,  start: at(0, 17, 30), durationMin: 60, location: "Court 1", notes: "" },
    { id: uid(), title: "Session", clientId: c.daniel, start: at(1, 10),  durationMin: 45, location: "Zoom",     notes: "Prep for the board update" },
    { id: uid(), title: "Lesson",  clientId: c.leo,    start: at(1, 7),   durationMin: 90, location: "Lane 4",   notes: "" },
    { id: uid(), title: "Lesson",  clientId: c.priya,  start: at(2, 18),  durationMin: 30, location: "Pool",     notes: "" },
    { id: uid(), title: "Practice",clientId: c.amara,  start: at(3, 16),  durationMin: 60, location: "Track",    notes: "" },
    { id: uid(), title: "Lesson",  clientId: c.maya,   start: at(4, 16),  durationMin: 60, location: "Court 3",  notes: "" },
    { id: uid(), title: "Lesson",  clientId: c.jacob,  start: at(7, 17, 30), durationMin: 60, location: "Court 1", notes: "" },
    // A little history so the calendar isn't only forward-looking.
    { id: uid(), title: "Lesson",  clientId: c.maya,   start: at(-2, 16), durationMin: 60, location: "Court 3",  notes: "" },
    { id: uid(), title: "Lesson",  clientId: c.leo,    start: at(-3, 7),  durationMin: 90, location: "Lane 4",   notes: "" },
    { id: uid(), title: "Session", clientId: c.daniel, start: at(-6, 11), durationMin: 45, location: "Zoom",     notes: "" }
  ].map(e => Object.assign(e, { source: "local" }));

  const profile = {
    name: "Alex Rivera", title: "Tennis & Performance Coach",
    email: "alex@example.com", phone: "555-0100",
    location: "Austin, TX", website: "alexrivera.example.com",
    bio: "Fifteen years coaching juniors and adults, from first-serve nerves to regional finals. I coach the player, not just the stroke — most of my work is about making good habits survive pressure.",
    tagline: "Private Tennis Coaching",
    offer: "First session free",
    specialties: ["Junior development", "Serve mechanics", "Match strategy", "Return to play after injury"],
    experience: [
      { id: uid(), role: "Head Coach", org: "Riverside Tennis Club", period: "2019–present",
        detail: "Run the junior programme — 40 players across four squads. Six progressed to state level in the last three years." },
      { id: uid(), role: "Assistant Coach", org: "Lakeside Academy", period: "2014–2019",
        detail: "Adult clinics and one-to-one coaching." }
    ],
    certifications: [
      { id: uid(), name: "USPTA Elite Professional", issuer: "USPTA", year: "2018" },
      { id: uid(), name: "Level 2 Strength & Conditioning", issuer: "NSCA", year: "2021" },
      { id: uid(), name: "Safeguarding in Youth Sport", issuer: "SafeSport", year: "2024" }
    ],
    testimonials: [
      { id: uid(), quote: "My daughter went from dreading matches to asking for extra sessions. Alex reads people as well as he reads a serve.", author: "Parent, junior squad" },
      { id: uid(), quote: "Practical, patient, and honest about what needs work. Worth every session.", author: "Daniel O., adult programme" }
    ]
  };

  return { clients, events, profile };
}

/** Wipe and repopulate the demo workspace. */
function resetDemoData(userId) {
  const { clients, events, profile } = buildSeed();
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
