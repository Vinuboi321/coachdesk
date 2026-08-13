# CoachDesk

Client and scheduling manager for coaches, driven by voice. You say a sentence, it shows you what it understood, you confirm.

[![CI](https://github.com/Vinuboi321/coachdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/Vinuboi321/coachdesk/actions/workflows/ci.yml)
[![Pages](https://github.com/Vinuboi321/coachdesk/actions/workflows/pages.yml/badge.svg)](https://github.com/Vinuboi321/coachdesk/actions/workflows/pages.yml)
![Tests](https://img.shields.io/badge/tests-142%20passing-3D5A4C)
![Node](https://img.shields.io/badge/node-22%2B-3D5A4C)

**[Live demo](https://vinuboi321.github.io/coachdesk/)** — loads with sample data, no signup.

## What it does

Three sections: clients, calendar, and a profile that exports as a résumé or a client-facing flier. Everything works offline and syncs when you reconnect. You can type anywhere you can speak.

## Activity Overview

**Parsing.** It pulls entities out of a sentence instead of matching a fixed pattern, so word order doesn't matter. Both of these produce the same record:

```
new client Anna Foster, she does swimming, she's 24, 555-010-1234
I've got a new student Anna Foster for swimming, 24, 555-010-1234
```

It handles `tomorrow`, `next Tuesday`, `half past four`, `for an hour and a half`. An age under 18 opens guardian and consent fields on its own.

Nothing saves without confirmation. Speech recognition mangles names constantly, and a misheard word shouldn't be able to cancel a real client's lesson.

**Sync.** The cursor is a sequence number issued by the server, not a timestamp. Phone clocks drift, and a device running a few minutes fast would skip records permanently. Conflicts are last-write-wins per record; the losing device gets the winning version back in the same response and corrects itself. Deletes leave tombstones, otherwise a device that was offline during a deletion re-uploads the record and resurrects it.

**No frontend dependencies.** About 1,600 lines of plain JavaScript. No framework, no bundler, no build step.

## Running it

```bash
npm install
cp .env.example .env
npm start
```

Node 22.5 or newer, which has SQLite built in. Then <http://localhost:3000>.

```bash
npm test        # 142 checks across the parser, the server, and the deployed build
```

Voice needs Chrome, Edge or Safari.

## Layout

```
server/    express app, sqlite, auth, sync, google calendar
public/    the entire frontend, plus the shared demo data
scripts/   static build for github pages
test/      parser, server and sync, deployed build
```

## Optional extras

Google Calendar sync, password reset emails, a public demo account, and an AI parsing fallback all switch on with environment variables and stay off without them. `.env.example` has the details.

Google conflicts resolve in CoachDesk's favour. Client names are deliberately kept out of Google event titles, since coaches share calendars.

## Deploying

GitHub Pages serves the browser-only build and redeploys on every push. `render.yaml` and `fly.toml` are there for the full stack with a real server.

## Known gaps

- Sync polls rather than pushes
- Google sync runs only when you press the button
- Recurring lessons are detected but not supported
- Consent tracking is a prompt and a record, not a compliance system
- Rate limiting is in-memory
- SQLite is single-process

## Licence

MIT
