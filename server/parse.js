"use strict";
/* ============================================================
   Optional AI parser.

   The rules in public/app.js handle ordinary phrasing offline, instantly
   and for free. This is the fallback for the awkward remainder — and it
   is *only* reached when the rules return "unknown", so a coach with no
   key configured never notices it's missing, and a coach with one pays
   for a small fraction of their commands.

   The model returns structured intent only. It never writes anything:
   output still lands on the same editable confirmation card, so a
   hallucinated name or time is caught by a human before it's saved.
   ============================================================ */

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = 8000;

const configured = () => !!process.env.ANTHROPIC_API_KEY;

const SYSTEM = `You convert a coach's spoken sentence into one structured action for a coaching app.

Reply with ONLY a JSON object, no prose and no code fences.

Choose exactly one intent:

"add_client"      — introducing a new person to coach.
  Fields: name (string), phone (string, ""), email (string, ""),
          age (number or null), tags (array of lowercase strings:
          sport/activity and level, e.g. ["tennis","junior"])

"add_event"       — booking a lesson, session, practice or meeting.
  Fields: title (string, e.g. "Lesson"), clientQuery (string — just the
          person's name as spoken, "" if none), startISO (ISO 8601 local
          datetime string, or null if no date/time was given),
          durationMin (number, default 60), location (string, "")

"add_note"        — recording something about a client.
  Fields: clientQuery (string), text (string)

"add_resume_item" — the coach's own credentials, not a client's.
  Fields: kind ("certification" | "specialty" | "experience" | "testimonial"),
          value (string)

"cancel_event"    — cancelling or deleting a booking.
  Fields: clientQuery (string, ""), startISO (ISO string or null)

"unknown"         — anything else, or too ambiguous to act on.

Rules:
- Resolve relative dates against the supplied current time.
- A weekday with no qualifier means the NEXT occurrence, never today.
- Bare hours favour waking hours: "at 4" for a lesson means 16:00.
- Never invent a phone number, email or name that wasn't said.
- Omit anything you're unsure of rather than guessing.`;

/**
 * POST /api/parse  { text }
 * Always answers 200 with an intent — a failure here degrades to
 * "unknown", which is exactly what the rules already produced.
 */
async function handleParse(req, res) {
  const text = String(req.body?.text || "").slice(0, 600).trim();
  if (!text) return res.json({ intent: "unknown", source: "empty" });
  if (!configured()) return res.json({ intent: "unknown", source: "not_configured" });

  const now = new Date();
  const names = Array.isArray(req.body?.clientNames)
    ? req.body.clientNames.filter(n => typeof n === "string").slice(0, 200)
    : [];

  const context =
    `Current local time: ${now.toString()}\n` +
    `ISO: ${now.toISOString()}\n` +
    (names.length ? `Existing clients: ${names.join(", ")}\n` : "") +
    `\nSentence: ${text}`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  try {
    const r = await fetch(API_URL, {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: SYSTEM,
        messages: [{ role: "user", content: context }]
      })
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      console.error("  ! AI parse failed:", r.status, detail.slice(0, 200));
      return res.json({ intent: "unknown", source: "api_error" });
    }

    const body = await r.json();
    const raw = (body.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const parsed = extractJSON(raw);
    if (!parsed || typeof parsed.intent !== "string") {
      return res.json({ intent: "unknown", source: "unparseable" });
    }
    return res.json(Object.assign(sanitize(parsed), { source: "ai" }));
  } catch (e) {
    // Timeout, DNS failure, offline — all the same to the caller.
    console.error("  ! AI parse unavailable:", e.name === "AbortError" ? "timed out" : e.message);
    return res.json({ intent: "unknown", source: "unavailable" });
  } finally {
    clearTimeout(timer);
  }
}

/** Models sometimes wrap JSON in prose or fences despite instructions. */
function extractJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (_) {}
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch (_) {} }
  const brace = s.match(/\{[\s\S]*\}/);
  if (brace) { try { return JSON.parse(brace[0]); } catch (_) {} }
  return null;
}

const str = v => (typeof v === "string" ? v.slice(0, 300) : "");
const num = (v, min, max) => (Number.isFinite(+v) && +v >= min && +v <= max ? +v : null);

/** Never trust model output straight into the app's shapes. */
function sanitize(p) {
  const ALLOWED = ["add_client","add_event","add_note","add_resume_item","cancel_event","unknown"];
  const intent = ALLOWED.includes(p.intent) ? p.intent : "unknown";
  const out = { intent };

  if (intent === "add_client") {
    out.name = str(p.name);
    out.phone = str(p.phone);
    out.email = str(p.email);
    out.age = num(p.age, 3, 100);
    out.tags = Array.isArray(p.tags) ? p.tags.filter(t => typeof t === "string").slice(0, 8).map(t => t.toLowerCase().slice(0, 40)) : [];
    out.isMinor = out.age != null && out.age < 18;
  } else if (intent === "add_event") {
    out.title = str(p.title) || "Session";
    out.clientQuery = str(p.clientQuery);
    out.startISO = validISO(p.startISO);
    out.durationMin = num(p.durationMin, 5, 600) || 60;
    out.location = str(p.location);
  } else if (intent === "add_note") {
    out.clientQuery = str(p.clientQuery);
    out.text = str(p.text);
  } else if (intent === "add_resume_item") {
    const kinds = ["certification","specialty","experience","testimonial"];
    out.kind = kinds.includes(p.kind) ? p.kind : "certification";
    out.value = str(p.value);
  } else if (intent === "cancel_event") {
    out.clientQuery = str(p.clientQuery);
    out.startISO = validISO(p.startISO);
  }
  return out;
}

function validISO(v) {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  // Reject anything absurd — a model that misreads a year shouldn't put a
  // lesson in 1970 or 2140.
  const y = new Date(t).getFullYear();
  const nowY = new Date().getFullYear();
  if (y < nowY - 1 || y > nowY + 5) return null;
  return new Date(t).toISOString();
}

module.exports = { handleParse, configured };
