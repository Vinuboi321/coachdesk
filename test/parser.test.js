"use strict";
/* ============================================================
   Parser tests — natural speech, not command syntax.

   The parser lives in the browser bundle, so this loads public/app.js,
   cuts it at the first DOM-dependent section, and evaluates the pure
   half with a few globals stubbed. Crude, but it means the tests run
   against the exact code that ships rather than a copy that can drift.

   Run with:  npm test
   ============================================================ */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const CUT = SRC.indexOf("/* ---------- 7. CONFIRMATION");
if (CUT < 0) throw new Error("Section 7 marker missing — did app.js get restructured?");

const sandbox = {
  window: { addEventListener() {}, SpeechRecognition: null },
  document: { getElementById: () => null, addEventListener() {}, querySelector: () => null },
  localStorage: undefined,
  fetch: () => Promise.reject(new Error("offline in tests")),
  setInterval: () => 0,
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
  navigator: { language: "en-US" },
  module: { exports: {} }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(
  SRC.slice(0, CUT).replace(/^"use strict";/m, "") +
  "\n;this.__api = { parseCommand, matchClients, extractName, extractDuration, setClients: v => { S.clients = v; } };",
  sandbox
);
const API = sandbox.__api;

API.setClients([
  { id: "a", name: "Jacob Smith", notes: [] },
  { id: "b", name: "Maya Chen", notes: [] },
  { id: "c", name: "Daniel Ortiz", notes: [] },
  { id: "d", name: "Danielle Ross", notes: [] }
]);

// Fixed reference point so weekday maths is deterministic: a Saturday.
const NOW = new Date("2026-08-08T10:00:00");

let pass = 0, fail = 0;

function check(text, expected) {
  const r = API.parseCommand(text, NOW);
  const got = { intent: r.intent };
  if (r.name !== undefined) got.name = r.name;
  if (r.phone) got.phone = r.phone;
  if (r.email) got.email = r.email;
  if (r.age != null) got.age = r.age;
  if (r.isMinor) got.minor = true;
  if (r.tags && r.tags.length) got.tags = r.tags.join("/");
  if (r.clientQuery !== undefined) got.q = r.clientQuery;
  if (r.when) got.when = r.when.toISOString().slice(0, 16);
  if (r.durationMin) got.dur = r.durationMin;
  if (r.recurring) got.recurring = true;

  const bad = Object.keys(expected).filter(k => String(got[k]) !== String(expected[k]));
  if (bad.length) {
    fail++;
    console.log(`  FAIL  ${text}`);
    console.log(`        got      ${JSON.stringify(got)}`);
    console.log(`        expected ${JSON.stringify(expected)}  (differs: ${bad.join(", ")})`);
  } else {
    pass++;
    console.log(`  ok    ${text.length > 62 ? text.slice(0, 59) + "…" : text}`);
  }
}

// Local ISO helper so expectations read as wall-clock time.
const at = (day, hh, mm) => new Date(2026, 7, day, hh, mm).toISOString().slice(0, 16);

console.log("\n  Creating a client — however it comes out\n");
check("i have a client jacob smith for tennis, and he is 19 and his phone number is 469-312-4412",
  { intent: "add_client", name: "Jacob Smith", phone: "469-312-4412", age: 19, tags: "tennis" });
check("I have a client Jacob Smith for tennis he's 19 his number is 4693124412",
  { intent: "add_client", name: "Jacob Smith", age: 19, tags: "tennis" });
check("add a new client named priya nair, she does swimming, 555-010-1234",
  { intent: "add_client", name: "Priya Nair", tags: "swimming" });
check("new client Sam Rivera", { intent: "add_client", name: "Sam Rivera" });
check("i've got a new student called Danielle Ross who is 14 and plays soccer",
  { intent: "add_client", name: "Danielle Ross", age: 14, minor: true, tags: "soccer" });
check("set up a client for me, his name is Marcus Bell, golf, marcus@example.com",
  { intent: "add_client", name: "Marcus Bell", email: "marcus@example.com", tags: "golf" });
check("my new client is Aisha Khan, she's 22, advanced tennis, 469 312 4412",
  { intent: "add_client", name: "Aisha Khan", age: 22 });
check("take on a new athlete Leo Park, 16 years old, junior swimming",
  { intent: "add_client", name: "Leo Park", age: 16, minor: true });
check("register a client Tom Hardy aged 31 for boxing",
  { intent: "add_client", name: "Tom Hardy", age: 31, tags: "boxing" });
check("this is a new client, Elena Rossi, she's a beginner at yoga",
  { intent: "add_client", name: "Elena Rossi" });
check("add client Ben", { intent: "add_client", name: "Ben" });
check("i'm working with a new player Chris O'Neill for rugby",
  { intent: "add_client", name: "Chris O'Neill", tags: "rugby" });

console.log("\n  Under-18 clients are flagged automatically\n");
check("new client Amy Wong, 12 years old, gymnastics",
  { intent: "add_client", age: 12, minor: true });
check("new client Rob Hall, 18, tennis", { intent: "add_client", age: 18 });
check("new client Kai Tan who is 17 and does diving",
  { intent: "add_client", age: 17, minor: true });

console.log("\n  Scheduling in natural speech\n");
check("set up lesson for jacob smith on tuesday at 4pm",
  { intent: "add_event", q: "Jacob Smith", when: at(11, 16, 0) });
check("schedule a lesson with jacob next monday at 3 in the afternoon",
  { intent: "add_event", q: "Jacob", when: at(17, 15, 0) });
check("book jacob smith for a tennis lesson thursday at half past four",
  { intent: "add_event", q: "Jacob Smith", when: at(13, 16, 30) });
check("lesson with maya tomorrow at noon",
  { intent: "add_event", q: "Maya", when: at(9, 12, 0) });
check("schedule a session for jacob friday at 5 for an hour and a half",
  { intent: "add_event", q: "Jacob", when: at(14, 17, 0), dur: 90 });
check("put jacob in for a lesson wednesday at 4 for 45 minutes",
  { intent: "add_event", q: "Jacob", when: at(12, 16, 0), dur: 45 });
check("book a practice with maya on august 20 at quarter past nine",
  { intent: "add_event", q: "Maya", when: at(20, 9, 15) });
check("arrange a meeting with daniel tomorrow at 9 in the morning",
  { intent: "add_event", q: "Daniel", when: at(9, 9, 0) });
check("lesson for maya today at 6pm on court 3",
  { intent: "add_event", q: "Maya", when: at(8, 18, 0) });
check("training with jacob for half an hour tomorrow at 7am",
  { intent: "add_event", q: "Jacob", when: at(9, 7, 0), dur: 30 });
check("schedule a lesson with maya every tuesday at 4pm",
  { intent: "add_event", recurring: true });

console.log("\n  Ambiguity is surfaced, not guessed at\n");
{
  const r = API.parseCommand("book a session with Daniel tomorrow at 2pm", NOW);
  const hits = API.matchClients(r.clientQuery);
  if (hits.length === 2) { pass++; console.log("  ok    \"Daniel\" matches both Daniel Ortiz and Danielle Ross"); }
  else { fail++; console.log(`  FAIL  expected 2 matches for "Daniel", got ${hits.length}`); }
}
{
  const r = API.parseCommand("i have a client for tennis who is 20", NOW);
  if (r.intent === "add_client" && !r.name && r.needsName) { pass++; console.log("  ok    a missing name is reported, not invented"); }
  else { fail++; console.log(`  FAIL  expected needsName, got ${JSON.stringify(r)}`); }
}

console.log("\n  Other intents still work\n");
check("note for jacob smith: worked on his serve today", { intent: "add_note" });
check("log for maya - great progress on her turns", { intent: "add_note" });
check("add certification USPTA Level 2", { intent: "add_resume_item" });
check("add testimonial best coach my daughter has had", { intent: "add_resume_item" });
check("add experience Head Coach at Riverside Club", { intent: "add_resume_item" });
check("cancel the lesson with maya tomorrow", { intent: "cancel_event" });
check("make me a sandwich", { intent: "unknown" });
check("", { intent: "unknown" });

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
