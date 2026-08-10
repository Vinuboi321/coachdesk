#!/usr/bin/env node
"use strict";
/* ============================================================
   Build the browser-only bundle for GitHub Pages.

   Copies public/ into dist/ and flips one switch: a script tag setting
   window.COACHDESK_STATIC before app.js loads. Everything else is the
   same code that runs against the real server, which is the point —
   there's no second frontend to keep in step.

   Usage:  node scripts/build-static.js
   ============================================================ */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = path.join(root, "public");
const out = path.join(root, "dist");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

for (const file of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, file), path.join(out, file));
}

const indexPath = path.join(out, "index.html");
let html = fs.readFileSync(indexPath, "utf8");

// seed.js has to load before app.js so the seed is there at boot.
const inject = `<script>window.COACHDESK_STATIC = true;</script>
<script src="seed.js"></script>
<script src="app.js"></script>`;

if (!html.includes('<script src="/app.js"></script>')) {
  throw new Error("Expected <script src=\"/app.js\"></script> in public/index.html - has the markup changed?");
}
html = html.replace('<script src="/app.js"></script>', inject);

// Absolute paths break on project Pages sites, which serve from /<repo>/.
html = html.replace(/(src|href)="\/([^"]*)"/g, '$1="$2"');

// A no-op file that stops Pages running the output through Jekyll, which
// would otherwise ignore anything starting with an underscore.
fs.writeFileSync(path.join(out, ".nojekyll"), "");
fs.writeFileSync(indexPath, html);

const files = fs.readdirSync(out);
console.log("Built dist/ for GitHub Pages");
console.log("  files:", files.join(", "));
console.log("  size: ", files.reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0), "bytes");
