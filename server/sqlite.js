"use strict";
/* ============================================================
   SQLite adapter.

   Prefers Node's built-in `node:sqlite` (Node 22.5+), which needs no
   compiler and no prebuilt binary — the original better-sqlite3 build
   failed on a machine without build tools, and that's a bad first
   experience for something meant to run with `npm install && npm start`.

   Falls back to better-sqlite3 when it's actually installed, since it is
   faster and non-experimental. The two APIs already agree on
   prepare/run/get/all and @named parameters; this file smooths over the
   rest (mainly .pragma()).
   ============================================================ */

let impl = null;

/** True when the failure is "this module isn't here", not "it broke". */
const isMissingModule = e =>
  e.code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
  e.code === "MODULE_NOT_FOUND" ||
  /Cannot find module/.test(e.message);

function open(filename) {
  // 1. Built-in. Node 22.5+, no native build required.
  let builtin = null;
  try {
    builtin = require("node:sqlite").DatabaseSync;
  } catch (e) {
    if (!isMissingModule(e)) throw e;      // present but broken — don't mask it
  }
  if (builtin) {
    impl = "node:sqlite";
    return wrapNode(new builtin(filename)); // an open failure here is real; let it throw
  }

  // 2. Optional native driver, for older Node.
  try {
    const Database = require("better-sqlite3");
    impl = "better-sqlite3";
    return new Database(filename);
  } catch (e) {
    throw new Error(
      "No SQLite backend available.\n" +
      "  Either run Node 22.5 or newer (built-in SQLite, nothing to install),\n" +
      "  or install the optional native driver:  npm install better-sqlite3\n" +
      "  Underlying error: " + e.message
    );
  }
}

/* node:sqlite is close to better-sqlite3 but not identical. */
function wrapNode(db) {
  return {
    _raw: db,
    exec: sql => db.exec(sql),
    pragma: sql => db.exec("PRAGMA " + sql),
    prepare(sql) {
      const st = db.prepare(sql);
      return {
        run: (...a) => st.run(...a),
        get: (...a) => st.get(...a),
        all: (...a) => st.all(...a)
      };
    },
    /* better-sqlite3 exposes db.transaction(fn) returning a callable that
       wraps fn in BEGIN/COMMIT. Reproduced here, including rollback on
       throw. Not reentrant — nested calls would double-BEGIN — so callers
       keep transactions flat, which they do. */
    transaction(fn) {
      return (...args) => {
        db.exec("BEGIN");
        try {
          const out = fn(...args);
          db.exec("COMMIT");
          return out;
        } catch (err) {
          try { db.exec("ROLLBACK"); } catch (_) {}
          throw err;
        }
      };
    },
    close: () => db.close()
  };
}

module.exports = { open, driver: () => impl };
