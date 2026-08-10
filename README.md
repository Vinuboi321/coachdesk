<!-- TODO once deployed: update the demo link, and add docs/demo.gif -->

# CoachDesk

Coaches spend their day on a court or a pool deck, not sat at a laptop. So this one listens instead. You say what happened, it files it: a new client, a lesson on Tuesday, a note about someone's turns.

[![CI](https://github.com/Vinuboi321/coachdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/Vinuboi321/coachdesk/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-104%20passing-3D5A4C)
![Node](https://img.shields.io/badge/node-22%2B-3D5A4C)
![Dependencies](https://img.shields.io/badge/frontend%20dependencies-0-3D5A4C)

### ▶ [Try it live](https://coachdesk.onrender.com) — there's a demo button, no signup

![CoachDesk demo](docs/demo.gif)

---

## The voice bit isn't the interesting bit

That's the part people ask about, and it's about twenty lines of Web Speech API. The browser does the work. Everything underneath was harder, and that's what I'd actually want to talk about.

### Two devices, one truth

Picture a coach with a phone at the pool and a laptop at home. Both edited something while offline. Both come back online. Who wins?

The obvious answer is to compare timestamps and keep the newer one. I built that first, then realised it quietly breaks: phone clocks drift, and a device running five minutes fast will poison a timestamp cursor and skip records permanently. Nobody would ever notice until data went missing.

So the sync cursor isn't a time at all. The server hands out sequence numbers, each device remembers the last one it saw, and asks for everything since. Clocks stop being load-bearing, so clock skew stops being able to lose your work.

Conflicts between two edits of the same record still fall back to last-write-wins on the device's own clock, but that's a much smaller thing to get wrong. And when a device loses that race it gets the winning version back in the same response, so it corrects itself on the spot rather than sitting on something stale until the next sync.

Deletes leave tombstones. I learned that one the hard way in testing: delete a lesson on your phone while the laptop is offline, and the laptop cheerfully re-uploads it on reconnect. There's a test for that specific resurrection now.

### It doesn't care how you say it

Nobody speaks in form fields. My first parser expected `Add client <name>, <phone>, <sport>` and it was useless the moment I tried talking to it like a person.

The rewrite works backwards instead. It hunts down the things it can recognise on their own — an email, a phone number, an age, a sport — pulls each one out, and whatever survives that is the name. Word order stops mattering:

```
new client Priya Nair, she does swimming, she's 24, 555-010-1234
I've got a new student called Sam Rivera for tennis, 19, 555-014-2200
take on Nadia Haddad, 555-018-8100, advanced golf
```

It copes with "half past four", "3 in the afternoon", "quarter past nine", "for an hour and a half". A bare "at 4" becomes 4pm, because nobody books a lesson at four in the morning. When it does have to guess it says so on the card instead of guessing behind your back.

If someone's under 18 it opens the guardian and consent fields on its own.

### Nothing gets saved without you seeing it

Every command stops at an editable card first. This isn't caution for its own sake. Speech recognition mangles names constantly, and without that step a misheard word can silently cancel a real client's real lesson. Two seconds of friction buys you a whole category of bugs that never happen.

Same idea with ambiguity. Say "Daniel" when you've got a Daniel Ortiz and a Danielle Ross on the books, and you get a picker rather than a coin flip.

### AI is the backstop, not the engine

There's an optional Claude fallback, but the rules go first. They're instant, free, and work with no signal, which matters when the nearest wifi is in the clubhouse. Only when the rules genuinely can't work something out does it call the API, and only if a key is configured — so most sessions cost nothing at all.

The model only ever returns structured intent. It can't write to the database. Everything it produces gets range-checked and whitelisted before it touches real data, then lands on the same confirmation card as everything else, labelled so you know where it came from.

---

## Running it

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start
```

Then open <http://localhost:3000>.

You'll want Node 22.5 or newer, which ships with SQLite built in so there's nothing to compile. Older versions fall back to the `better-sqlite3` native driver, which does need build tools.

```bash
npm test              # 104 checks
npm run test:parser   #  36 — phrasings, dates, times, ambiguity
npm run test:sync     #  68 — auth, sync conflicts, deletes, throttling
```

Voice needs Chrome, Edge or Safari. Typing works everywhere, and it's a proper first-class path rather than a consolation prize — gyms and pool decks defeat speech recognition all the time.

---

## How it's laid out

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
  mailer.js   SMTP, falling back to the console
public/
  index.html  markup and the whole design system
  app.js      local store, sync client, voice, parser, views
test/
  parser.test.js   runs against the shipped bundle, not a copy of it
  sync.test.js     drives the real server over HTTP as two devices
```

No framework on the frontend, no build step, no bundler, no dependencies. About 1,600 lines of plain JavaScript and a design system that's just CSS custom properties. I wanted to know what was actually mine.

Records are stored as JSON blobs rather than wide columns. A swim coach needs event times and best times; a life coach needs session themes. Trying to design one table for both means either endless migrations or a sea of nulls. Every read here is "give me this coach's records since cursor N" and never a content search, so there's nothing lost by not being able to query inside a record.

---

## Security

Passwords are bcrypt at cost 12. Sessions live server-side behind httpOnly, sameSite cookies, so page JavaScript can never read a token even if I've left an XSS hole somewhere.

Reset tokens are stored hashed, so getting hold of the database doesn't let you mint working reset links. They're single use, good for an hour, and requesting a new one kills the old. `/forgot` gives the same answer whether or not the address exists, and login timing is equalised, so neither can be used to work out who has an account. A successful reset signs out every session, including whoever prompted it.

Changing your email needs the current password, has to be confirmed from the new address, and pings the old one to say it's happening.

Rate limiting is keyed per IP *and* route *and* identity. That last bit came out of an actual bug: I'd keyed on IP alone for requests with no email in the body, which meant finishing a password reset ate the allowance for changing an email, and everyone behind one office router shared a single budget. A test failed for the wrong reason and led me to it. There's a regression test now.

---

## Putting it online

### Free, on Render

Push to GitHub, then Render → New → Blueprint → point it at the repo. `render.yaml` handles the rest and generates `SESSION_SECRET` for you.

Two things to know about the free tier. There's no persistent disk, so the database resets whenever the service restarts — `EPHEMERAL_STORAGE=true` makes the app admit that in the UI rather than losing someone's work quietly, and the demo account rebuilds itself from seed on every boot so it's always populated. It also sleeps after about fifteen minutes idle, which means the first visitor waits the better part of a minute. A free ping from cron-job.org hitting `/api/health` every ten minutes keeps it awake, and one always-on service fits inside the 750 free hours a month.

### A couple of dollars a month, on Fly

`fly.toml` mounts a real volume, so data survives restarts and cold starts take a second or two rather than fifty.

```bash
fly launch --no-deploy --name coachdesk-yourname
fly volumes create data --size 1 --region iad
fly secrets set SESSION_SECRET=$(openssl rand -hex 32) PUBLIC_DEMO=true
fly deploy
```

For anything real, set `NODE_ENV=production` so cookies get the Secure flag, configure `SMTP_*` so reset links stop printing to the console, and point `APP_URL` at your actual domain.

---

## Optional extras

All off by default. The app runs fine without any of them, and each one explains itself rather than erroring when it isn't set up.

| Feature | Turn on with | Otherwise |
|---|---|---|
| Google Calendar sync | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Panel walks you through the setup |
| Password reset emails | `SMTP_HOST` and credentials | Links print to the server console |
| AI parsing fallback | `ANTHROPIC_API_KEY` | Rules only; odd phrasings show examples |
| Public demo account | `PUBLIC_DEMO=true` | Signup only |

On Google Calendar conflicts, CoachDesk always wins: the local copy overwrites Google, no comparison. Events created in Google get imported and left alone. That's blunt, but blunt and predictable beats clever and surprising. The catch is that editing a CoachDesk event inside Google gets undone on the next sync.

Client names deliberately don't go into Google event titles. Coaches share calendars with clubs and parents all the time, and dumping a client list into a shared calendar is a genuine harm, not a hypothetical one. It's one constant in `server/google.js` if your situation is different.

---

## Clients under 18

Data protection attaches to whoever the record is *about*, not whoever's holding it. Marking a client as under 18 asks for a guardian name and contact, then records whether consent was actually obtained, when, and how. If it's missing you get a banner on the client list and a flag on the record. Each client sheet can export everything held about that one person, which is what you need when a parent asks what you've got.

It nags rather than blocks. Blocking would just teach people to record minors as adults.

None of this makes anyone compliant on its own, and none of it is legal advice.

---

## What's missing

Writing these down beats pretending they aren't there:

- Consent capture has no retention schedule, no automatic deletion, no way to withdraw, and no record of who looked at what.
- Sync is polled rather than pushed: every sixty seconds, on focus, and after edits. Fine for one coach and two devices. Real-time would want WebSockets.
- Google sync only runs when you press the button. No background job, no webhook. The UI says as much instead of implying otherwise.
- Recurring lessons don't exist yet. "Every Tuesday at 4" is spotted and creates a single event with a warning, which beats booking one week and silently dropping the rest.
- Names are inferred from position, so unusual ones can land wrong. The confirmation card is the safety net.
- "Next Tuesday" is genuinely ambiguous in English. It resolves to the Tuesday after the coming one, and the card shows you what it decided.
- Rate limiting lives in memory, so it resets on restart and doesn't work across processes.
- Lose access to your email and there's no way back into the account.
- SQLite is single-process. Fine as deployed. More than one instance means Postgres, though the storage layer is small and lives entirely in `server/db.js`.

---

MIT licensed.
