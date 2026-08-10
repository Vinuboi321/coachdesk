/* ============================================================
   CoachDesk client
   ------------------------------------------------------------
   Local-first. Every change writes to localStorage immediately and
   syncs in the background, so the app stays usable on a pool deck with
   two bars of signal and catches up when it reconnects.
   ============================================================ */
"use strict";

/* ---------- 1. LOCAL STORE ------------------------------------------- */
const LS = (() => {
  let ok = true, mem = {};
  try { localStorage.setItem("__p", "1"); localStorage.removeItem("__p"); } catch (e) { ok = false; }
  return {
    ok,
    get(k){ try { return ok ? localStorage.getItem(k) : (mem[k] ?? null); } catch(e){ return mem[k] ?? null; } },
    set(k,v){ try { ok ? localStorage.setItem(k,v) : (mem[k]=v); } catch(e){ ok=false; mem[k]=v; } },
    del(k){ try { ok ? localStorage.removeItem(k) : delete mem[k]; } catch(e){ delete mem[k]; } }
  };
})();

const K = { state:"coachdesk.v2.state", cursor:"coachdesk.v2.cursor", dirty:"coachdesk.v2.dirty" };

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const nowIso = () => new Date().toISOString();

const blankProfile = () => ({
  name:"", title:"", email:"", phone:"", location:"", website:"",
  bio:"", tagline:"", offer:"",
  specialties:[], experience:[], certifications:[], testimonials:[],
  updated_at: nowIso()
});
const blankState = () => ({ clients:[], events:[], profile: blankProfile() });

let S = blankState();
let cursor = 0;
let dirty = new Set();          // "client:<id>" | "event:<id>" | "profile"
let me = null;                  // signed-in user

function persist(){
  LS.set(K.state, JSON.stringify(S));
  LS.set(K.cursor, String(cursor));
  LS.set(K.dirty, JSON.stringify([...dirty]));
}
function restore(){
  try {
    const raw = LS.get(K.state);
    if (raw){
      const p = JSON.parse(raw);
      S = Object.assign(blankState(), p);
      S.profile = Object.assign(blankProfile(), p.profile || {});
    }
  } catch(e){ console.warn("local state unreadable, starting clean", e); S = blankState(); }
  cursor = parseInt(LS.get(K.cursor) || "0", 10) || 0;
  try { dirty = new Set(JSON.parse(LS.get(K.dirty) || "[]")); } catch(e){ dirty = new Set(); }
}
function clearLocal(){
  LS.del(K.state); LS.del(K.cursor); LS.del(K.dirty);
  LS.del("coachdesk.v2.seedVersion");   // so the demo re-seeds on next boot
  S = blankState(); cursor = 0; dirty = new Set();
}

/** Stamp a record as changed and queue it for the next sync. */
function touch(kind, rec){
  rec.updated_at = nowIso();
  dirty.add(kind === "profile" ? "profile" : `${kind}:${rec.id}`);
  persist();
  scheduleSync();
}
const live = arr => arr.filter(r => !r.deleted);
const clients = () => live(S.clients);
const events  = () => live(S.events);

/* ---------- 2. SYNC ENGINE -------------------------------------------
   Push what's dirty, pull what's new, merge by logical timestamp. The
   set of keys sent is snapshotted before the request so edits made while
   it's in flight aren't silently marked clean.
--------------------------------------------------------------------- */
let syncTimer = null, syncing = false, syncState = "idle";

function setSyncState(s){
  syncState = s;
  const d = document.getElementById("syncDot");
  if (!d) return;
  d.className = "syncdot" + (s==="ok"?" ok":s==="busy"?" busy":s==="error"?" err":"");
  d.title = { idle:"Not synced yet", busy:"Syncing…", ok:"All changes saved",
              offline:"Offline — changes saved on this device", error:"Sync problem" }[s] || "";
}

function scheduleSync(delay = 1200){
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), delay);
}

/* ---------- STATIC MODE ----------------------------------------------
   The GitHub Pages build sets window.COACHDESK_STATIC. There's no server
   behind it, so the whole sync and auth layer is short-circuited and
   everything lives in this browser's localStorage.

   The app is genuinely usable this way — it was local-first to begin
   with. What's missing is only the things that need a backend, and those
   say so plainly rather than presenting buttons that quietly do nothing.
--------------------------------------------------------------------- */
const STATIC = typeof window !== "undefined" && window.COACHDESK_STATIC === true;

/** Canned responses so nothing downstream has to know the server is absent. */
function staticApi(path){
  if (path === "/api/auth/me")      return { user:{ id:"local", email:"you@thisdevice" }, demo:false, ephemeral:false, static:true };
  if (path === "/api/sync")         return { cursor:0, pull:{}, applied:0, stale:0, invalid:0 };
  if (path === "/api/snapshot")     return { clients:S.clients, events:S.events, profile:S.profile, cursor:0 };
  if (path === "/api/google/status")return { configured:false, connected:false, email:null, lastSyncAt:null };
  if (path.startsWith("/api/parse"))return { intent:"unknown", source:"not_configured" };
  return { ok:true };
}

async function api(path, opts = {}){
  if (STATIC) return staticApi(path);
  const r = await fetch(path, Object.assign({
    headers: { "Content-Type":"application/json" },
    credentials: "same-origin"
  }, opts));
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || `Request failed (${r.status})`), { status:r.status, body });
  return body;
}

async function syncNow(){
  if (STATIC){ setSyncState("ok"); return; }   // nothing to sync to
  if (!me || syncing) return;
  syncing = true;
  setSyncState("busy");

  const sent = [...dirty];
  const push = { clients:[], events:[] };
  for (const key of sent){
    if (key === "profile"){ push.profile = S.profile; continue; }
    const [kind, id] = key.split(":");
    const rec = (kind==="client" ? S.clients : S.events).find(r => r.id === id);
    if (rec) push[kind+"s"].push(rec);
  }

  try {
    const res = await api("/api/sync", { method:"POST", body: JSON.stringify({ since: cursor, push }) });
    sent.forEach(k => dirty.delete(k));
    merge(res.pull);
    cursor = res.cursor;
    persist();
    setSyncState(dirty.size ? "idle" : "ok");
    render();
    if (res.invalid) console.warn("sync rejected some records", res.problems);
  } catch (e) {
    if (e.status === 401){ signedOut(); }
    else if (e.status){ setSyncState("error"); console.warn("sync error", e.message); }
    else setSyncState("offline");           // network failure — try again later
  } finally {
    syncing = false;
    if (dirty.size) scheduleSync(4000);
  }
}

/** Merge server records into local state. Local wins only if strictly newer. */
function merge(pull){
  if (!pull) return;
  for (const kind of ["clients","events"]){
    for (const inc of pull[kind] || []){
      const arr = S[kind];
      const i = arr.findIndex(r => r.id === inc.id);
      if (i < 0){ if (!inc.deleted) arr.push(inc); else arr.push(inc); continue; }
      if (!arr[i].updated_at || inc.updated_at >= arr[i].updated_at) arr[i] = inc;
    }
  }
  if (pull.profile && (!S.profile.updated_at || pull.profile.updated_at >= S.profile.updated_at)){
    S.profile = Object.assign(blankProfile(), pull.profile);
  }
}

/** First sign-in on a device: take the server's world wholesale. */
async function pullSnapshot(){
  try {
    setSyncState("busy");
    const snap = await api("/api/snapshot");
    S.clients = snap.clients || [];
    S.events  = snap.events  || [];
    S.profile = Object.assign(blankProfile(), snap.profile || {});
    cursor = snap.cursor || 0;
    dirty.clear();
    persist();
    setSyncState("ok");
  } catch(e){ setSyncState("offline"); }
}

window.addEventListener("online",  () => syncNow());
window.addEventListener("offline", () => setSyncState("offline"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
setInterval(() => { if (me && !document.hidden) syncNow(); }, 60000);

/* ---------- 3. HELPERS ------------------------------------------------ */
const $  = (s,r=document) => r.querySelector(s);
const $$ = (s,r=document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s??"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const initials = n => (n||"?").trim().split(/\s+/).slice(0,2).map(w=>w[0]).join("").toUpperCase();

const DOW = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const startOfDay = d => { const x=new Date(d); x.setHours(0,0,0,0); return x; };
const sameDay = (a,b) => startOfDay(a).getTime() === startOfDay(b).getTime();

function fmtTime(d){
  d = new Date(d);
  let h=d.getHours(), m=d.getMinutes(), ap=h>=12?"pm":"am";
  h = h%12 || 12;
  return m ? `${h}:${String(m).padStart(2,"0")}${ap}` : `${h}${ap}`;
}
function fmtDay(d){
  d = new Date(d); const n = new Date();
  if (sameDay(d,n)) return "Today";
  const t = new Date(n); t.setDate(t.getDate()+1); if (sameDay(d,t)) return "Tomorrow";
  const y = new Date(n); y.setDate(y.getDate()-1); if (sameDay(d,y)) return "Yesterday";
  return Math.abs(d-n) < 6*864e5 ? DOW[d.getDay()]
       : `${DOW[d.getDay()].slice(0,3)}, ${MON[d.getMonth()].slice(0,3)} ${d.getDate()}`;
}
const fmtDT = d => `${fmtDay(d)} at ${fmtTime(d)}`;
function toLocalInput(iso){
  const d=new Date(iso), p=n=>String(n).padStart(2,"0");
  return { date:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`, time:`${p(d.getHours())}:${p(d.getMinutes())}` };
}
function fromLocalInput(ds, ts){
  const [y,m,d]=ds.split("-").map(Number), [hh,mm]=(ts||"09:00").split(":").map(Number);
  return new Date(y,m-1,d,hh,mm,0,0).toISOString();
}

let toastT;
function toast(msg){
  const t=$("#toast"); t.textContent=msg; t.classList.add("on");
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove("on"),2400);
}
const clientById = id => S.clients.find(c => c.id===id && !c.deleted) || null;
const clientName = id => (clientById(id)||{}).name || "";

/* ---------- 4. NAME MATCHING ------------------------------------------
   Speech mangles names. Try progressively looser matches and report
   ambiguity upward instead of guessing — the confirmation card asks.
--------------------------------------------------------------------- */
const norm = s => String(s||"").toLowerCase().replace(/[^a-z0-9\s]/g,"").replace(/\s+/g," ").trim();

function matchClients(query){
  const q = norm(query);
  if (!q) return [];
  const exact=[],starts=[],partial=[],token=[];
  for (const c of clients()){
    const n = norm(c.name); if (!n) continue;
    if (n===q){ exact.push(c); continue; }
    if (n.startsWith(q)||q.startsWith(n)){ starts.push(c); continue; }
    if (n.includes(q)||q.includes(n)){ partial.push(c); continue; }
    const qt=q.split(" "), nt=n.split(" ");
    if (qt.some(t=>t.length>2 && nt.some(u=>u===t||(u.length>3&&t.length>3&&(u.startsWith(t)||t.startsWith(u)))))) token.push(c);
  }
  return exact.length?exact:starts.length?starts:partial.length?partial:token;
}

/* ---------- 5. VOCABULARY + ENTITY EXTRACTION -------------------------
   People don't speak in field order. "I have a client Ryan Cole for tennis,
   he's 27, his number is 555-018-8100" carries the same five
   facts as any other phrasing, just scattered.

   So rather than matching a sentence shape, we pull each entity out from
   wherever it sits — phone, email, age, activity — remove it, and let the
   name fall out of what's left. Order matters: email before phone (it can
   contain digits), phone before age (so a phone number isn't read as an
   age).
--------------------------------------------------------------------- */
const ACTIVITIES = [
  // multi-word first — longest match wins
  "figure skating","martial arts","water polo","jiu jitsu","brazilian jiu jitsu","cross country",
  "track and field","strength and conditioning","personal training","public speaking",
  "tennis","swimming","soccer","football","basketball","baseball","softball","golf","running",
  "track","cricket","hockey","volleyball","badminton","boxing","mma","wrestling","gymnastics",
  "yoga","pilates","crossfit","strength","conditioning","fitness","nutrition","rowing","cycling",
  "triathlon","climbing","bouldering","skiing","snowboarding","surfing","skating","lacrosse",
  "rugby","diving","fencing","archery","karate","judo","taekwondo","squash","netball","handball",
  "sprinting","hurdles","weightlifting","powerlifting","calisthenics","rehab","physio",
  "life","executive","business","career","leadership","mindset","wellness","confidence",
  "math","maths","science","physics","chemistry","biology","english","reading","writing",
  "sat","act","gcse","piano","violin","guitar","drums","voice","singing","dance","ballet",
  "chess","debate","acting","drama"
];
const LEVELS = ["beginner","novice","intermediate","advanced","elite","competitive",
                "recreational","junior","senior","youth","adult","pro","professional"];

const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/;
// Ten-digit North American style, tolerant of spaces, dots, dashes, parens.
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const AGE_RES = [
  /\b(\d{1,2})\s*(?:years?|yrs?)\s*old\b/i,
  /\bage[d]?\s*(?:is|of|:)?\s*(\d{1,2})\b/i,
  /\b(?:who|that)\s*(?:'s|s)?\s*(?:is|are)?\s*(\d{1,2})\b(?!\s*:)/i,
  /\b(?:he|she|they)\s*(?:'s|s)?\s*(?:is|are)?\s*(\d{1,2})\b(?!\s*:)/i,
  /\b(\d{1,2})\s*(?:y\.?o\.?|yo)\b/i,
  // Bare "is 14" — only reached once phone, email and the more specific
  // phrasings above have already been taken out.
  /\b(?:is|turns|turning)\s+(\d{1,2})\b(?!\s*[:.]\d)/i,
  // A lone number in a comma list: "Rob Hall, 18, tennis". Safe here
  // because this only runs for add_client, and the phone has already gone.
  /(?:^|,)\s*(\d{1,2})\s*(?=,|$)/
];

/** Pull the first match of `re` out of `text`; returns {value, text}. */
function take(text, re, pick){
  const m = text.match(re);
  if (!m) return { value: null, text };
  return { value: pick ? pick(m) : m[0], text: text.replace(m[0], " ") };
}

function takeEmail(text){ return take(text, EMAIL_RE); }

function takePhone(text){
  const r = take(text, PHONE_RE);
  if (!r.value) return r;
  const digits = r.value.replace(/\D/g, "");
  // 7–15 digits is a plausible phone; anything else was probably a date
  // or a stray number that happened to fit the shape.
  if (digits.length < 7 || digits.length > 15) return { value: null, text };
  return { value: r.value.trim(), text: r.text };
}

function takeAge(text){
  for (const re of AGE_RES){
    const m = text.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n >= 3 && n <= 100) return { value: n, text: text.replace(m[0], " ") };
  }
  return { value: null, text };
}

/** Activities and levels, anywhere in the sentence. */
function takeTags(text){
  const found = [];
  let out = text;
  for (const a of ACTIVITIES){
    const re = new RegExp(`\\b${a.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(out)){ found.push(a); out = out.replace(re, " "); }
  }
  for (const l of LEVELS){
    const re = new RegExp(`\\b${l}\\b`, "i");
    if (re.test(out)){ found.push(l); out = out.replace(re, " "); }
  }
  return { value: found, text: out };
}

/* Words that can't be part of a name — used to find where a name ends. */
const NAME_STOP = /\b(?:for|who|whose|and|but|he|she|they|him|his|her|hers|their|them|is|are|was|were|does|do|did|play(?:s|ing)?|practi[sc]e(?:s|ing)?|train(?:s|ing)?|with|at|on|in|phone|number|cell|mobile|tel|email|mail|contact|reach|aged?|level|want(?:s)?|need(?:s)?|start(?:s|ing)?|lesson|session|coaching|new|the|a|an)\b/i;

const FILLER = /\b(?:um+|uh+|er+|like|okay|ok|so|please|just|actually|basically)\b/gi;

const TITLE_CASE = s => s.replace(/\b[\p{L}][\p{L}'’-]*/gu,
  w => w[0].toUpperCase() + w.slice(1).toLowerCase())
  .replace(/(['’-])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());

/** What's left after entities are removed should contain the name. */
function extractName(text){
  let s = String(text || "").replace(FILLER, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";

  // An explicit "name is X" is far more reliable than position.
  const explicit = s.match(EXPLICIT_NAME_RE);
  if (explicit) s = explicit[1];

  // Leading connectives ("for me, his...", "and he...") aren't the name —
  // drop them and keep looking rather than treating them as a boundary.
  let guard = 0;
  while (guard++ < 8){
    const lead = s.match(NAME_STOP);
    if (lead && lead.index === 0) s = s.slice(lead[0].length).replace(/^[\s,;:.-]+/, "");
    else break;
  }

  const stop = s.match(NAME_STOP);
  if (stop && stop.index > 0) s = s.slice(0, stop.index);

  s = s.replace(/[,;:.!?]+.*$/, "")          // first clause only
       .replace(/[^\p{L}\s'’-]/gu, " ")
       .replace(/\s+/g, " ").trim();

  const words = s.split(" ").filter(w => w.length > 1 || /^[\p{L}]$/u.test(w));
  if (!words.length) return "";
  const name = words.slice(0, 4).join(" ");
  if (name.length < 2 || name.length > 60) return "";
  return TITLE_CASE(name);
}

/**
 * Pick the most plausible client name from several candidate strings.
 * "Book Ryan for a lesson" puts the name before "for"; "book a lesson
 * for Ryan" puts it after. Rather than guess the grammar, try both and
 * prefer whichever actually matches somebody on the books.
 */
function bestClientQuery(candidates){
  let best = "", bestScore = -1;
  for (const cand of candidates){
    const nm = extractName(cand);
    if (!nm) continue;
    const score = matchClients(nm).length ? 3 : nm.split(" ").length >= 2 ? 2 : 1;
    if (score > bestScore){ bestScore = score; best = nm; }
  }
  return best;
}

/* ---------- 5b. DATE + TIME EXTRACTION -------------------------------- */
const TIME_RE = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)\b|\b(?:at\s+)(\d{1,2}):(\d{2})\b/i;
const NAMED_TIME_RE = /\b(noon|midday|midnight)\b/i;
const PART_OF_DAY_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(?:o'?clock\s*)?in\s+the\s+(morning|afternoon|evening)\b/i;
const FRACTION_RE = /\b(half|quarter)\s+(past|to)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
const BARE_HOUR_RE = /\bat\s+(\d{1,2})\b(?!\s*[:.]?\d)/i;
const WORD_NUM = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12 };
const RECUR_RE = /\b(every|each)\s+(week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|day)\b|\bweekly\b|\brecurring\b/i;
const MONTH_RE = new RegExp("\\b("+MON.join("|")+"|"+MON.map(m=>m.slice(0,3)).join("|")+")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b","i");
const DOW_RE = /\b(?:(next|this|coming)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)\b/i;
const NUMDATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
const REL_RE = /\b(today|tonight|tomorrow|tmrw|day after tomorrow|next week)\b/i;

function extractDateTime(text, now = new Date()){
  let rest = " " + text + " ";
  let date=null, hasDate=false, hasTime=false, hour=null, min=0, ambiguousWeekday=false;
  let guessedMeridiem = false;

  /* Times, most specific phrasing first. */
  const pod = rest.match(PART_OF_DAY_RE);          // "3 in the afternoon"
  const frac = rest.match(FRACTION_RE);            // "half past four"
  const named = rest.match(NAMED_TIME_RE);         // "noon"
  const tm = rest.match(TIME_RE);                  // "4pm", "at 16:30"

  if (pod){
    hour = parseInt(pod[1],10); min = pod[2] ? parseInt(pod[2],10) : 0;
    const part = pod[3].toLowerCase();
    if (part === "morning"){ if (hour === 12) hour = 0; }
    else if (hour < 12) hour += 12;                // afternoon / evening
    hasTime = true; rest = rest.replace(pod[0], " ");
  } else if (frac){
    const base = WORD_NUM[frac[3].toLowerCase()] ?? parseInt(frac[3],10);
    const mins = frac[1].toLowerCase() === "half" ? 30 : 15;
    if (frac[2].toLowerCase() === "past"){ hour = base; min = mins; }
    else { hour = base - 1; min = 60 - mins; }
    if (hour < 0) hour = 23;
    hasTime = true; guessedMeridiem = true;        // "half past four" — am or pm?
    rest = rest.replace(frac[0], " ");
  } else if (named){
    const w = named[1].toLowerCase();
    hour = w === "midnight" ? 0 : 12; min = 0;
    hasTime = true; rest = rest.replace(named[0], " ");
  } else if (tm){
    if (tm[1]!==undefined){
      hour=parseInt(tm[1],10); min=tm[2]?parseInt(tm[2],10):0;
      const ap=(tm[3]||"").toLowerCase().replace(/\./g,"");
      if (ap.startsWith("p")&&hour<12) hour+=12;
      if (ap.startsWith("a")&&hour===12) hour=0;
    } else { hour=parseInt(tm[4],10); min=parseInt(tm[5],10); }
    hasTime=true; rest=rest.replace(tm[0]," ");
  } else {
    const bare = rest.match(BARE_HOUR_RE);         // "at 4"
    if (bare){
      hour = parseInt(bare[1],10); min = 0;
      if (hour >= 0 && hour <= 23){
        hasTime = true; guessedMeridiem = true;
        rest = rest.replace(bare[0], " ");
      } else hour = null;
    }
  }

  // "at 4" and "half past four" don't say am or pm. Coaching happens in
  // daylight, so prefer the reading that lands in waking hours.
  if (guessedMeridiem && hour !== null && hour >= 1 && hour <= 11){
    const pm = hour + 12;
    if (pm >= 12 && pm <= 20) hour = pm;           // 1–8 -> 13–20
  }

  const rel=rest.match(REL_RE), mo=rest.match(MONTH_RE), nd=rest.match(NUMDATE_RE), dw=rest.match(DOW_RE);

  if (rel){
    const w=rel[1].toLowerCase(); date=startOfDay(now);
    if (w==="tomorrow"||w==="tmrw") date.setDate(date.getDate()+1);
    else if (w==="day after tomorrow") date.setDate(date.getDate()+2);
    else if (w==="next week") date.setDate(date.getDate()+7);
    if (w==="tonight"&&!hasTime){ hour=19; min=0; hasTime=true; }
    hasDate=true; rest=rest.replace(rel[0]," ");
  } else if (mo){
    const idx=MON.findIndex(m=>m.toLowerCase().startsWith(mo[1].toLowerCase().slice(0,3)));
    date=new Date(now.getFullYear(), idx, parseInt(mo[2],10));
    if (date<startOfDay(now) && (startOfDay(now)-date)>180*864e5) date.setFullYear(date.getFullYear()+1);
    hasDate=true; rest=rest.replace(mo[0]," ");
  } else if (nd){
    let y=nd[3]?parseInt(nd[3],10):now.getFullYear(); if (y<100) y+=2000;
    date=new Date(y, parseInt(nd[1],10)-1, parseInt(nd[2],10));
    hasDate=true; rest=rest.replace(nd[0]," ");
  } else if (dw){
    const qual=(dw[1]||"").toLowerCase();
    const target=DOW.findIndex(d=>d.toLowerCase().startsWith(dw[2].toLowerCase().slice(0,3)));
    date=startOfDay(now);
    let delta=(target-date.getDay()+7)%7;
    if (delta===0) delta=7;                       // "monday" on a Monday means next Monday
    if (qual==="next" && delta<7) delta+=7;
    // "next Tuesday" is genuinely ambiguous in English. We resolve it as
    // the Tuesday after this coming one and flag it so the card can say so.
    if (qual==="next") ambiguousWeekday=true;
    date.setDate(date.getDate()+delta);
    hasDate=true; rest=rest.replace(dw[0]," ");
  }

  if (hasTime && !hasDate){
    date=startOfDay(now);
    const cand=new Date(date); cand.setHours(hour,min,0,0);
    if (cand<now) date.setDate(date.getDate()+1);
    hasDate=true;
  }
  if (date && hasTime) date.setHours(hour,min,0,0);
  else if (date) date.setHours(9,0,0,0);

  return { date, hasDate, hasTime, ambiguousWeekday, guessedMeridiem,
           rest: rest.replace(/\s+/g," ").trim() };
}

/** "for an hour", "90 minutes", "hour and a half", "half hour". */
function extractDuration(text){
  const t = text.toLowerCase();
  let m = t.match(/\b(\d{1,3})\s*(?:min|mins|minute|minutes)\b/);
  if (m) return { minutes: parseInt(m[1],10), text: text.replace(m[0], " ") };

  m = t.match(/\b(?:an?\s+)?hour\s+and\s+a\s+half\b/);
  if (m) return { minutes: 90, text: text.replace(m[0], " ") };

  m = t.match(/\bhalf\s+(?:an\s+)?hour\b/);
  if (m) return { minutes: 30, text: text.replace(m[0], " ") };

  m = t.match(/\b(\d{1,2}(?:\.\d)?|an?|one|two|three|four)\s*(?:hour|hr)s?\b/);
  if (m){
    const w = m[1];
    const n = /^an?$/.test(w) ? 1 : (WORD_NUM[w] ?? parseFloat(w));
    if (Number.isFinite(n)) return { minutes: Math.round(n * 60), text: text.replace(m[0], " ") };
  }
  return { minutes: null, text };
}

/* ---------- 6. INTENT PARSER ------------------------------------------
   Rules, not an LLM: no key, no latency, no per-command cost, works
   offline. Isolated behind parseCommand() so a model can replace it
   without touching the confirmation layer.
--------------------------------------------------------------------- */
const DESTRUCTIVE = new Set(["cancel_event"]);

/* Every natural way a coach might introduce a new person. Deliberately
   generous — a false positive lands on an editable card, a false negative
   lands on "not quite", and the first is much cheaper than the second. */
const CLIENT_NOUN = "(?:client|student|athlete|player|customer)";
const CLIENT_TRIGGER = new RegExp(
  "^(?:" +
    // "I have", "I've got", "I'm working with", "there's", "we have"
    "(?:i(?:\\s*'?ve|\\s+have|\\s+had|\\s*'m|\\s+am)?(?:\\s+(?:got|taken\\s+on|working\\s+with|coaching))?" +
      "|there'?s|this\\s+is|we(?:'ve|\\s+have)?)" +
      "\\s+(?:a|an|my|another)?\\s*(?:new\\s+)?" + CLIENT_NOUN +
  "|" +
    "(?:add|create|new|make|set\\s*up|setup|register|sign\\s*up|start|onboard|take\\s+on|log)" +
      "\\s+(?:a|an|my|another)?\\s*(?:new\\s+)?" + CLIENT_NOUN +
  "|" +
    "my\\s+(?:new\\s+)?" + CLIENT_NOUN +
  ")\\b[\\s,:;-]*(?:named|called|is|by\\s+the\\s+name\\s+of)?[\\s,:;-]*",
  "i"
);

/* "his name is Marcus Bell" — an explicit label beats positional guessing. */
const EXPLICIT_NAME_RE = /\b(?:(?:his|her|their|the)\s+)?name(?:'s|\s+is)\s+([\p{L}][\p{L}\s'’.-]*)/iu;

function parseCommand(text, now = new Date()){
  const raw = String(text||"").trim();
  if (!raw) return { intent:"unknown", raw };
  const t = raw.replace(/\s+/g," "), low = t.toLowerCase();

  let m = low.match(/^(?:add\s+(?:a\s+)?)?(?:note|log|record|remember)\s+(?:that\s+)?(?:for|on|about|to)\s+(.+?)\s*(?::|--|-\s|,\s*)\s*(.+)$/i);
  if (!m) m = low.match(/^(?:add\s+(?:a\s+)?)?(?:note|log)\s+(?:for|on|about)\s+(\S+(?:\s+\S+)?)\s+(.+)$/i);
  if (m){
    const idx = t.toLowerCase().indexOf(m[2]);
    return { intent:"add_note", raw:t, clientQuery:m[1].trim(), text:(idx>=0?t.slice(idx):m[2]).trim() };
  }

  if (/^(cancel|delete|remove|call off)/.test(low)){
    m = low.match(/^(?:cancel|delete|remove|call off)\s+(?:the\s+|my\s+)?(?:lesson|session|meeting|appointment|practice|event|class)?\s*(?:with|for)?\s*(.*)$/i);
    const dt = extractDateTime((m&&m[1])||"", now);
    return { intent:"cancel_event", raw:t, clientQuery:dt.rest.replace(/^(on|at|the)\s+/,"").trim(), when:dt.date, hasDate:dt.hasDate };
  }

  m = low.match(/^(?:add|record)\s+(?:a\s+|an\s+|my\s+)?(certification|certificate|cert|credential|license|specialty|speciality|skill|experience|role|position|job|testimonial|review|quote)\s*(?:of|for|:)?\s+(.+)$/i);
  if (m){
    const k = m[1].toLowerCase();
    const kind = /cert|credential|license/.test(k) ? "certification"
               : /special|skill/.test(k) ? "specialty"
               : /testimonial|review|quote/.test(k) ? "testimonial" : "experience";
    const idx = t.toLowerCase().lastIndexOf(m[2]);
    return { intent:"add_resume_item", raw:t, kind, value:(idx>=0?t.slice(idx):m[2]).trim() };
  }

  /* --- new client, said however it comes out ------------------------- */
  const trig = t.match(CLIENT_TRIGGER);
  if (trig){
    let body = t.slice(trig[0].length);

    // Peel entities off wherever they sit, then read the name from the rest.
    const e = takeEmail(body);       body = e.text;
    const p = takePhone(body);       body = p.text;
    const a = takeAge(body);         body = a.text;
    const g = takeTags(body);        body = g.text;

    const name = extractName(body);
    const out = {
      intent: "add_client", raw: t,
      name,
      phone: p.value || "",
      email: e.value || "",
      age: a.value,
      tags: g.value.map(s => s.toLowerCase()),
      // An age under 18 turns on the guardian and consent fields rather
      // than leaving it to be noticed later.
      isMinor: a.value != null && a.value < 18
    };
    if (!name) out.needsName = true;
    return out;
  }

  /* --- schedule ------------------------------------------------------ */
  const isSched = /^(schedule|book|set\s*up|setup|add|put|create|new|plan|pencil|arrange|slot|pop)\b/.test(low)
               || /\b(lesson|session|practice|training|meeting|appointment|class|game|match)\b/.test(low);
  if (isSched){
    const dt = extractDateTime(t, now);
    const dur = extractDuration(dt.rest);
    let r = dur.text;

    const kindM = r.match(/\b(lesson|session|practice|training|meeting|appointment|class|game|match)\b/i);
    const title = kindM ? kindM[1][0].toUpperCase()+kindM[1].slice(1).toLowerCase() : "Session";

    let location = "";
    const locM = r.match(/\b(?:at|in|on)\s+((?:court|field|room|rink|pitch|studio|lane)\s*\w+|zoom|online|the\s+gym|the\s+park|the\s+pool|the\s+club|the\s+track)\b/i);
    if (locM){ location = locM[1].replace(/^the\s+/i,"").trim(); r = r.replace(locM[0]," "); }

    // Strip the sport too — "a tennis lesson" describes the session, not a person.
    r = takeTags(r).text
         .replace(/^(schedule|book|set\s*up|setup|add|put|create|new|plan|pencil\s*in|pencil|arrange|slot\s*in|pop\s*in)\s+/i," ")
         .replace(/\b(lesson|session|practice|training|meeting|appointment|class|game|match)\b/gi," ")
         .replace(FILLER, " ")
         .replace(/\s+/g, " ").trim();

    const withM = r.match(/\b(?:with|for)\s+(.+)$/i);
    const clientQuery = bestClientQuery([withM ? withM[1] : "", r]);

    return {
      intent:"add_event", raw:t, title, clientQuery,
      when:dt.date, hasDate:dt.hasDate, hasTime:dt.hasTime,
      ambiguousWeekday:dt.ambiguousWeekday, guessedMeridiem:dt.guessedMeridiem,
      recurring: RECUR_RE.test(low),
      location, durationMin: dur.minutes || 60
    };
  }

  return { intent:"unknown", raw:t };
}

/* Future swap-in — identical return shape, so nothing downstream changes:
   async function parseCommandRemote(text){
     const r = await api("/api/parse", {method:"POST", body:JSON.stringify({text})});
     return r; // {intent, clientQuery?, when?, ...}
   }
*/

/* ---------- 7. CONFIRMATION LAYER -------------------------------------
   Voice never writes straight to the store. Everything lands here first
   with every field editable. Slower than "just do it" by a couple of
   seconds, but a misheard name can't quietly cancel a real lesson.
--------------------------------------------------------------------- */
let pending = null;

function showConfirm(p){
  pending = p;
  const slot = $("#confirmSlot");
  if (!p){ slot.innerHTML=""; return; }

  if (p.intent === "unknown"){
    const heardSomething = !!(p.raw || "").trim();
    slot.innerHTML = `<div class="confirm">
      <div class="kicker">Couldn't understand that</div>
      ${heardSomething ? `<div class="heard">${esc(p.raw)}</div>` : ""}
      <div class="sm muted" style="margin-bottom:16px">
        ${heardSomething
          ? "Not sure what you meant by that. Try saying it again, a bit slower."
          : "Didn't hear anything. Have another go."}
      </div>
      <div class="row" style="gap:9px">
        <button class="btn" id="uRetry">Try again</button>
        <button class="btn quiet" id="uExamples">Show examples</button>
        <button class="btn quiet" onclick="dismissConfirm()">Dismiss</button>
      </div>
      <div id="uSamples" class="hidden" style="margin-top:14px">
        <div class="xs faint" style="margin-bottom:6px">Tap one to try it:</div>
        ${["I have a new client Ryan Cole for golf, he's 27, 555-018-8100",
           "Schedule a lesson with Emma tomorrow at half past four",
           "Note for Emma: great progress on her serve today",
           "Add certification Level 2 Instructor"]
          .map(s=>`<span class="sample" onclick="tryExample(this.textContent)">${esc(s)}</span>`).join("")}
      </div>
    </div>`;
    $("#uRetry").onclick = retryVoice;
    $("#uExamples").onclick = e => {
      $("#uSamples").classList.toggle("hidden");
      e.target.textContent = $("#uSamples").classList.contains("hidden") ? "Show examples" : "Hide examples";
    };
    return;
  }

  const matches = p.clientQuery ? matchClients(p.clientQuery) : [];
  const ambiguous = matches.length > 1;
  const noMatch = !!p.clientQuery && matches.length === 0;
  if (matches.length === 1 && !p.clientId) p.clientId = matches[0].id;

  const picker = (label, required) => `<label class="fld"><span>${label}</span>
    <select id="pfClient">${required?"":`<option value="">— none —</option>`}
    ${clients().map(c=>`<option value="${c.id}" ${p.clientId===c.id?"selected":""}>${esc(c.name)}</option>`).join("")}
    </select></label>`;

  let body="", notice="", noticeBad=false;

  if (p.intent === "add_client"){
    const dupes = p.name ? matchClients(p.name) : [];
    if (p.needsName || !p.name){
      notice = "Couldn't pick out a name from that — type it in below."; noticeBad = true;
    } else if (dupes.length){
      notice = `You already have <strong>${esc(dupes[0].name)}</strong>. Saving creates a second record.`;
    }
    const minor = p.age != null && p.age < 18;
    if (minor) {
      notice = `${esc(p.name || "This client")} is ${p.age}. Records about a minor need a guardian contact and consent — fill those in below.`;
      noticeBad = true;
    }
    body = `<div class="grid2">
      <label class="fld"><span>Name</span><input id="pfName" type="text" value="${esc(p.name||"")}" placeholder="Full name"></label>
      <label class="fld"><span>Phone</span><input id="pfPhone" type="tel" value="${esc(p.phone)}"></label>
      <label class="fld"><span>Email</span><input id="pfEmail" type="email" value="${esc(p.email)}"></label>
      <label class="fld"><span>Age</span><input id="pfAge" type="text" inputmode="numeric" value="${p.age ?? ""}" placeholder="Optional"></label>
    </div>
    <label class="fld"><span>Tags</span><input id="pfTags" type="text" value="${esc(p.tags.join(", "))}" placeholder="sport, level — comma separated"></label>
    ${minor ? `<div class="grid2">
      <label class="fld"><span>Guardian name</span><input id="pfGName" type="text"></label>
      <label class="fld"><span>Guardian contact</span><input id="pfGContact" type="text" placeholder="Phone or email"></label>
    </div>
    <label class="check" style="margin:-4px 0 12px">
      <input type="checkbox" id="pfConsent">
      <span>Guardian consent has been obtained</span>
    </label>` : ""}`;
  }

  else if (p.intent === "add_event"){
    const when = p.when || (()=>{ const d=new Date(); d.setHours(d.getHours()+1,0,0,0); return d; })();
    const li = toLocalInput(when);
    if (!p.hasDate){ notice = "No date heard — defaulted to the next hour. Check it before saving."; }
    else if (!p.hasTime){ notice = "No time heard — defaulted to 9:00am."; }
    else if (p.ambiguousWeekday){ notice = `Read as <strong>${esc(fmtDay(when))}</strong>. “Next” weekday is ambiguous — adjust if you meant the earlier one.`; }
    else if (p.guessedMeridiem){ notice = `Read as <strong>${esc(fmtTime(when))}</strong> — you didn't say am or pm. Change it if that's wrong.`; }
    if (p.recurring){
      notice = "<strong>Repeating lessons aren't supported yet.</strong> This saves the first one only — add the rest individually.";
      noticeBad = true;
    }
    if (noMatch){ notice = `No client matches “${esc(p.clientQuery)}”. Pick one, or save without and link it later.`; noticeBad = true; }
    else if (ambiguous){ notice = `“${esc(p.clientQuery)}” matches ${matches.length} clients. Confirm which.`; noticeBad = true; }
    body = `<label class="fld"><span>Title</span><input id="pfTitle" type="text" value="${esc(p.title)}"></label>
      ${picker("Client", false)}
      <div class="grid2">
        <label class="fld"><span>Date</span><input id="pfDate" type="date" value="${li.date}"></label>
        <label class="fld"><span>Time</span><input id="pfTime" type="time" value="${li.time}"></label>
        <label class="fld"><span>Minutes</span><input id="pfDur" type="text" inputmode="numeric" value="${p.durationMin||60}"></label>
        <label class="fld"><span>Location</span><input id="pfLoc" type="text" value="${esc(p.location||"")}"></label>
      </div>`;
  }

  else if (p.intent === "add_note"){
    if (noMatch){ notice = `No client matches “${esc(p.clientQuery)}”. Choose who this belongs to.`; noticeBad = true; }
    else if (ambiguous){ notice = `“${esc(p.clientQuery)}” matches ${matches.length} clients. Confirm which.`; noticeBad = true; }
    body = `${picker("Client", true)}
      <label class="fld"><span>Note</span><textarea id="pfNote">${esc(p.text)}</textarea></label>`;
  }

  else if (p.intent === "add_resume_item"){
    const L = { certification:"Certification", specialty:"Specialty", testimonial:"Testimonial", experience:"Experience" };
    body = `<label class="fld"><span>Type</span><select id="pfKind">
        ${Object.keys(L).map(k=>`<option value="${k}" ${p.kind===k?"selected":""}>${L[k]}</option>`).join("")}
      </select></label>
      <label class="fld"><span>Details</span><input id="pfVal" type="text" value="${esc(p.value)}"></label>`;
  }

  else if (p.intent === "cancel_event"){
    const cands = cancelCandidates(p);
    if (!cands.length){
      slot.innerHTML = `<div class="confirm"><div class="kicker">Nothing to cancel</div>
        <div class="heard">${esc(p.raw)}</div>
        <div class="sm muted" style="margin-bottom:14px">No upcoming event matched that.</div>
        <button class="btn ghost s" onclick="dismissConfirm()">Dismiss</button></div>`;
      return;
    }
    notice = "This removes the event for good."; noticeBad = true;
    body = `<label class="fld"><span>Cancel which?</span><select id="pfEvent">
      ${cands.map(e=>`<option value="${e.id}">${esc(e.title)}${e.clientId?" — "+esc(clientName(e.clientId)):""} · ${esc(fmtDT(e.start))}</option>`).join("")}
    </select></label>`;
  }

  const titles = { add_client:"Add client", add_event:"Schedule", add_note:"Add note",
                   add_resume_item:"Add to profile", cancel_event:"Cancel event" };
  const destructive = DESTRUCTIVE.has(p.intent);

  slot.innerHTML = `<div class="confirm">
    <div class="kicker">${titles[p.intent]||"Confirm"}${p.fromAI?' <span class="faint" style="font-weight:500;letter-spacing:0;text-transform:none">· interpreted by AI</span>':""}</div>
    <div class="heard">${esc(p.raw)}</div>
    <div class="suggest">This is what it made of that. Change anything that's off, or say it again.</div>
    ${notice?`<div class="notice${noticeBad?" bad":""}">${notice}</div>`:""}
    ${body}
    <div class="row" style="gap:9px;margin-top:6px">
      <button class="btn ${destructive?"danger":""}" id="pfOk">${destructive?"Cancel event":"Save"}</button>
      <button class="btn quiet" id="pfRetry">Say it again</button>
      <button class="btn quiet" onclick="dismissConfirm()">Discard</button>
    </div>
  </div>`;
  $("#pfRetry").onclick = retryVoice;
  $("#pfOk").onclick = commitPending;
  const f = slot.querySelector("input,select,textarea"); if (f) f.focus();
}

function dismissConfirm(){ pending=null; $("#confirmSlot").innerHTML=""; }
function tryExample(text){ $("#cmd").value = text; submitCommand(text); }

/** Clear the failed attempt and reopen the mic straight away. */
function retryVoice(){
  dismissConfirm();
  const input = $("#cmd");
  input.value = "";
  micPrefix = "";
  if (recog && !listening){
    try { recog.start(); return; } catch(e){ /* fall through to typing */ }
  }
  input.focus();
}

/* ---------- 7b. STRAIGHT INTO SCHEDULING ------------------------------
   A coach who has just added someone almost always wants to book them in
   next. Rather than making them find the calendar and repeat the name,
   offer it immediately and carry the name across.
--------------------------------------------------------------------- */
function offerLessons(client){
  const first = client.name.split(" ")[0];
  $("#confirmSlot").innerHTML = `<div class="confirm">
    <div class="kicker">${esc(client.name)} added</div>
    <div class="sm muted" style="margin-bottom:14px">Book their first lesson while you're here?</div>
    <div class="row" style="gap:9px">
      <button class="btn" id="okLessons">Schedule lessons</button>
      <button class="btn quiet" onclick="dismissConfirm()">Not now</button>
    </div>
  </div>`;
  $("#okLessons").onclick = () => startScheduling(client);
}

/** Switch to the calendar and prime the command bar for this client. */
function startScheduling(client){
  dismissConfirm();
  goTab("calendar");
  const input = $("#cmd");
  input.value = `Schedule a lesson with ${client.name} `;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  $("#hint").textContent = `Now say when — “tomorrow at 4pm”, “Tuesday at half past three”`;
  // Speaking is the point, so open the mic rather than waiting for a tap.
  if (recog && !listening){
    micPrefix = input.value;          // keep the name, append what's spoken
    try { recog.start(); } catch(e){ /* the typed path still works */ }
  }
}

function cancelCandidates(p){
  const now = Date.now();
  let list = events().filter(e => new Date(e.start).getTime() > now - 3600e3);
  if (p.clientQuery){
    const ids = matchClients(p.clientQuery).map(c=>c.id);
    if (ids.length) list = list.filter(e => ids.includes(e.clientId));
  }
  if (p.hasDate && p.when) list = list.filter(e => sameDay(e.start, p.when));
  return list.sort((a,b)=>new Date(a.start)-new Date(b.start)).slice(0,12);
}

function commitPending(){
  if (!pending) return;
  const p = pending, v = id => { const el=$("#"+id); return el?el.value.trim():""; };

  if (p.intent === "add_client"){
    const name = v("pfName"); if (!name) return toast("Name is required");
    const age = parseInt(v("pfAge"), 10);
    const minor = Number.isFinite(age) && age < 18;

    if (minor && (!v("pfGName") || !v("pfGContact")))
      return toast("Guardian name and contact are required for a client under 18");

    const rec = { id:uid(), name, phone:v("pfPhone"), email:v("pfEmail"),
      tags:v("pfTags").split(",").map(s=>s.trim()).filter(Boolean),
      fields: Number.isFinite(age) ? { Age: String(age) } : {},
      isMinor: minor,
      guardian: minor ? { name:v("pfGName"), contact:v("pfGContact") } : null,
      consent: minor
        ? ($("#pfConsent")?.checked
            ? { obtained:true, at:nowIso(), method:"Verbal" }
            : { obtained:false })
        : null,
      notes:[], created:nowIso(), deleted:false };

    S.clients.push(rec); touch("client", rec);
    toast(`${name} added`);
    dismissConfirm(); render();
    offerLessons(rec);          // straight on to booking them in
    return;
  }
  else if (p.intent === "add_event"){
    const d=v("pfDate"); if (!d) return toast("Pick a date");
    const rec = { id:uid(), title:v("pfTitle")||"Session", clientId:v("pfClient")||null,
      start:fromLocalInput(d, v("pfTime")), durationMin:parseInt(v("pfDur"),10)||60,
      location:v("pfLoc"), notes:"", source:"local", deleted:false };
    S.events.push(rec); touch("event", rec);
    toast("Scheduled");
  }
  else if (p.intent === "add_note"){
    const cid=v("pfClient"), text=v("pfNote");
    if (!cid) return toast("Pick a client");
    if (!text) return toast("Note is empty");
    const c = clientById(cid);
    c.notes.unshift({ id:uid(), at:nowIso(), text });
    touch("client", c);
    toast(`Note added to ${c.name}`);
  }
  else if (p.intent === "add_resume_item"){
    const kind=v("pfKind"), val=v("pfVal");
    if (!val) return toast("Nothing to add");
    if (kind==="specialty") S.profile.specialties.push(val);
    else if (kind==="certification") S.profile.certifications.push({ id:uid(), name:val, issuer:"", year:"" });
    else if (kind==="testimonial") S.profile.testimonials.push({ id:uid(), quote:val, author:"" });
    else S.profile.experience.push({ id:uid(), role:val, org:"", period:"", detail:"" });
    touch("profile", S.profile);
    toast("Added to profile");
  }
  else if (p.intent === "cancel_event"){
    const e = S.events.find(x=>x.id===v("pfEvent"));
    if (e){ e.deleted = true; touch("event", e); toast(`${e.title} cancelled`); }
  }

  dismissConfirm(); render();
}

/* ---------- 8. VOICE ---------------------------------------------------
   Web Speech API where available. The text field is not a fallback for
   unsupported browsers — it's a first-class path, because gyms and pool
   decks defeat speech recognition routinely.
--------------------------------------------------------------------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const HINT = "Try “I have a new client Ryan Cole, golf, he's 27, 555-018-8100”";
let recog=null, listening=false;
// Text already in the box when the mic opens — speech is appended to it,
// so a pre-filled client name survives dictation.
let micPrefix = "";

function initVoice(){
  const btn=$("#mic"), input=$("#cmd");
  $("#hint").textContent = HINT;

  if (!SR){
    btn.disabled = true;
    btn.title = "Voice needs Chrome, Edge or Safari";
    $("#hint").textContent = "Voice needs Chrome, Edge or Safari — typing works everywhere.";
  } else {
    recog = new SR();
    recog.continuous = false; recog.interimResults = true;
    recog.lang = navigator.language || "en-US";
    recog.onstart = () => { listening=true; btn.classList.add("live"); $("#hint").textContent="Listening…"; };
    recog.onend = () => {
      listening=false; btn.classList.remove("live"); $("#hint").textContent=HINT;
      const val = input.value.trim();
      const prefix = micPrefix.trim();
      micPrefix = "";
      // Nothing but the pre-filled prefix means we heard no speech —
      // submitting that would just produce a useless card.
      if (val && val !== prefix) submitCommand(val);
    };
    recog.onerror = e => {
      listening=false; btn.classList.remove("live");
      toast(e.error==="not-allowed" ? "Microphone blocked — check browser permissions."
          : e.error==="no-speech" ? "Didn't hear anything. Try again."
          : "Voice error: "+e.error);
    };
    recog.onresult = e => {
      let s=""; for (let i=e.resultIndex;i<e.results.length;i++) s += e.results[i][0].transcript;
      input.value = micPrefix + s;
    };
    btn.onclick = () => {
      if (listening){ recog.stop(); return; }
      micPrefix = "";                 // a plain tap starts fresh
      input.value = "";
      try { recog.start(); } catch(err){ toast("Couldn't start the mic"); }
    };
  }

  input.addEventListener("keydown", e => {
    if (e.key==="Enter"){ e.preventDefault(); const v=input.value.trim(); if (v) submitCommand(v); }
    if (e.key==="Escape"){ input.value=""; dismissConfirm(); }
  });
}
/* Rules first — instant, free, offline. Only when they give up do we ask
   the server, and only if an API key is configured there. */
let aiAvailable = null;   // null = unknown, checked lazily once

async function submitCommand(text){
  $("#cmd").value = "";
  const local = parseCommand(text);
  if (local.intent !== "unknown"){ showConfirm(local); return; }

  if (aiAvailable === false){ showConfirm(local); return; }

  showThinking(text);
  try {
    const r = await api("/api/parse", { method:"POST", body: JSON.stringify({
      text, clientNames: clients().map(c => c.name)
    })});
    if (r.source === "not_configured"){ aiAvailable = false; showConfirm(local); return; }
    aiAvailable = true;
    if (r.intent === "unknown"){ showConfirm(local); return; }
    showConfirm(fromAI(r, text));
  } catch(e){
    showConfirm(local);      // offline or signed out — the rules card still helps
  }
}

/* ---------- DOCK CLEARANCE -------------------------------------------
   The voice dock is fixed to the bottom and its height swings from about
   120px (just the input) to several hundred (a confirmation card with
   guardian fields). A hardcoded padding-bottom on <main> meant the last
   card was cut off and unreachable whenever the dock grew.

   So measure it and publish the value as --dock-h. A ResizeObserver
   catches every cause at once: cards opening and closing, text wrapping,
   the window resizing, the on-screen keyboard appearing.
--------------------------------------------------------------------- */
function measureDock(){
  const dock = $(".dock");
  if (!dock) return;
  const h = dock.offsetHeight;
  if (h > 0) document.documentElement.style.setProperty("--dock-h", h + "px");
}

function watchDock(){
  const dock = $(".dock");
  if (!dock) return;
  measureDock();
  if (typeof ResizeObserver === "function"){
    new ResizeObserver(measureDock).observe(dock);
  } else {
    window.addEventListener("resize", measureDock);   // older browsers
    setInterval(measureDock, 1000);
  }
  window.addEventListener("orientationchange", () => setTimeout(measureDock, 150));
}

function showThinking(text){
  $("#confirmSlot").innerHTML = `<div class="confirm">
    <div class="kicker">Working that out…</div>
    <div class="heard">${esc(text)}</div>
  </div>`;
}

/** Normalise the AI's shape into what showConfirm already expects. */
function fromAI(r, raw){
  const p = { intent: r.intent, raw, fromAI: true };
  if (r.intent === "add_client"){
    Object.assign(p, { name:r.name||"", phone:r.phone||"", email:r.email||"",
      age:r.age ?? null, tags:r.tags||[], isMinor:!!r.isMinor, needsName:!r.name });
  } else if (r.intent === "add_event"){
    const when = r.startISO ? new Date(r.startISO) : null;
    Object.assign(p, { title:r.title||"Session", clientQuery:r.clientQuery||"",
      when, hasDate:!!when, hasTime:!!when,
      durationMin:r.durationMin||60, location:r.location||"" });
  } else if (r.intent === "add_note"){
    Object.assign(p, { clientQuery:r.clientQuery||"", text:r.text||"" });
  } else if (r.intent === "add_resume_item"){
    Object.assign(p, { kind:r.kind||"certification", value:r.value||"" });
  } else if (r.intent === "cancel_event"){
    const when = r.startISO ? new Date(r.startISO) : null;
    Object.assign(p, { clientQuery:r.clientQuery||"", when, hasDate:!!when });
  }
  return p;
}

/* ---------- 9. SHEET (modal) ------------------------------------------ */
function openSheet(title, html, onMount){
  $("#sheet").innerHTML = `<div class="grip no-print"></div>
    <div class="sheet-head no-print"><h3>${esc(title)}</h3><button class="x" onclick="closeSheet()">&times;</button></div>${html}`;
  $("#scrim").classList.add("on");
  document.body.style.overflow = "hidden";
  if (onMount) onMount($("#sheet"));
}
function closeSheet(){
  $("#scrim").classList.remove("on"); $("#sheet").innerHTML="";
  document.body.style.overflow = "";
}
$("#scrim").addEventListener("click", e => { if (e.target.id==="scrim") closeSheet(); });
document.addEventListener("keydown", e => { if (e.key==="Escape") closeSheet(); });

const ICON = {
  users:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>`,
  cal:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  doc:`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8"/></svg>`
};

/* ---------- 10. CLIENTS ----------------------------------------------- */
let clientFilter = "";

function renderClients(){
  const q = norm(clientFilter);
  const list = clients()
    .filter(c => !q || norm(c.name).includes(q) || (c.tags||[]).some(t=>norm(t).includes(q)))
    .sort((a,b)=>a.name.localeCompare(b.name));

  const rows = list.map(c => {
    const next = events().filter(e=>e.clientId===c.id && new Date(e.start)>=startOfDay(new Date()))
                         .sort((a,b)=>new Date(a.start)-new Date(b.start))[0];
    const sub = next ? "Next · " + fmtDT(next.start)
              : (c.notes||[]).length ? `${c.notes.length} note${c.notes.length>1?"s":""}`
              : "No sessions yet";
    return `<div class="card tight tap" onclick="openClient('${c.id}')">
      <div class="row">
        <div class="avatar">${esc(initials(c.name))}</div>
        <div class="grow">
          <div class="truncate" style="font-weight:600">${esc(c.name)}</div>
          <div class="xs muted truncate">${needsConsent(c)?'<span class="warn-dot">●</span> ':""}${esc(sub)}</div>
        </div>
        ${(c.tags||[]).slice(0,2).map(t=>`<span class="chip">${esc(t)}</span>`).join("")}
      </div></div>`;
  }).join("");

  // One quiet banner rather than a warning on every affected row.
  const gaps = clients().filter(needsConsent).length;

  $("#view-clients").innerHTML = `
    <div class="row" style="margin:4px 0 14px;gap:9px">
      <input type="text" id="cSearch" placeholder="Search clients…" value="${esc(clientFilter)}">
      <button class="btn" style="flex:none" onclick="openClientEditor(null)">New</button>
    </div>
    ${gaps ? `<div class="notice bad" style="margin-bottom:12px">
      <strong>${gaps} client${gaps>1?"s":""} under 18</strong> ${gaps>1?"have":"has"} no guardian consent recorded.
    </div>` : ""}
    ${list.length ? rows : emptyClients()}`;

  const si = $("#cSearch");
  si.oninput = e => {
    clientFilter = e.target.value; renderClients();
    const n=$("#cSearch"); n.focus(); n.setSelectionRange(n.value.length,n.value.length);
  };
}

const emptyClients = () => clients().length ? `
  <div class="empty"><div class="icon">${ICON.users}</div>
    <h3>No matches</h3><p>Nothing here by that name. Try a shorter search.</p></div>`
  : `<div class="empty"><div class="icon">${ICON.users}</div>
    <h3>Let's add your first client</h3>
    <p>Tap the microphone and just say it — no particular order, no keywords to remember.</p>
    <span class="sample" onclick="tryExample(&quot;I have a client Ryan Cole for golf, he's 27, his number is 555-018-8100&quot;)">I have a client Ryan Cole for golf, he's 27, his number is 555-018-8100</span>
  </div>`;

function openClient(id){
  const c = clientById(id); if (!c) return;
  const up = events().filter(e=>e.clientId===id && new Date(e.start)>=startOfDay(new Date()))
                     .sort((a,b)=>new Date(a.start)-new Date(b.start));
  const past = events().filter(e=>e.clientId===id && new Date(e.start)<startOfDay(new Date())).length;
  const fields = Object.entries(c.fields||{});

  const cs = consentStatus(c);
  const g = c.guardian || {};

  openSheet(c.name, `
    <div class="row" style="margin-bottom:20px">
      <div class="avatar" style="width:50px;height:50px;border-radius:16px;font-size:16px">${esc(initials(c.name))}</div>
      <div class="grow">
        <div class="row wrap" style="gap:6px">
          ${isMinor(c)?`<span class="chip warn">Under 18</span>`:""}
          ${(c.tags||[]).map(t=>`<span class="chip accent">${esc(t)}</span>`).join("")}
          ${!isMinor(c)&&!(c.tags||[]).length?'<span class="xs faint">No tags</span>':""}
        </div>
        <div class="xs muted" style="margin-top:5px">${[c.phone,c.email].filter(Boolean).map(esc).join(" · ") || "No contact details"}</div>
      </div>
      <button class="btn ghost s" onclick="openClientEditor('${c.id}')">Edit</button>
    </div>

    ${cs ? `<div class="notice ${cs.ok?"good":"bad"}" style="margin-bottom:14px">
      ${cs.ok ? "" : "<strong>Action needed.</strong> "}${esc(cs.text)}.
      ${cs.ok ? "" : ` <a href="#" onclick="openClientEditor('${c.id}');return false">Record it now</a>`}
      ${g.name ? `<div style="margin-top:6px">Guardian: ${esc(g.name)}${g.contact?` · ${esc(g.contact)}`:""}</div>` : ""}
    </div>` : ""}

    ${fields.length ? `<div class="card flat" style="margin-bottom:6px">
      ${fields.map(([k,val])=>`<div class="kv"><div class="k">${esc(k)}</div><div class="grow">${esc(val)}</div></div>`).join("")}
    </div>` : ""}

    <div class="sec"><h2>Upcoming</h2><div class="rule"></div></div>
    ${up.length ? up.map(e=>`<div class="card tight flat"><div class="row">
        <div class="grow"><div style="font-weight:600">${esc(e.title)}</div>
        <div class="xs muted">${esc(fmtDT(e.start))}${e.location?" · "+esc(e.location):""}</div></div></div></div>`).join("")
      : `<div class="sm faint" style="padding:2px 2px 6px">Nothing scheduled.${past?` ${past} session${past>1?"s":""} so far.`:""}</div>`}

    <div class="sec"><h2>Notes</h2><div class="rule"></div>
      <button class="btn quiet s" onclick="addNoteTo('${c.id}')">Add</button></div>
    ${(c.notes||[]).length ? c.notes.map(n=>`<div class="note">
        <div class="meta">${esc(fmtDay(n.at))} · ${esc(fmtTime(n.at))}</div>
        <div class="sm">${esc(n.text)}</div></div>`).join("")
      : `<div class="sm faint" style="padding:2px">Nothing yet. Say “Note for ${esc(c.name.split(" ")[0])}: …”</div>`}

    <div class="sec"><h2>Record</h2><div class="rule"></div></div>
    <button class="btn ghost s" onclick="exportClient('${c.id}')">Export everything held about ${esc(c.name.split(" ")[0])}</button>
    <div class="xs faint" style="margin-top:8px;line-height:1.65">
      Notes, details and session history as one file — for when a client or guardian asks
      for a copy of what you hold.
    </div>
  `);
}

function addNoteTo(id){
  const c = clientById(id); if (!c) return;
  openSheet("Note — " + c.name, `
    <label class="fld"><span>What happened?</span><textarea id="nText" placeholder="Drills, breakthroughs, what to pick up next time…"></textarea></label>
    <div class="row" style="gap:9px"><button class="btn" id="nSave">Save</button>
      <button class="btn quiet" onclick="openClient('${id}')">Back</button></div>`,
    m => {
      m.querySelector("#nText").focus();
      m.querySelector("#nSave").onclick = () => {
        const t = m.querySelector("#nText").value.trim();
        if (!t) return toast("Note is empty");
        c.notes.unshift({ id:uid(), at:nowIso(), text:t });
        touch("client", c); render(); openClient(id); toast("Note added");
      };
    });
}

const fieldRow = (k,v) => `<div class="row fieldrow" style="gap:8px;margin-bottom:8px">
  <input class="fk" type="text" placeholder="Field" value="${esc(k)}" style="flex:0 0 38%">
  <input class="fv" type="text" placeholder="Value" value="${esc(v)}">
  <button class="x" onclick="this.parentNode.remove()">&times;</button></div>`;

/* ---------- 10b. UNDER-18 CLIENTS -------------------------------------
   Data-protection duties attach to the person the record is *about*, not
   the coach holding it. So a client marked under 18 asks for a guardian
   contact and whether consent was actually obtained — and says so plainly
   on the record when it wasn't, rather than letting it sit unnoticed.

   This is a prompt and a record, not a compliance product. It doesn't
   make anyone compliant on its own.
--------------------------------------------------------------------- */
const CONSENT_METHODS = ["Signed form", "Email", "Verbal", "Held by club or organisation"];

const isMinor = c => !!(c && c.isMinor);
const hasConsent = c => !!(c && c.consent && c.consent.obtained);
const needsConsent = c => isMinor(c) && !hasConsent(c);

/** Short status line used on the client sheet. */
function consentStatus(c){
  if (!isMinor(c)) return null;
  if (!hasConsent(c)) return { ok:false, text:"Guardian consent not recorded" };
  const at = c.consent.at ? fmtDay(c.consent.at) : "date not recorded";
  const how = c.consent.method ? ` · ${c.consent.method}` : "";
  return { ok:true, text:`Guardian consent recorded ${at.toLowerCase()}${how}` };
}

function minorBlock(c){
  const on = isMinor(c);
  const g = (c && c.guardian) || {};
  const con = (c && c.consent) || {};
  const at = con.at ? toLocalInput(con.at).date : new Date().toISOString().slice(0,10);
  return `
    <label class="check" style="margin:2px 0 14px">
      <input type="checkbox" id="eMinor" ${on?"checked":""}>
      <span>This client is under 18</span>
    </label>
    <div id="minorFields" class="${on?"":"hidden"}">
      <div class="notice" style="margin-bottom:14px">
        Records about a minor carry extra duties — guardian consent, retention limits, and
        the right to ask for a copy. Capture the essentials here.
      </div>
      <div class="grid2">
        <label class="fld"><span>Guardian name</span><input id="eGName" type="text" value="${esc(g.name||"")}"></label>
        <label class="fld"><span>Guardian contact</span><input id="eGContact" type="text" value="${esc(g.contact||"")}" placeholder="Phone or email"></label>
      </div>
      <label class="check" style="margin-bottom:12px">
        <input type="checkbox" id="eConsent" ${con.obtained?"checked":""}>
        <span>Guardian consent has been obtained for storing these records</span>
      </label>
      <div id="consentDetail" class="${con.obtained?"":"hidden"}">
        <div class="grid2">
          <label class="fld"><span>Date obtained</span><input id="eConsentAt" type="date" value="${at}"></label>
          <label class="fld"><span>How</span><select id="eConsentHow">
            ${CONSENT_METHODS.map(m=>`<option value="${esc(m)}" ${con.method===m?"selected":""}>${esc(m)}</option>`).join("")}
          </select></label>
        </div>
      </div>
    </div>`;
}

/** Wires the two reveal toggles inside the editor sheet. */
function bindMinorBlock(m){
  const minor = m.querySelector("#eMinor");
  const consent = m.querySelector("#eConsent");
  minor.onchange = () => m.querySelector("#minorFields").classList.toggle("hidden", !minor.checked);
  consent.onchange = () => m.querySelector("#consentDetail").classList.toggle("hidden", !consent.checked);
}

/** Reads the block back out. Returns null on a validation failure. */
function readMinorBlock(m){
  const on = m.querySelector("#eMinor").checked;
  if (!on) return { isMinor:false, guardian:null, consent:null };

  const name = m.querySelector("#eGName").value.trim();
  const contact = m.querySelector("#eGContact").value.trim();
  if (!name || !contact){
    toast("Guardian name and contact are required for a client under 18");
    return null;
  }
  const obtained = m.querySelector("#eConsent").checked;
  return {
    isMinor: true,
    guardian: { name, contact },
    consent: obtained ? {
      obtained: true,
      at: new Date(m.querySelector("#eConsentAt").value || Date.now()).toISOString(),
      method: m.querySelector("#eConsentHow").value
    } : { obtained:false }
  };
}

/** Everything held about one client, for a subject-access request. */
function exportClient(id){
  const c = clientById(id); if (!c) return;
  const payload = {
    exportedAt: nowIso(),
    client: c,
    events: events().filter(e => e.clientId === id)
      .sort((a,b)=> new Date(a.start)-new Date(b.start))
      .map(e => ({ title:e.title, start:e.start, durationMin:e.durationMin, location:e.location, notes:e.notes }))
  };
  const blob = new Blob([JSON.stringify(payload,null,2)], { type:"application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${c.name.replace(/[^\w]+/g,"-").toLowerCase()}-record.json`;
  a.click(); URL.revokeObjectURL(a.href);
  toast("Record exported");
}

function openClientEditor(id){
  const c = id ? clientById(id) : null;
  const fields = Object.entries((c&&c.fields)||{});
  openSheet(c ? "Edit client" : "New client", `
    <div class="grid2">
      <label class="fld"><span>Name</span><input id="eName" type="text" value="${esc(c?c.name:"")}"></label>
      <label class="fld"><span>Phone</span><input id="ePhone" type="tel" value="${esc(c?c.phone:"")}"></label>
      <label class="fld"><span>Email</span><input id="eEmail" type="email" value="${esc(c?c.email:"")}"></label>
      <label class="fld"><span>Tags</span><input id="eTags" type="text" value="${esc(c?(c.tags||[]).join(", "):"")}" placeholder="comma separated"></label>
    </div>
    <div class="sec"><h2>Age &amp; consent</h2><div class="rule"></div></div>
    ${minorBlock(c)}

    <div class="sec"><h2>Custom fields</h2><div class="rule"></div>
      <button class="btn quiet s" id="eAdd">Add field</button></div>
    <div class="xs faint" style="margin:-6px 0 12px">Whatever this client needs — level, event, goal, injury history.</div>
    <div id="eFields">${fields.map(([k,v])=>fieldRow(k,v)).join("")}</div>
    <div class="row" style="margin-top:18px;gap:9px">
      <button class="btn" id="eSave">Save</button><div class="grow"></div>
      ${c?`<button class="btn danger s" id="eDel">Delete</button>`:""}
    </div>`,
    m => {
      m.querySelector("#eName").focus();
      bindMinorBlock(m);
      m.querySelector("#eAdd").onclick = () => m.querySelector("#eFields").insertAdjacentHTML("beforeend", fieldRow("",""));
      m.querySelector("#eSave").onclick = () => {
        const name = m.querySelector("#eName").value.trim();
        if (!name) return toast("Name is required");
        const minor = readMinorBlock(m);
        if (!minor) return;                       // validation already reported
        const f = {};
        $$(".fieldrow", m).forEach(r => {
          const k=r.querySelector(".fk").value.trim(), v=r.querySelector(".fv").value.trim();
          if (k) f[k]=v;
        });
        const data = Object.assign({ name, phone:m.querySelector("#ePhone").value.trim(),
          email:m.querySelector("#eEmail").value.trim(),
          tags:m.querySelector("#eTags").value.split(",").map(s=>s.trim()).filter(Boolean), fields:f }, minor);
        if (c){ Object.assign(c, data); touch("client", c); render(); closeSheet(); toast("Saved"); }
        else {
          const rec = Object.assign({ id:uid(), notes:[], created:nowIso(), deleted:false }, data);
          S.clients.push(rec); touch("client", rec);
          render(); closeSheet(); toast("Client added");
          offerLessons(rec);
        }
      };
      const del = m.querySelector("#eDel");
      if (del) del.onclick = () => {
        const linked = events().filter(e=>e.clientId===c.id).length;
        if (!confirm(`Delete ${c.name}? This removes ${(c.notes||[]).length} note(s)${linked?` and unlinks ${linked} event(s)`:""}, on every device. This can't be undone.`)) return;
        c.deleted = true; touch("client", c);
        events().forEach(e => { if (e.clientId===c.id){ e.clientId=null; touch("event", e); } });
        render(); closeSheet(); toast("Client deleted");
      };
    });
}

/* ---------- 11. CALENDAR ---------------------------------------------- */
let calCursor = startOfDay(new Date());
let calSel = startOfDay(new Date());

function renderCalendar(){
  const y=calCursor.getFullYear(), mo=calCursor.getMonth();
  const pad = new Date(y,mo,1).getDay();
  const today = new Date();
  const cells = [];
  for (let i=0;i<42;i++){
    const d = new Date(y,mo,1-pad+i);
    cells.push({ d, n: events().filter(e=>sameDay(e.start,d)).length, out: d.getMonth()!==mo });
  }
  const day = events().filter(e=>sameDay(e.start,calSel)).sort((a,b)=>new Date(a.start)-new Date(b.start));
  const soon = events().filter(e=>new Date(e.start)>=startOfDay(today)).sort((a,b)=>new Date(a.start)-new Date(b.start)).slice(0,6);

  $("#view-calendar").innerHTML = `
    <div class="card" style="padding:20px">
      <div class="cal-top">
        <div class="cal-title">${MON[mo]} ${y}</div>
        <button class="nav-btn" onclick="moveMonth(-1)" aria-label="Previous month">‹</button>
        <button class="nav-btn" onclick="moveMonth(1)" aria-label="Next month">›</button>
        <button class="btn quiet s" onclick="goToday()">Today</button>
      </div>
      <div class="cal-grid">
        ${["S","M","T","W","T","F","S"].map(d=>`<div class="dow">${d}</div>`).join("")}
        ${cells.map(c=>`<button class="cell ${c.out?"out":""} ${sameDay(c.d,today)?"today":""} ${sameDay(c.d,calSel)?"sel":""}"
            onclick="selectDay('${c.d.toISOString()}')">
            <span class="n">${c.d.getDate()}</span>
            <span class="dots">${"<i></i>".repeat(Math.min(c.n,3))}</span>
          </button>`).join("")}
      </div>
    </div>

    <div class="sec"><h2>${esc(fmtDay(calSel))}</h2><div class="rule"></div>
      <button class="btn quiet s" onclick="openEventEditor(null,'${calSel.toISOString()}')">Add</button></div>
    ${day.length ? day.map(evCard).join("") : `<div class="sm faint" style="padding:2px 2px 8px">Nothing scheduled.</div>`}

    ${soon.length ? `<div class="sec"><h2>Coming up</h2><div class="rule"></div></div>${soon.map(evCard).join("")}` : ""}

    <div class="card tight" style="margin-top:22px">
      <div class="row">
        <div class="grow">
          <div class="sm" style="font-weight:600">Google Calendar</div>
          <div class="xs muted" id="gStatusLine">Checking…</div>
        </div>
        <button class="btn ghost s" onclick="googlePanel()">Manage</button>
      </div>
    </div>`;

  refreshGoogleLine();
}

const evCard = e => `<div class="card tight tap" onclick="openEventEditor('${e.id}')">
  <div class="ev">
    <div class="when"><div class="t">${esc(fmtTime(e.start))}</div><div class="d">${esc(fmtDay(e.start))}</div></div>
    <div class="spine"></div>
    <div class="grow">
      <div class="truncate" style="font-weight:600">${esc(e.title)}</div>
      <div class="xs muted truncate">${e.clientId?esc(clientName(e.clientId))+" · ":""}${e.durationMin}min${e.location?" · "+esc(e.location):""}${e.googleEventId?" · synced":""}</div>
    </div>
  </div></div>`;

function moveMonth(n){ calCursor=new Date(calCursor.getFullYear(),calCursor.getMonth()+n,1); renderCalendar(); }
function goToday(){ calCursor=startOfDay(new Date()); calSel=startOfDay(new Date()); renderCalendar(); }
function selectDay(iso){ calSel=startOfDay(new Date(iso)); renderCalendar(); }

function openEventEditor(id, defISO){
  const e = id ? events().find(x=>x.id===id) : null;
  const li = toLocalInput(e ? e.start : (defISO || new Date().toISOString()));
  if (!e && defISO) li.time = "09:00";
  openSheet(e ? "Edit event" : "New event", `
    <label class="fld"><span>Title</span><input id="vTitle" type="text" value="${esc(e?e.title:"Session")}"></label>
    <label class="fld"><span>Client</span><select id="vClient"><option value="">— none —</option>
      ${clients().map(c=>`<option value="${c.id}" ${e&&e.clientId===c.id?"selected":""}>${esc(c.name)}</option>`).join("")}
    </select></label>
    <div class="grid2">
      <label class="fld"><span>Date</span><input id="vDate" type="date" value="${li.date}"></label>
      <label class="fld"><span>Time</span><input id="vTime" type="time" value="${li.time}"></label>
      <label class="fld"><span>Minutes</span><input id="vDur" type="text" inputmode="numeric" value="${e?e.durationMin:60}"></label>
      <label class="fld"><span>Location</span><input id="vLoc" type="text" value="${esc(e?e.location:"")}"></label>
    </div>
    <label class="fld"><span>Notes</span><textarea id="vNotes">${esc(e?e.notes:"")}</textarea></label>
    <div class="row" style="gap:9px"><button class="btn" id="vSave">Save</button><div class="grow"></div>
      ${e?`<button class="btn danger s" id="vDel">Delete</button>`:""}</div>`,
    m => {
      m.querySelector("#vSave").onclick = () => {
        const d = m.querySelector("#vDate").value;
        if (!d) return toast("Pick a date");
        const data = { title:m.querySelector("#vTitle").value.trim()||"Session",
          clientId:m.querySelector("#vClient").value||null,
          start:fromLocalInput(d, m.querySelector("#vTime").value),
          durationMin:parseInt(m.querySelector("#vDur").value,10)||60,
          location:m.querySelector("#vLoc").value.trim(),
          notes:m.querySelector("#vNotes").value.trim() };
        if (e){ Object.assign(e,data); touch("event", e); }
        else { const rec=Object.assign({ id:uid(), source:"local", deleted:false }, data);
               S.events.push(rec); touch("event", rec); }
        calSel = startOfDay(new Date(data.start));
        calCursor = new Date(calSel.getFullYear(), calSel.getMonth(), 1);
        render(); closeSheet(); toast(e?"Saved":"Event added");
      };
      const del = m.querySelector("#vDel");
      if (del) del.onclick = () => {
        if (!confirm("Delete this event on every device?")) return;
        e.deleted = true; touch("event", e);
        render(); closeSheet(); toast("Event deleted");
      };
    });
}

/* ---------- 12. GOOGLE CALENDAR --------------------------------------- */
let gStatus = null;

async function refreshGoogleLine(){
  const line = $("#gStatusLine"); if (!line) return;
  if (STATIC){ line.textContent = "Needs the server, not in this demo"; return; }
  try {
    gStatus = await api("/api/google/status");
    line.textContent = !gStatus.configured ? "Not set up on this server"
      : gStatus.connected ? `Connected as ${gStatus.email || "your account"}`
      : "Not connected";
  } catch(e){ line.textContent = "Unavailable"; }
}

function googlePanel(){
  if (STATIC){
    openSheet("Google Calendar", `
      <div class="notice" style="margin-bottom:14px">Not available in the browser demo.</div>
      <div class="sm muted" style="line-height:1.75">
        Calendar sync needs a server: Google's OAuth flow requires somewhere to keep
        the client secret and refresh tokens, and a static page has neither.
        <br><br>
        It's built and working in the full version, two-way, with CoachDesk winning
        on conflict. Run the project locally and it's in <code>server/google.js</code>.
      </div>
      <div class="row" style="margin-top:16px"><button class="btn ghost" onclick="closeSheet()">Fair enough</button></div>`);
    return;
  }
  const s = gStatus || { configured:false, connected:false };
  let body;
  if (!s.configured){
    body = `<div class="notice">Google credentials aren't configured on this server.</div>
      <div class="sm muted" style="line-height:1.75">
        Add <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> to your
        <code>.env</code>, then restart. The steps are written out in
        <code>.env.example</code> — it takes about five minutes in the Google Cloud console.
      </div>`;
  } else if (!s.connected){
    body = `<div class="sm muted" style="margin-bottom:18px;line-height:1.75">
        Connecting lets CoachDesk push your sessions into Google Calendar so clients
        get normal invites, and pull your existing events in so you're not checking two places.
      </div>
      <div class="notice">Client names are <strong>not</strong> written into Google event titles.
        Shared calendars would otherwise leak your client list.</div>
      <button class="btn" id="gConnect">Connect Google Calendar</button>`;
  } else {
    body = `<div class="kv"><div class="k">Account</div><div class="grow">${esc(s.email||"connected")}</div></div>
      <div class="kv"><div class="k">Last sync</div><div class="grow">${s.lastSyncAt?esc(fmtDT(s.lastSyncAt)):"Never"}</div></div>
      <div class="notice" style="margin-top:16px">On conflict, <strong>CoachDesk wins</strong> — the version here
        overwrites Google. Events created in Google are imported, not overwritten.</div>
      <div class="row" style="gap:9px">
        <button class="btn" id="gSync">Sync now</button>
        <button class="btn danger s" id="gOff">Disconnect</button>
      </div>`;
  }

  openSheet("Google Calendar", body, m => {
    const c = m.querySelector("#gConnect");
    if (c) c.onclick = async () => {
      try {
        const { url } = await api("/api/google/connect", { method:"POST" });
        window.open(url, "_blank", "width=520,height=640");
        closeSheet();
        toast("Finish in the Google tab");
      } catch(e){ toast(e.message); }
    };
    const sy = m.querySelector("#gSync");
    if (sy) sy.onclick = async () => {
      sy.disabled = true; sy.textContent = "Syncing…";
      try {
        const r = await api("/api/google/sync", { method:"POST" });
        await pullSnapshot(); render(); closeSheet();
        toast(r.ok ? `Synced · ${r.pushed} out, ${r.imported} in`
                   : `Synced with ${r.errors.length} problem(s)`);
        if (!r.ok) console.warn(r.errors);
      } catch(e){ toast(e.message); sy.disabled=false; sy.textContent="Sync now"; }
    };
    const off = m.querySelector("#gOff");
    if (off) off.onclick = async () => {
      if (!confirm("Disconnect Google Calendar? Events already pushed stay in Google.")) return;
      await api("/api/google/disconnect", { method:"POST" });
      gStatus = null; closeSheet(); render(); toast("Disconnected");
    };
  });
}

window.addEventListener("message", e => {
  if (e.data && e.data.coachdesk === "google-done"){ refreshGoogleLine(); toast("Google connected"); }
});

/* ---------- 13. PROFILE / RÉSUMÉ -------------------------------------- */
function renderProfile(){
  const p = S.profile;
  const block = (title, arr, item, add, hint) => `
    <div class="sec"><h2>${title}</h2><div class="rule"></div>
      <button class="btn quiet s" onclick="${add}">Add</button></div>
    ${arr.length ? arr.map(item).join("") : `<div class="sm faint" style="padding:2px 2px 6px">${hint}</div>`}`;

  $("#view-profile").innerHTML = `
    <div class="card" style="padding:20px">
      <div class="grid2">
        <label class="fld"><span>Full name</span><input class="pf" data-k="name" type="text" value="${esc(p.name)}" placeholder="Your name"></label>
        <label class="fld"><span>Title</span><input class="pf" data-k="title" type="text" value="${esc(p.title)}" placeholder="e.g. Tennis Coach"></label>
        <label class="fld"><span>Email</span><input class="pf" data-k="email" type="email" value="${esc(p.email)}"></label>
        <label class="fld"><span>Phone</span><input class="pf" data-k="phone" type="tel" value="${esc(p.phone)}"></label>
        <label class="fld"><span>Location</span><input class="pf" data-k="location" type="text" value="${esc(p.location)}"></label>
        <label class="fld"><span>Website</span><input class="pf" data-k="website" type="text" value="${esc(p.website)}"></label>
      </div>
      <label class="fld"><span>Short bio</span><textarea class="pf" data-k="bio" placeholder="Two or three sentences a prospective client would actually read.">${esc(p.bio)}</textarea></label>
      <div class="grid2">
        <label class="fld"><span>Flier headline</span><input class="pf" data-k="tagline" type="text" value="${esc(p.tagline)}" placeholder="e.g. Private Tennis Coaching"></label>
        <label class="fld"><span>Call to action</span><input class="pf" data-k="offer" type="text" value="${esc(p.offer)}" placeholder="e.g. First session free"></label>
      </div>
    </div>

    <div class="sec"><h2>Specialties</h2><div class="rule"></div></div>
    <div class="card tight">
      <input type="text" id="spIn" placeholder="Type one and press Enter">
      <div class="row wrap" style="gap:7px;margin-top:12px">
        ${p.specialties.map((s,i)=>`<span class="chip accent">${esc(s)}
          <a href="#" onclick="delSpec(${i});return false" style="text-decoration:none;color:inherit;opacity:.55">×</a></span>`).join("")
          || '<span class="xs faint">None yet</span>'}
      </div>
    </div>

    ${block("Experience", p.experience, x=>`<div class="card tight"><div class="row">
        <div class="grow"><div style="font-weight:600">${esc(x.role)}</div>
        <div class="xs muted">${[x.org,x.period].filter(Boolean).map(esc).join(" · ")||"—"}</div>
        ${x.detail?`<div class="sm muted" style="margin-top:4px">${esc(x.detail)}</div>`:""}</div>
        <button class="btn quiet s" onclick="editExp('${x.id}')">Edit</button></div></div>`,
      "editExp(null)", "Say “Add experience Head Coach at Riverside Club”.")}

    ${block("Certifications", p.certifications, x=>`<div class="card tight"><div class="row">
        <div class="grow"><div style="font-weight:600">${esc(x.name)}</div>
        <div class="xs muted">${[x.issuer,x.year].filter(Boolean).map(esc).join(" · ")||"—"}</div></div>
        <button class="btn quiet s" onclick="editCert('${x.id}')">Edit</button></div></div>`,
      "editCert(null)", "Say “Add certification USPTA Level 2”.")}

    ${block("Testimonials", p.testimonials, x=>`<div class="card tight"><div class="row">
        <div class="grow"><div class="sm serif" style="font-style:italic">“${esc(x.quote)}”</div>
        <div class="xs muted" style="margin-top:4px">${esc(x.author)||"—"}</div></div>
        <button class="btn quiet s" onclick="editTest('${x.id}')">Edit</button></div></div>`,
      "editTest(null)", "Say “Add testimonial Best coach my daughter has had”.")}

    <div class="row" style="margin-top:24px;gap:9px">
      <button class="btn grow" onclick="preview('resume')">Preview résumé</button>
      <button class="btn ghost grow" onclick="preview('flier')">Preview flier</button>
    </div>`;

  $$(".pf").forEach(el => {
    el.oninput = () => { S.profile[el.dataset.k] = el.value; touch("profile", S.profile); };
  });
  const sp = $("#spIn");
  sp.onkeydown = e => {
    if (e.key === "Enter"){
      e.preventDefault();
      const v = sp.value.trim(); if (!v) return;
      S.profile.specialties.push(v); touch("profile", S.profile);
      renderProfile(); $("#spIn").focus();
    }
  };
}
function delSpec(i){ S.profile.specialties.splice(i,1); touch("profile", S.profile); renderProfile(); }

function editList(arrName, id, title, fields){
  const arr = S.profile[arrName];
  const item = id ? arr.find(x=>x.id===id) : null;
  openSheet(title, `
    ${fields.map(f=>`<label class="fld"><span>${esc(f.label)}</span>${
      f.multiline ? `<textarea data-f="${f.k}">${esc(item?item[f.k]:"")}</textarea>`
                  : `<input data-f="${f.k}" type="text" value="${esc(item?item[f.k]:"")}">`}</label>`).join("")}
    <div class="row" style="gap:9px"><button class="btn" id="lSave">Save</button><div class="grow"></div>
      ${item?`<button class="btn danger s" id="lDel">Delete</button>`:""}</div>`,
    m => {
      m.querySelector("[data-f]").focus();
      m.querySelector("#lSave").onclick = () => {
        const data = {};
        $$("[data-f]", m).forEach(el => data[el.dataset.f] = el.value.trim());
        if (!data[fields[0].k]) return toast(fields[0].label + " is required");
        if (item) Object.assign(item, data);
        else arr.push(Object.assign({ id:uid() }, data));
        touch("profile", S.profile); renderProfile(); closeSheet(); toast("Saved");
      };
      const d = m.querySelector("#lDel");
      if (d) d.onclick = () => {
        S.profile[arrName] = arr.filter(x=>x.id!==id);
        touch("profile", S.profile); renderProfile(); closeSheet(); toast("Removed");
      };
    });
}
const editExp  = id => editList("experience", id, "Experience", [
  {k:"role",label:"Role"},{k:"org",label:"Organisation"},{k:"period",label:"Period"},{k:"detail",label:"Detail",multiline:true}]);
const editCert = id => editList("certifications", id, "Certification", [
  {k:"name",label:"Name"},{k:"issuer",label:"Issuer"},{k:"year",label:"Year"}]);
const editTest = id => editList("testimonials", id, "Testimonial", [
  {k:"quote",label:"Quote",multiline:true},{k:"author",label:"Attribution"}]);

function resumeHTML(){
  const p = S.profile;
  const contact = [p.email,p.phone,p.location,p.website].filter(Boolean).map(esc).join("  ·  ");
  const sec = (t,b) => b ? `<h4>${t}</h4>${b}` : "";
  return `<div class="doc">
    <h1>${esc(p.name)||"Your Name"}</h1>
    <div class="role">${esc(p.title)||"Coach"}</div>
    ${contact?`<div class="contact">${contact}</div>`:""}
    <hr>
    ${p.bio?`<h4>Profile</h4><div style="font-size:13.5px;line-height:1.65">${esc(p.bio)}</div>`:""}
    ${sec("Specialties", p.specialties.length?`<ul class="sk">${p.specialties.map(s=>`<li>${esc(s)}</li>`).join("")}</ul>`:"")}
    ${sec("Experience", p.experience.map(x=>`<div class="item">
        <div class="t">${esc(x.role)}</div>
        <div class="s">${[x.org,x.period].filter(Boolean).map(esc).join("  ·  ")}</div>
        ${x.detail?`<div class="d">${esc(x.detail)}</div>`:""}</div>`).join(""))}
    ${sec("Certifications", p.certifications.map(x=>`<div class="item">
        <div class="t">${esc(x.name)}</div>
        <div class="s">${[x.issuer,x.year].filter(Boolean).map(esc).join("  ·  ")}</div></div>`).join(""))}
    ${sec("Testimonials", p.testimonials.map(x=>`<div class="quote">“${esc(x.quote)}”${
        x.author?`<div style="font-style:normal;font-size:12px;color:#6E6F68;margin-top:5px;font-family:var(--sans)">— ${esc(x.author)}</div>`:""}</div>`).join(""))}
  </div>`;
}
function flierHTML(){
  const p = S.profile;
  const contact = [p.phone,p.email,p.website].filter(Boolean).map(esc).join("  ·  ");
  return `<div class="doc flier">
    <div class="head">${esc(p.tagline)||esc(p.title)||"Coaching"}</div>
    <div class="sub">${esc(p.name)||"Your Name"}${p.location?" · "+esc(p.location):""}</div>
    ${p.bio?`<div style="font-size:14.5px;max-width:430px;margin:0 auto 22px;line-height:1.7">${esc(p.bio)}</div>`:""}
    ${p.specialties.length?`<ul class="sk" style="justify-content:center;margin-bottom:20px">${p.specialties.map(s=>`<li>${esc(s)}</li>`).join("")}</ul>`:""}
    ${p.testimonials.length?`<div class="quote" style="border:none;padding:0;text-align:center;max-width:410px;margin:0 auto 18px">“${esc(p.testimonials[0].quote)}”</div>`:""}
    ${p.certifications.length?`<div style="font-size:12.5px;color:#5E6058;margin-bottom:10px">${p.certifications.map(c=>esc(c.name)).join("  ·  ")}</div>`:""}
    <div class="cta">${esc(p.offer)||"Get in touch"}${contact?`<div style="font-weight:400;font-size:13.5px;margin-top:7px;opacity:.9">${contact}</div>`:""}</div>
  </div>`;
}
function preview(kind){
  const html = kind==="resume" ? resumeHTML() : flierHTML();
  openSheet(kind==="resume" ? "Résumé" : "Flier", `
    <div id="docHost">${html}</div>
    <div class="row no-print" style="margin-top:16px;gap:9px">
      <button class="btn" onclick="window.print()">Print / Save as PDF</button>
      <button class="btn ghost" onclick="copyDoc()">Copy text</button>
    </div>`,
    () => { $("#printRoot").innerHTML = html; });
}
function copyDoc(){
  const host = $("#docHost");
  navigator.clipboard?.writeText(host?host.innerText:"").then(()=>toast("Copied"),()=>toast("Couldn't copy"));
}

/* ---------- 14. ACCOUNT ------------------------------------------------ */
function accountPanel(){
  const counts = `${clients().length} clients · ${events().length} events · ${clients().reduce((n,c)=>n+(c.notes||[]).length,0)} notes`;

  // No server, so most of this panel would be lying. Show what's true.
  if (STATIC){
    openSheet("About this demo", `
      <div class="notice" style="margin-bottom:16px">
        You're running the browser-only build. Everything works and saves to this
        device, but there's no server behind it, so accounts, multi-device sync and
        Google Calendar aren't part of this demo.
      </div>
      <div class="kv"><div class="k">Your data</div><div class="grow">${counts}</div></div>
      <div class="kv"><div class="k">Stored</div><div class="grow">In this browser only</div></div>
      <div class="sec"><h2>Have a go</h2><div class="rule"></div></div>
      <div class="xs muted" style="line-height:1.8;margin-bottom:14px">
        Tap the microphone and say something like:<br>
        &ldquo;I've got a new client Ryan Cole for golf, he's 27, 555-018-8100&rdquo;<br>
        &ldquo;Book Emma in for Tuesday at half past four&rdquo;
      </div>
      <div class="sec"><h2>Data</h2><div class="rule"></div></div>
      <div class="row wrap" style="gap:9px">
        <button class="btn ghost" onclick="exportJSON()">Export JSON</button>
        <button class="btn ghost" id="aReset">Reset the demo</button>
      </div>
      <div class="xs faint" style="margin-top:14px;line-height:1.7">
        Reset wipes your changes and puts the sample coach back.
      </div>`,
      m => {
        m.querySelector("#aReset").onclick = () => {
          if (!confirm("Wipe your changes and restore the sample data?")) return;
          clearLocal(); closeSheet(); bootStatic(); toast("Demo reset");
        };
      });
    return;
  }

  const sync = { idle:"Waiting to sync", busy:"Syncing…", ok:"All changes saved",
                 offline:"Offline — saved on this device", error:"Sync problem" }[syncState] || "—";
  openSheet("Account", `
    <div class="kv"><div class="k">Signed in</div><div class="grow">${esc(me?.email||"")}</div></div>
    <div class="kv"><div class="k">Sync</div><div class="grow">${esc(sync)}${dirty.size?` · ${dirty.size} pending`:""}</div></div>
    <div class="kv"><div class="k">Your data</div><div class="grow">${counts}</div></div>
    ${!LS.ok?`<div class="notice bad" style="margin-top:14px"><strong>Browser storage is blocked here.</strong>
      Your work still syncs to the server, but this device can't hold an offline copy.</div>`:""}

    <div class="sec"><h2>Email address</h2><div class="rule"></div></div>
    <div id="emailMsg"></div>
    <div class="grid2">
      <label class="fld"><span>New email</span><input id="aNewEmail" type="email" placeholder="new@example.com"></label>
      <label class="fld"><span>Current password</span><input id="aPass" type="password" autocomplete="current-password" placeholder="To confirm it's you"></label>
    </div>
    <button class="btn ghost" id="aEmail">Send confirmation link</button>
    <div class="xs faint" style="margin-top:8px;line-height:1.7">
      Your address only changes once you open the link we send to the new one.
      We'll also let ${esc(me?.email||"your current address")} know.
    </div>

    <div class="sec"><h2>Data</h2><div class="rule"></div></div>
    <div class="row wrap" style="gap:9px">
      <button class="btn ghost" onclick="exportJSON()">Export JSON</button>
      <button class="btn ghost" onclick="syncNow()">Sync now</button>
    </div>

    <div class="sec"><h2>Session</h2><div class="rule"></div></div>
    <div class="row wrap" style="gap:9px">
      <button class="btn ghost" id="aOut">Sign out</button>
      <button class="btn danger s" id="aOutAll">Sign out everywhere</button>
    </div>
    <div class="xs faint" style="margin-top:14px;line-height:1.7">
      Signing out clears the copy stored on this device. Everything stays on the server.
    </div>`,
    m => {
      m.querySelector("#aOut").onclick = () => doLogout(false);
      m.querySelector("#aOutAll").onclick = () => {
        if (confirm("Sign out on all your devices?")) doLogout(true);
      };
      const btn = m.querySelector("#aEmail");
      btn.onclick = async () => {
        const newEmail = m.querySelector("#aNewEmail").value.trim();
        const password = m.querySelector("#aPass").value;
        const msg = (text, good) => {
          m.querySelector("#emailMsg").innerHTML =
            `<div class="notice ${good?"good":"bad"}" style="margin-bottom:14px">${esc(text)}</div>`;
        };
        if (!newEmail || !password) return msg("Enter the new address and your current password.");
        btn.disabled = true; btn.textContent = "Sending…";
        try {
          const r = await api("/api/auth/email", { method:"POST", body: JSON.stringify({ newEmail, password }) });
          msg(r.message, true);
          m.querySelector("#aPass").value = "";
          m.querySelector("#aNewEmail").value = "";
        } catch(e){ msg(e.message || "Couldn't send that."); }
        btn.disabled = false; btn.textContent = "Send confirmation link";
      };
    });
}
function exportJSON(){
  const blob = new Blob([JSON.stringify({ clients:clients(), events:events(), profile:S.profile }, null, 2)], { type:"application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `coachdesk-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  toast("Exported");
}
async function doLogout(everywhere){
  try { await api(everywhere ? "/api/auth/logout-all" : "/api/auth/logout", { method:"POST" }); } catch(e){}
  clearLocal(); signedOut();
}

/* ---------- 15. AUTH UI ------------------------------------------------
   One form, four modes: sign in, create account, request a reset link,
   set a new password. Reusing a single form keeps the markup small and
   means the browser's password manager sees a consistent element.
--------------------------------------------------------------------- */
let gateMode = "in";
let resetToken = null;

function gateMsg(text, ok){
  const el = $("#gateMsg");
  if (!text){ el.classList.add("hidden"); return; }
  el.textContent = text;
  el.style.borderLeftColor = ok ? "var(--accent)" : "var(--rose)";
  el.classList.remove("hidden");
}

const GATE = {
  in:     { submit:"Sign in",          foot:"Your notes sync privately across your devices." },
  up:     { submit:"Create account",   foot:"Eight characters or more. Nothing is shared with anyone." },
  forgot: { submit:"Send reset link",  foot:"We'll email you a link. It works once and expires in an hour." },
  reset:  { submit:"Set new password", foot:"Setting a new password signs you out on every device." }
};

function setGateMode(mode, keepMsg){
  gateMode = mode;
  const cfg = GATE[mode];

  $("#tabIn").classList.toggle("on", mode === "in");
  $("#tabUp").classList.toggle("on", mode === "up");
  // The sign-in / create-account toggle is meaningless mid-reset.
  $(".gate-toggle").classList.toggle("hidden", mode === "forgot" || mode === "reset");

  $("#fEmail").classList.toggle("hidden", mode === "reset");
  $("#fPass").classList.toggle("hidden",  mode === "forgot");
  $("#fPass2").classList.toggle("hidden", mode !== "reset");
  $("#fAge").classList.toggle("hidden",   mode !== "up");
  $("#gForgot").classList.toggle("hidden", mode === "up");

  $("#gForgot").textContent = (mode === "forgot" || mode === "reset")
    ? "Back to sign in" : "Forgot your password?";

  $("#gPass").setAttribute("autocomplete", mode === "in" ? "current-password" : "new-password");
  $("#gPass").placeholder = mode === "reset" ? "New password" : "At least 8 characters";
  $("#gSubmit").textContent = cfg.submit;
  $("#gSubmit").disabled = false;
  $("#gateFoot").textContent = cfg.foot;
  if (!keepMsg) gateMsg("");
}

/* Server-provided flags: whether a public demo exists, and whether this
   instance keeps data between restarts. */
let serverFlags = { demo:false, ephemeral:false };
let inDemo = false;

function applyFlags(f){
  serverFlags = Object.assign(serverFlags, f || {});
  $("#gDemo").classList.toggle("hidden", !serverFlags.demo);
  $("#gOr").classList.toggle("hidden", !serverFlags.demo);
}

function showBanner(){
  const b = $("#banner");
  const bits = [];
  if (STATIC) bits.push(
    "<strong>Browser demo.</strong> Everything here runs locally and saves to this device only. " +
    "Multi-device sync, accounts and Google Calendar need the server " +
    "&mdash; <a href=\"https://github.com/Vinuboi321/coachdesk\">the code's on GitHub</a>."
  );
  else if (inDemo) bits.push("<strong>Demo workspace.</strong> Edit anything you like, it resets next time someone opens the demo.");
  else if (serverFlags.ephemeral) bits.push("<strong>Demo instance.</strong> Accounts and data reset when the server restarts.");
  b.innerHTML = bits.join(" ");
  b.classList.toggle("hidden", !bits.length);
}

function initGate(){
  $("#tabIn").onclick = () => setGateMode("in");
  $("#tabUp").onclick = () => setGateMode("up");

  $("#gDemo").onclick = async () => {
    const btn = $("#gDemo");
    btn.disabled = true; btn.textContent = "Setting up the demo…";
    try {
      const r = await api("/api/auth/demo", { method:"POST" });
      me = r.user; inDemo = true;
      clearLocal();                     // never mix demo data into a real account
      await enterApp({ fresh:true });
    } catch(e){
      gateMsg(e.message || "Couldn't start the demo.");
      btn.disabled = false; btn.textContent = "Try the demo — no signup";
    }
  };
  $("#gForgot").onclick = () => {
    if (gateMode === "forgot" || gateMode === "reset"){
      resetToken = null;
      history.replaceState(null, "", "/");
      setGateMode("in");
    } else setGateMode("forgot");
  };

  $("#gateForm").onsubmit = async e => {
    e.preventDefault();
    const btn = $("#gSubmit");
    const email = $("#gEmail").value.trim();
    const password = $("#gPass").value;
    const busy = { in:"Signing in…", up:"Creating…", forgot:"Sending…", reset:"Saving…" }[gateMode];

    // Client-side checks first, so obvious mistakes don't cost a round trip.
    if (gateMode === "up" && !$("#gAge").checked)
      return gateMsg("Please confirm you're 18 or older.");
    if (gateMode === "reset" && password !== $("#gPass2").value)
      return gateMsg("Those two passwords don't match.");
    if ((gateMode === "up" || gateMode === "reset") && password.length < 8)
      return gateMsg("Password needs to be at least 8 characters.");

    btn.disabled = true; btn.textContent = busy;
    try {
      if (gateMode === "forgot"){
        const r = await api("/api/auth/forgot", { method:"POST", body: JSON.stringify({ email }) });
        gateMsg(r.message, true);
        btn.textContent = GATE.forgot.submit;
        btn.disabled = false;
        return;
      }
      if (gateMode === "reset"){
        const r = await api("/api/auth/reset", { method:"POST", body: JSON.stringify({ token: resetToken, password }) });
        resetToken = null;
        history.replaceState(null, "", "/");
        $("#gPass").value = ""; $("#gPass2").value = "";
        setGateMode("in");
        gateMsg(r.message, true);
        return;
      }

      const body = gateMode === "up"
        ? { email, password, ageAttested: true }
        : { email, password };
      const r = await api(`/api/auth/${gateMode === "in" ? "login" : "register"}`,
        { method:"POST", body: JSON.stringify(body) });
      me = r.user;
      $("#gPass").value = "";
      await enterApp({ fresh:true });
    } catch(err){
      gateMsg(err.message || "Something went wrong. Try again.");
      setGateMode(gateMode, true);
    }
  };
}

/** Handles the /confirm-email?token=… link. Works signed in or not. */
async function checkEmailLink(){
  const url = new URL(location.href);
  const token = url.searchParams.get("token");
  if (!token || !/^\/confirm-email\/?$/.test(url.pathname)) return false;

  let message, good = false;
  try {
    const r = await api("/api/auth/email/confirm", { method:"POST", body: JSON.stringify({ token }) });
    message = r.message; good = true;
    if (me) me.email = r.email;
  } catch(e){
    message = e.message || "That confirmation link didn't work.";
  }

  history.replaceState(null, "", "/");
  // A changed login email makes any current session's identity stale, so
  // send them back through the front door rather than guessing.
  try { await api("/api/auth/logout", { method:"POST" }); } catch(e){}
  clearLocal(); me = null;
  $("#app").classList.add("hidden");
  $("#gate").classList.remove("hidden");
  setGateMode("in");
  gateMsg(message, good);
  return true;
}

/** Handles the /reset?token=… link from the email. */
async function checkResetLink(){
  const url = new URL(location.href);
  const token = url.searchParams.get("token");
  if (!token || !/^\/reset\/?$/.test(url.pathname)) return false;

  try {
    const r = await api("/api/auth/reset?token=" + encodeURIComponent(token));
    if (r.valid){
      resetToken = token;
      setGateMode("reset");
      $("#gPass").focus();
      return true;
    }
  } catch(e){ /* fall through to the expired message */ }

  history.replaceState(null, "", "/");
  setGateMode("in");
  gateMsg("That reset link has expired or already been used. Request a new one.");
  return true;
}

function signedOut(){
  me = null; inDemo = false;
  $("#app").classList.add("hidden");
  $("#gate").classList.remove("hidden");
  $("#banner").classList.add("hidden");
  setGateMode("in");
  $("#gSubmit").disabled = false;
  const d = $("#gDemo");
  if (d){ d.disabled = false; d.textContent = "Try the demo — no signup"; }
}

async function enterApp({ fresh } = {}){
  $("#gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  showBanner();
  restore();
  render();
  watchDock();
  // A device signing in fresh takes the server's world; a returning one
  // keeps its local copy and reconciles with a delta sync.
  if (fresh && !dirty.size) await pullSnapshot();
  render();
  await syncNow();
}

/* ---------- 16. BOOT --------------------------------------------------- */
let activeTab = "clients";

function render(){
  if (!me) return;
  $("#bClients").textContent = clients().length;
  $("#bEvents").textContent  = events().filter(e=>new Date(e.start)>=startOfDay(new Date())).length;
  if (activeTab==="clients")  renderClients();
  if (activeTab==="calendar") renderCalendar();
  if (activeTab==="profile")  renderProfile();
}

function goTab(name){
  activeTab = name;
  $$("nav.tabs button").forEach(x => x.setAttribute("aria-selected", String(x.dataset.tab === name)));
  $$("section.view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  render();
}
$$("nav.tabs button").forEach(b => b.onclick = () => goTab(b.dataset.tab));
$("#btnAccount").onclick = accountPanel;

const SEED_KEY = "coachdesk.v2.seedVersion";

/** Browser-only build: no sign-in, straight into a populated workspace. */
async function bootStatic(){
  me = { id:"local", email:"you@thisdevice" };
  restore();

  const haveSeed = typeof CoachDeskSeed !== "undefined";
  const currentVersion = haveSeed ? String(CoachDeskSeed.VERSION || 1) : "0";
  const storedVersion = LS.get(SEED_KEY);
  const empty = !S.clients.length && !S.events.length;

  // Re-seed when there's nothing here, or when the sample data itself has
  // changed since this visitor last loaded the page. Without the version
  // check a returning visitor would be stuck with whatever they were given
  // the first time, and edits to seed.js would never reach them.
  if (haveSeed && (empty || storedVersion !== currentVersion)){
    const seed = CoachDeskSeed.buildSeed(uid);
    const stamp = nowIso();
    S.clients = seed.clients.map(c => Object.assign(c, { updated_at:stamp, deleted:false }));
    S.events  = seed.events.map(e  => Object.assign(e, { updated_at:stamp, deleted:false }));
    S.profile = Object.assign(blankProfile(), seed.profile, { updated_at:stamp });
    LS.set(SEED_KEY, currentVersion);
    persist();
  }
  $("#gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  showBanner();
  setSyncState("ok");
  render();
  watchDock();
}

(async function boot(){
  initGate();
  initVoice();

  if (STATIC){ await bootStatic(); return; }

  // A reset link takes priority: someone arriving with one may well have a
  // stale session cookie, and dropping them into the app would be baffling.
  if (await checkResetLink()) return;
  if (await checkEmailLink()) return;

  try {
    const r = await api("/api/auth/me");
    applyFlags(r);
    if (r.user){
      me = r.user;
      inDemo = serverFlags.demo && r.user.email === "demo@coachdesk.app";
      await enterApp({ fresh:false });
      return;
    }
  } catch(e){ /* server unreachable — fall through to the sign-in screen */ }
  signedOut();
})();

/* inline handlers */
Object.assign(window, { openClient, openClientEditor, addNoteTo, closeSheet, dismissConfirm,
  tryExample, moveMonth, goToday, selectDay, openEventEditor, googlePanel, preview, copyDoc,
  editExp, editCert, editTest, delSpec, exportJSON, exportClient, accountPanel, syncNow,
  parseCommand, goTab, startScheduling, bootStatic, retryVoice, measureDock });
