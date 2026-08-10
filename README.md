<!-- TODO: record docs/demo.gif -->

# CoachDesk

Voice-driven client and scheduling manager for coaches. Speak a sentence, confirm what it parsed, and it becomes a client record, a calendar entry, or a session note.

[![CI](https://github.com/Vinuboi321/coachdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/Vinuboi321/coachdesk/actions/workflows/ci.yml)
[![Pages](https://github.com/Vinuboi321/coachdesk/actions/workflows/pages.yml/badge.svg)](https://github.com/Vinuboi321/coachdesk/actions/workflows/pages.yml)
![Tests](https://img.shields.io/badge/tests-129%20passing-3D5A4C)
![Node](https://img.shields.io/badge/node-22%2B-3D5A4C)
![Dependencies](https://img.shields.io/badge/frontend%20dependencies-0-3D5A4C)

**[Live demo](https://vinuboi321.github.io/coachdesk/)** — no signup, loads with sample data

![CoachDesk demo](docs/demo.gif)

---

## Features

- **Clients** — contact details, arbitrary custom fields, tagged notes, session history
- **Calendar** — month and agenda views, optional two-way Google Calendar sync
- **Profile** — experience, certifications and testimonials, exported as a printable résumé or client-facing flier
- **Voice input** — natural speech on any screen, with a typed fallback
- **Offline-first** — full functionality with no connection; syncs on reconnect
- **Multi-device** — same account on phone and laptop, conflicts resolved deterministically
- **Consent tracking** — guardian details and consent records for clients under 18

---

## How it works

### Voice parsing

- Web Speech API for transcription
- Entity-extraction parser: pulls phone, email, age and activity from anywhere in the sentence, then resolves the name from the remainder
- Word order is irrelevant. These are equivalent:
  ```
  new client Anna Foster, she does swimming, she's 24, 555-010-1234
  I've got a new student Anna Foster for swimming, 24, 555-010-1234
  ```
- Handles relative dates (`tomorrow`, `next Tuesday`), spoken times (`half past four`, `3 in the afternoon`), and durations (`for an hour and a half`)
- Every command routes through an editable confirmation card. Nothing writes to storage unconfirmed
- Ambiguous client names return a picker rather than a guess
- Optional Claude fallback for phrasings the rules miss, called only when the rules return `unknown`

### Sync

- Local-first: writes hit `localStorage` immediately, sync runs in the background
- Cursor is a **server-issued sequence number**, not a timestamp — device clock drift cannot cause skipped records
- Per-record conflicts resolve last-write-wins on the device's logical timestamp
- The losing device receives the winning version in the same response and self-corrects
- Deletes are tombstones, so an offline device cannot resurrect a deleted record
- Polls every 60s, on window focus, and after edits

### Auth and security

- bcrypt password hashing, cost 12
- Server-side sessions in httpOnly + sameSite cookies
- Password reset tokens stored SHA-256 hashed, single use, 1 hour expiry, one live token per account
- `/forgot` responses and login timing are identical whether or not an account exists
- Successful reset revokes all sessions
- Email changes require the current password, confirmation from the new address, and notify the old one
- Rate limiting keyed per IP + route + identity

### Storage

- SQLite via Node's built-in `node:sqlite` (no native compilation), falling back to `better-sqlite3`
- Records stored as JSON blobs — coaches in different disciplines need different fields, and every read is "records since cursor N" rather than a content search

---

## Stack

| Layer | Choice |
|---|---|
| Backend | Node 22, Express |
| Database | SQLite (`node:sqlite`) |
| Frontend | Vanilla JS, ~1,600 lines, zero dependencies, no build step |
| Styling | CSS custom properties, light and dark |
| Tests | 129, no framework |
| CI/CD | GitHub Actions → Pages |

---

## Setup

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

Open <http://localhost:3000>. Requires Node 22.5+.

```bash
npm test               # 129 checks
npm run test:parser    #  36 — phrasings, dates, times, ambiguity
npm run test:sync      #  68 — auth, sync conflicts, deletes, throttling
npm run test:static    #  25 — the deployed browser build, in a real DOM
npm run build:static   # browser-only bundle → dist/
```

Voice requires Chrome, Edge or Safari. Typing works everywhere.

---

## Structure

```
server/
  index.js    routes, rate limiting, static hosting
  db.js       schema, migrations, sync sequence
  sqlite.js   driver selection
  auth.js     sessions, password reset, email change
  sync.js     delta sync
  google.js   Google Calendar two-way sync
  parse.js    optional AI parsing fallback
  demo.js     seeded demo workspace
  mailer.js   SMTP, console fallback
public/
  index.html  markup and design system
  app.js      store, sync client, voice, parser, views
  seed.js     demo data, shared with the server
scripts/
  build-static.js   browser-only build for Pages
test/
  parser.test.js    runs against the shipped bundle
  sync.test.js      drives the real server as two devices
  static.test.js    loads the deployed build in a real DOM
```

---

## Configuration

All optional. Each feature degrades with an explanation rather than an error.

| Feature | Environment variable | Default behaviour |
|---|---|---|
| Google Calendar sync | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Panel explains setup |
| Password reset email | `SMTP_HOST` + credentials | Links print to console |
| AI parsing fallback | `ANTHROPIC_API_KEY` | Rules only |
| Public demo account | `PUBLIC_DEMO=true` | Signup only |
| Ephemeral hosting notice | `EPHEMERAL_STORAGE=true` | No banner |

Google Calendar conflicts resolve in CoachDesk's favour; events created in Google are imported unchanged. Client names are excluded from Google event titles to avoid leaking a client list into a shared calendar.

---

## Deployment

**GitHub Pages** (live demo above) — `scripts/build-static.js` copies `public/` to `dist/` and sets `window.COACHDESK_STATIC`, which short-circuits the auth and sync layer. Same frontend code, no server. Deploys on every push to `main`.

**Render** — `render.yaml` provisions a free web service. No card required. Free instances have no persistent disk and sleep after 15 minutes idle.

**Fly.io** — `fly.toml` mounts a persistent volume. Roughly $2–3/month.

Production: set `NODE_ENV=production`, configure `SMTP_*`, and set `APP_URL` to the deployed domain.

---

## Limitations

- Sync is polled, not pushed. Real-time would require WebSockets
- Google sync is manual, triggered by a button. No background job or webhook
- Recurring lessons are detected but not supported; a single event is created with a warning
- Consent tracking is a prompt and a record, not a compliance system. No retention schedule, withdrawal flow, or audit log
- Rate limiting is in-memory; resets on restart, not shared across processes
- Account recovery depends entirely on email access
- SQLite is single-process. Multiple instances would require Postgres; the storage layer is isolated in `server/db.js`

---

MIT
