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
  ok("browser-demo banner shown", visible($("#banner")) && /Browser demo/.test(text("#banner")));
  ok("sync shows saved", $("#syncDot").className.includes("ok"));

  console.log("\n  Seeded with a worked example\n");
  ok("six clients", parseInt(text("#bClients"), 10) === 6, text("#bClients"));
  ok("upcoming events present", parseInt(text("#bEvents"), 10) > 0);
  ok("client list rendered", w.document.querySelectorAll("#view-clients .card").length >= 6);
  ok("missing-consent warning shown", /no guardian consent recorded/i.test(text("#view-clients")));
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
  ok("framed as a suggestion", /what it made of that/i.test(text("#confirmSlot")));
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

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
