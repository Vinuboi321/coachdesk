<!-- Replace YOUR-USERNAME throughout, and the demo link below, once deployed. -->

# CoachDesk

**Say it, don't type it.** A coach speaks a sentence — *"I have a client Jacob Smith for tennis, he's 19, his number is 469-312-4412"* — and it becomes a client record, a calendar entry, or a session note. Works offline, syncs across devices, and never writes anything without showing you first.

[![CI](https://github.com/YOUR-USERNAME/coachdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR-USERNAME/coachdesk/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-104%20passing-3D5A4C)
![Node](https://img.shields.io/badge/node-22%2B-3D5A4C)
![Dependencies](https://img.shields.io/badge/frontend%20dependencies-0-3D5A4C)

### ▶ [Live demo](https://coachdesk.onrender.com) — click "Try the demo", no signup

<!-- TODO: record a 20-second GIF of speaking a client into existence, then
     scheduling a lesson, and drop it at docs/demo.gif -->
![CoachDesk demo](docs/demo.gif)

---

## The interesting part isn't the voice

Speech recognition is twenty lines of Web Speech API. The parts worth reading are underneath.

### Multi-device sync that survives a wrong clock

Two devices, both editing offline, both reconnecting. The usual answer is last-write-wins on timestamps — which breaks the moment a phone's clock is five minutes fast, because a timestamp cursor will skip records permanently and silently.

So the sync cursor is a **server-issued monotonic sequence number**, not a time. Devices send the last sequence they saw; the server returns everything since. Clock skew can't cause data loss because clocks aren't load-bearing.

Conflicts between two edits of the same record still resolve by last-write-wins on the device's logical timestamp — a much smaller blast radius. And when a device loses that race, the winning version comes back **in the same response**, so it self-corrects immediately instead of sitting on a stale value until next sync.

Deletes are tombstones, never hard deletes. A device offline during a deletion would otherwise re-upload the record and resurrect it. There's a test for exactly that.

### A parser that doesn't care about word order

People don't speak in field order. Rather than matching sentence shapes, it extracts entities from wherever they land — email, then phone, then age, then activity — removes each one, and reads the name from what's left. All three of these produce the same record:

```
I have a client Jacob Smith for tennis, and he is 19 and his phone number is 469-312-4412
new client Jacob Smith, 19, tennis, 4693124412
set up a client for me — his name is Jacob Smith, tennis, he's 19
```

It handles `"half past four"`, `"3 in the afternoon"`, `"quarter past nine"`, `"for an hour and a half"`, and reads a bare `"at 4"` as 4pm because coaching happens in daylight. Where it has to guess, it says so on the confirmation card rather than guessing quietly.

An age under 18 automatically opens the guardian and consent fields.

### Nothing is written without confirmation

Every command lands on an editable card first. Speech mangles names constantly, and the failure mode without this step is silently cancelling a real client's lesson. It costs two seconds and removes a whole category of invisible corruption.

Ambiguity is surfaced rather than resolved: say "Daniel" when you have a Daniel Ortiz and a Danielle Ross, and you get a picker.

### AI is a fallback, not the front door

The rules run first — instant, free, offline. Only when they return `unknown` does the app call the server, and only if an `ANTHROPIC_API_KEY` is configured. A typical session costs nothing. The model returns structured intent only; it never writes to the database, its output is range-checked and whitelisted before it touches the app's data shapes, and it lands on the same confirmation card labelled as AI-interpreted.

---

## Running it

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

Open <http://localhost:3000>. Requires **Node 22.5+**, which has SQLite built in — nothing to compile. On older Node it falls back to the optional `better-sqlite3` driver.

```bash
npm test              # 104 checks
npm run test:parser   #  36 — phrasings, dates, times, ambiguity
npm run test:sync     #  68 — auth, sync conflicts, deletes, throttling
```

Use Chrome, Edge or Safari for voice. Typing works everywhere and is a first-class path, not a fallback — gyms and pool decks defeat speech recognition routinely.

---

## Architecture

```
server/
  index.js    Express app, routes, rate limiting, static hosting
  db.js       schema, migrations, per-user sync sequence
  sqlite.js   picks node:sqlite or better-sqlite3
  auth.js     sessions, password reset, verified email change
  sync.js     delta sync between devices
  google.js   Google Calendar two-way sync
  parse.js    optional AI parsing fallback
  demo.js     seeded public demo workspace
  mailer.js   SMTP with a console fallback
public/
  index.html  markup and the full design system
  app.js      local store, sync client, voice, parser, views
test/
  parser.test.js   runs against the shipped bundle, not a copy
  sync.test.js     drives the real server over HTTP as two devices
```

**Frontend dependencies: zero.** No framework, no build step, no bundler. Roughly 1,600 lines of vanilla JS and a design system built on CSS custom properties.

**Storage** is JSON blobs per record rather than wide columns, because coaches in different disciplines need different fields on a client — level, event, parent contact, injury history. Every read is "give me this coach's records since cursor N", never a content search, so nothing is lost by not being able to query inside a record.

---

## Security

- **bcrypt** password hashing, cost 12
- **Server-side sessions** in httpOnly + sameSite cookies, so page JavaScript can never read a token
- **Reset tokens stored hashed** — a leaked database can't be used to mint working reset links. Single use, one hour, one live link per account
- **No account enumeration** — `/forgot` answers identically whether or not the email exists, and login timing is equalised
- **A successful reset revokes every session**, including an attacker's
- **Email changes need the current password**, must be confirmed from the new address, and notify the old one
- **Rate limiting** keyed per IP *and route* *and* identity

That last one came from a bug: the limiter originally keyed on IP alone for bodies without an `email` field, so finishing a password reset consumed the budget for changing an email, and everyone behind one office NAT shared a single allowance. Found by a test that failed for the wrong reason. There's now a regression test.

---

## Deploying

### Free — Render

Push to GitHub, then [render.com](https://render.com) → New → Blueprint → point at the repo. `render.yaml` configures everything and `SESSION_SECRET` is generated for you.

Two honest limitations of the free tier:

- **No persistent disk.** The database resets on restart or redeploy. `EPHEMERAL_STORAGE=true` makes the app say so in the UI rather than quietly losing someone's work. The demo account is rebuilt from seed on every boot, so the demo is always populated.
- **Sleeps after ~15 minutes idle**, so the first visitor waits about 50 seconds. A free ping from [cron-job.org](https://cron-job.org) hitting `/api/health` every 10 minutes keeps it warm — one always-on service fits inside the 750 free instance-hours per month.

### ~$2–3/month — Fly.io

`fly.toml` mounts a real volume, so data survives restarts and cold starts take a second or two instead of fifty.

```bash
fly launch --no-deploy --name coachdesk-yourname
fly volumes create data --size 1 --region iad
fly secrets set SESSION_SECRET=$(openssl rand -hex 32) PUBLIC_DEMO=true
fly deploy
```

In production, set `NODE_ENV=production` so session cookies get the `Secure` flag, configure `SMTP_*` so reset links stop printing to the console, and set `APP_URL` to your real domain.

---

## Optional integrations

Everything below is off by default and the app runs fine without it. Each degrades with a clear explanation rather than an error.

| Feature | Enable with | Without it |
|---|---|---|
| Google Calendar two-way sync | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Panel explains the setup steps |
| Password reset emails | `SMTP_HOST` and credentials | Links print to the server console |
| AI parsing fallback | `ANTHROPIC_API_KEY` | Rules only; unmatched input shows examples |
| Public demo account | `PUBLIC_DEMO=true` | Signup only |

**Google Calendar conflict rule: CoachDesk wins.** The local version overwrites Google unconditionally. Events created *in* Google are imported and left alone. Predictable beats clever here — though it does mean an edit made in Google to a CoachDesk event gets overwritten on the next sync.

**Client names are not written into Google event titles** (`TITLE_INCLUDES_CLIENT` in `server/google.js`). Coaches share calendars, and leaking a client list into a shared calendar is a real harm.

---

## Clients under 18

Data-protection duties attach to the person a record is *about*, not the coach holding it. Marking a client under 18 requires a guardian name and contact, and records whether consent was obtained, when, and how. Missing consent shows as a banner on the client list and a flag on the record. Every client sheet exports everything held about that one person, for when a guardian asks for a copy.

It nags rather than blocks — blocking would push people to record minors as adults.

> This is a prompt and a record, not a compliance system, and not legal advice.

---

## Known gaps

Written down rather than hidden, because pretending they don't exist is worse:

- **Consent capture has no retention schedule**, no automatic deletion, no withdrawal flow, and no audit trail of who viewed a record.
- **Sync is polled** — every 60 seconds, on focus, and after edits. Fine for one coach on two devices; real-time would need WebSockets.
- **Google sync runs only when you press the button.** No background job, no webhook. The UI says so rather than implying it's live.
- **Recurring lessons aren't supported.** "Every Tuesday at 4" is detected and creates a single event with a warning, rather than silently booking one week and losing the rest.
- **Names are guessed from position**, so unusual ones can land wrong. The confirmation card is the safety net.
- **`"next Tuesday"` is ambiguous in English** and resolves to the Tuesday *after* the coming one. The card flags it and shows the resolved date.
- **Rate limiting is in-memory**, so it resets on restart and doesn't work across processes.
- **No password reset without email access**, and no account recovery beyond that.
- **SQLite is single-process.** Fine as deployed; more than one instance means moving to Postgres. The storage layer is small and isolated in `server/db.js`.

---

## Licence

MIT
