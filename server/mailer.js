"use strict";
/* ============================================================
   Outbound email.

   If SMTP is configured, send for real. If it isn't, print the message
   to the console instead of failing. That means the reset flow is fully
   testable the moment you clone the repo — you copy the link out of your
   terminal — and turning on real delivery is just filling in .env.

   The console fallback is loud and explicitly labelled, because a reset
   link sitting in a server log is a credential. It must never be
   mistaken for normal operation in production.
   ============================================================ */

const SMTP_HOST = process.env.SMTP_HOST;
const CONFIGURED = !!SMTP_HOST;

let transport = null;
let transportError = null;

function getTransport() {
  if (transport || transportError) return transport;
  try {
    const nodemailer = require("nodemailer");
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "") === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
    });
  } catch (e) {
    transportError = e;
    console.error("  ! SMTP_HOST is set but nodemailer is unavailable:", e.message);
  }
  return transport;
}

function logToConsole(to, subject, text) {
  const rule = "─".repeat(64);
  console.log(
    `\n${rule}\n  EMAIL NOT SENT — no SMTP configured. Contents below.\n` +
    `  To:      ${to}\n  Subject: ${subject}\n${rule}\n${text}\n${rule}\n` +
    `  Set SMTP_HOST in .env to deliver this for real.\n${rule}\n`
  );
}

/**
 * Send a plain-text email. Resolves either way — a delivery failure must
 * not tell the caller whether an account exists, and must not 500 the
 * request. Failures are logged, not thrown.
 */
async function send({ to, subject, text }) {
  if (!CONFIGURED) { logToConsole(to, subject, text); return { delivered: false, reason: "not_configured" }; }
  const t = getTransport();
  if (!t) { logToConsole(to, subject, text); return { delivered: false, reason: "no_transport" }; }
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || `CoachDesk <no-reply@${SMTP_HOST}>`,
      to, subject, text
    });
    return { delivered: true };
  } catch (e) {
    console.error("  ! Email delivery failed:", e.message);
    logToConsole(to, subject, text);
    return { delivered: false, reason: e.message };
  }
}

const configured = () => CONFIGURED;

module.exports = { send, configured };
