"use strict";
/* ============================================================
   Static build tests.

   Loads dist/ in a real DOM with fetch wired to throw, so anything that
   reaches for a server fails loudly rather than silently degrading. This
   is the build that's publicly deployed, so it gets covered like the
   server does.

   Run:  npm run test:static   (builds first)
   ============================================================ */

const fs = require("fs");
const path = require("path");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (e) {
  console.error("\n  jsdom isn't installed - it's a dev dependency of this project.\n" +
                "  Run:  npm install\n");
  process.exit(1);
}

const dist = path.join(__dirname, "..", "dist");
if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("\n  dist/ is missing. Run: npm run build:static\n");
  process.exit(1);
}

const errors = [];
const dom = new JSDOM(fs.readFileSync(path.join(dist, "index.html"), "utf8"), {
  runScripts: "dangerously",
  url: "https://vinuboi321.github.io/coachdesk/",
  pretendToBeVisual: true,
  beforeParse(w) {
    // Any network call at all is a bug in the static build.
    w.fetch = () => { errors.push("fetch was called - the static build must not reach for a server"); return Promise.reject(new Error("no server")); };
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.scrollTo = () => {};
    w.print = () => {};
  }
});
dom.virtualConsole.on("jsdomError", e => errors.push("jsdomError: " + e.message));

const w = dom.window;
// jsdom won't fetch external <script src>, so load them in document order.
for (const f of ["seed.js", "app.js"]) {
  try { w.eval(fs.readFileSync(path.join(dist, f), "utf8")); }
  catch (e) { errors.push(`${f} threw: ${e.message}`); }
}

const $ = s => w.document.querySelector(s);
const visible = el => el && !el.classList.contains("hidden");
const text = s => ($(s) ? $(s).textContent : "");

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
  if (cond) { pass++; console.log("  ok    " + label); }
  else { fail++; console.log("  FAIL  " + label + (extra ? "  [" + extra + "]" : "")); }
};
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(500);

  console.log("\n  Boots with no server\n");
  ok("no script errors", errors.length === 0, errors.join(" | "));
  ok("sign-in gate hidden", !visible($("#gate")));
  ok("app visible", visible($("#app")));
  ok("demo-mode banner shown", visible($("#banner")) && /Demo mode/.test(text("#banner")));
  ok("sync shows saved", $("#syncDot").className.includes("ok"));

  console.log("\n  Seeded with a worked example\n");
  ok("six clients", parseInt(text("#bClients"), 10) === 6, text("#bClients"));
  ok("upcoming events present", parseInt(text("#bEvents"), 10) > 0);
  ok("overview is the landing view", visible($("#view-dashboard")));
  ok("stat cards rendered", w.document.querySelectorAll("#view-dashboard .stat").length === 4);
  ok("session chart rendered", w.document.querySelectorAll("#view-dashboard .chart .col").length === 7);

  w.goTab("clients");
  ok("roster rendered as a table", w.document.querySelectorAll("#view-clients .tbl tbody tr").length >= 6);
  ok("missing-consent warning shown", /no guardian consent recorded/i.test(text("#view-clients")));
  ok("consent gap flagged on the row", /Consent needed/.test(text("#view-clients")));
  ok("no retired placeholder names left over",
     !/jacob|nadia|haddad|okafor|priya nair|aisha/i.test(w.document.body.innerHTML));

  console.log("\n  Parser works offline\n");
  const r = w.parseCommand("I've got a new client Ryan Cole for golf, he's 27, 555-018-8100");
  ok("client parsed", r.intent === "add_client" && r.name === "Ryan Cole", JSON.stringify(r));
  ok("age picked up", r.age === 27);
  ok("activity tagged", (r.tags || []).includes("golf"));

  console.log("\n  Understood input is offered, not asserted\n");
  w.tryExample("book a lesson with Emma tomorrow at half past four");
  await wait(200);
  ok("confirmation card shown", /Schedule/i.test(text("#confirmSlot")));
  ok("framed as editable", /Edit anything that's wrong/i.test(text("#confirmSlot")));
  ok("offers to re-say it", !!$("#pfRetry"));
  ok("has an editable date field", !!$("#pfDate"));

  console.log("\n  Unintelligible input asks for another go\n");
  w.tryExample("mmm hgfd wobble sprocket");
  await wait(300);
  ok("says it couldn't understand", /Couldn't understand/i.test(text("#confirmSlot")));
  ok("shows a Try again button", !!$("#uRetry"));
  ok("examples hidden by default", $("#uSamples") && $("#uSamples").classList.contains("hidden"));
  if ($("#uExamples")) {
    $("#uExamples").click();
    await wait(50);
    ok("examples revealed on request", !$("#uSamples").classList.contains("hidden"));
  } else { fail++; console.log("  FAIL  examples toggle missing"); }

  /* The dock is fixed to the bottom; if the page reserves a fixed amount
     of space for it, a tall confirmation card hides the last few cards
     and they can't be scrolled to. Regression: this shipped once. */
  console.log("\n  Page reserves room for however tall the dock gets\n");
  const css = fs.readFileSync(path.join(dist, "index.html"), "utf8");
  ok("main padding tracks the dock height", /main\.wrap\{padding-bottom:calc\(var\(--dock-h/.test(css));
  ok("no hardcoded dock reservation", !/main[.\w]*\{padding-bottom:calc\(190px/.test(css));
  ok("tall cards scroll internally", /\.confirm\{[^}]*max-height/s.test(css));

  /* <main> also carries .wrap, and `.wrap{padding:0 20px}` sets
     padding-bottom to 0 at higher specificity than a bare `main{}` type
     selector. Written the wrong way the clearance silently vanishes, which
     is precisely the bug that shipped. jsdom's cascade doesn't model
     specificity well enough to catch it, so assert on the selector. */
  ok("clearance rule outranks the .wrap shorthand",
     !/[};]\s*main\{padding-bottom/.test(css));

  // jsdom reports offsetHeight as 0, so fake a dock height and check the
  // measurement actually reaches the custom property.
  const dockEl = $(".dock");
  Object.defineProperty(dockEl, "offsetHeight", { value: 412, configurable: true });
  w.measureDock();
  ok("measured height published as --dock-h",
     w.document.documentElement.style.getPropertyValue("--dock-h") === "412px",
     w.document.documentElement.style.getPropertyValue("--dock-h"));

  /* The prompt under the input should suggest something useful for the
     screen you're on, not the same client example everywhere. */
  console.log("\n  Prompt follows the section you're in\n");
  w.goTab("clients");
  ok("clients suggests adding someone", /new client/i.test(text("#hint")), text("#hint"));
  w.goTab("calendar");
  ok("calendar suggests scheduling", /schedule a lesson/i.test(text("#hint")), text("#hint"));
  ok("...with a day and a time", /tuesday.*4pm/i.test(text("#hint")), text("#hint"));
  w.goTab("profile");
  ok("profile suggests a credential", /certification/i.test(text("#hint")), text("#hint"));

  console.log("\n  Views render\n");
  try { w.goTab("calendar"); ok("calendar", /Coming up|Nothing scheduled/.test(text("#view-calendar"))); }
  catch (e) { fail++; console.log("  FAIL  calendar [" + e.message + "]"); }
  try { w.goTab("profile"); ok("profile", /Specialties/.test(text("#view-profile"))); }
  catch (e) { fail++; console.log("  FAIL  profile [" + e.message + "]"); }

  ok("persisted to localStorage", !!w.localStorage.getItem("coachdesk.v2.state"));
  ok("seed version recorded", !!w.localStorage.getItem("coachdesk.v2.seedVersion"));
  ok("never called fetch", !errors.some(e => /fetch was called/.test(e)));

  /* A returning visitor whose stored data predates a seed change must get
     the new sample data, not be stuck with the old forever. This is a real
     bug that shipped once. */
  console.log("\n  Stale demo data is replaced when the seed changes\n");
  const stale = JSON.parse(w.localStorage.getItem("coachdesk.v2.state"));
  stale.clients[0].name = "Someone From The Old Seed";
  w.localStorage.setItem("coachdesk.v2.state", JSON.stringify(stale));
  w.localStorage.setItem("coachdesk.v2.seedVersion", "1");   // pretend an older build

  await w.bootStatic();
  await wait(100);
  const after = JSON.parse(w.localStorage.getItem("coachdesk.v2.state"));
  ok("old sample data cleared", !after.clients.some(c => c.name === "Someone From The Old Seed"));
  ok("current seed applied", after.clients.some(c => c.name === "Emma Clark"));
  ok("version bumped to current",
     w.localStorage.getItem("coachdesk.v2.seedVersion") === String(w.CoachDeskSeed.VERSION));

  /* Motion must never be load-bearing. jsdom has no IntersectionObserver,
     which is the same situation as an old browser or a failed script — the
     content has to end up visible anyway. A reveal animation that leaves
     the page blank when it breaks is worse than no animation. */
  /* A tile that states a problem should take you to the problem. Only the
     tiles that lead somewhere specific are buttons — the rest stay inert
     rather than offering a press that does nothing useful. */
  console.log("\n  Overview tiles go where they point\n");
  w.goTab("dashboard");
  await wait(120);
  const tiles = [...w.document.querySelectorAll("#view-dashboard .stat")];
  ok("four tiles", tiles.length === 4, tiles.length + "");
  ok("all four are pressable", tiles.every(t => t.tagName === "BUTTON"),
     tiles.map(t => t.tagName).join(","));
  ok("each shows a direction arrow", tiles.every(t => /→/.test(t.textContent)));

  const consentTile = tiles.find(t => /consent/i.test(t.textContent));
  ok("the consent gap is surfaced on a tile", !!consentTile, tiles.map(t=>t.textContent.trim().slice(0,24)).join(" | "));
  consentTile.click();
  await wait(150);
  ok("pressing it lands on the roster", visible($("#view-clients")));
  ok("and opens the client who is missing consent",
     /Lily Hayes/.test(text("#sheet")) && $("#scrim").classList.contains("on"),
     text("#sheet").slice(0, 60));
  w.closeSheet();

  w.goTab("dashboard");
  await wait(120);
  const todayTile = [...w.document.querySelectorAll("#view-dashboard .stat")]
    .find(t => /Sessions today/.test(t.textContent));
  todayTile.click();
  await wait(150);
  ok("the sessions tile opens the schedule", visible($("#view-calendar")));
  ok("with today selected", !!$(".cell.sel.today"));

  console.log("\n  Nothing is hidden when the reveal can't run\n");
  ok("motion class applied", w.document.documentElement.classList.contains("motion"));
  const toReveal = w.document.querySelectorAll(".reveal").length;
  const revealed = w.document.querySelectorAll(".reveal.in").length;
  ok("every reveal fell back to visible", toReveal > 0 && toReveal === revealed, `${revealed}/${toReveal}`);

  console.log("\n  The console shell\n");
  ok("sidebar present", !!$("aside.side"));
  w.goTab("clients");
  ok("the current section is marked in the sidebar",
     $('.nav-item[data-tab="clients"]').getAttribute("aria-current") === "page" &&
     $('.nav-item[data-tab="calendar"]').getAttribute("aria-current") !== "page");
  ok("theme starts dark", w.document.documentElement.getAttribute("data-theme") === "dark");
  $("#themeBtn").click();
  ok("the theme toggle switches to light", w.document.documentElement.getAttribute("data-theme") === "light");
  ok("and the choice is remembered", w.localStorage.getItem("coachdesk.theme") === "light");
  $("#themeBtn").click();
  ok("and switches back", w.document.documentElement.getAttribute("data-theme") === "dark");

  /* The day is drawn against an hour ruler rather than stacked as rows, so
     a 90-minute swim really is twice a 45-minute session. If these stop
     being proportional the whole point of the view is gone. */
  console.log("\n  The day is drawn to scale\n");
  w.goTab("calendar");
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  w.selectDay(tomorrow.toISOString());
  await wait(120);

  ok("strip rendered", !!$(".day"));
  const hourLabels = [...w.document.querySelectorAll(".day .hr")].map(e => e.textContent);
  ok("hours labelled as clock time", hourLabels.includes("7a") && hourLabels.includes("12p"), hourLabels.join(","));

  const blocks = [...w.document.querySelectorAll(".blk")];
  ok("blocks present", blocks.length > 0, blocks.length + " blocks");
  ok("every block positioned in hour units",
     blocks.every(b => /var\(--hour\)/.test(b.style.height) && /var\(--hour\)/.test(b.style.top)));

  const hourSpan = s => parseFloat((s.match(/([\d.]+) \* var\(--hour\)/) || [])[1]);
  const heights = blocks.map(b => hourSpan(b.style.height)).filter(n => !isNaN(n));
  ok("different durations give different heights", new Set(heights).size > 1, heights.join(","));
  ok("nothing renders thinner than half an hour", heights.every(h => h >= 0.5), heights.join(","));

  /* A double-booking is precisely what you need a calendar to show you, so
     overlapping events sit side by side instead of hiding each other. */
  console.log("\n  A double-booking is visible, not stacked\n");
  const at = (h, m) => new Date(2026, 7, 20, h, m || 0, 0).toISOString();
  const ev = (id, title, h, m, dur) => ({
    id, title, clientId: null, start: at(h, m), durationMin: dur,
    location: "", notes: "", source: "local", deleted: false, updated_at: new Date().toISOString()
  });
  w.localStorage.setItem("coachdesk.v2.state", JSON.stringify({
    clients: [],
    events: [ev("a", "Emma", 10, 0, 60), ev("b", "Jack", 10, 30, 60), ev("c", "Tom", 14, 0, 60)],
    profile: JSON.parse(w.localStorage.getItem("coachdesk.v2.state")).profile
  }));
  w.localStorage.setItem("coachdesk.v2.seedVersion", String(w.CoachDeskSeed.VERSION));
  await w.bootStatic();
  w.goTab("calendar");
  w.selectDay(at(9, 0));
  await wait(120);

  const clash = [...w.document.querySelectorAll(".blk")];
  ok("all three rendered", clash.length === 3, clash.length + " blocks");
  ok("the 10:00 and 10:30 sit in different columns", clash[0].style.left !== clash[1].style.left,
     clash.map(b => b.style.left).join(" | "));
  ok("and share the width between them", /0\.5|\/ ?2/.test(clash[0].style.width), clash[0].style.width);
  ok("the free 14:00 slot goes back to the first column", clash[2].style.left === clash[0].style.left,
     clash[2].style.left + " vs " + clash[0].style.left);

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
