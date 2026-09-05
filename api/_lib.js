// Forge send console — shared helpers: KV (Upstash Redis REST), token gate,
// JSON responses, body reading. No SDKs: plain fetch over the Upstash REST
// API (https://upstash.com/docs/redis/features/restapi):
//
//   POST {KV_URL}             body: JSON [cmd, ...args]  ->  {"result": ...}
//   POST {KV_URL}/pipeline    body: 2D JSON array  ->  [{"result"|"error"}, ...]
//
// Everything lives under forge:* keys; the whole state is replaced by the
// local push (queue + images + decisions cleared) and drained by the local
// pull, so the console never accumulates history. Tracking events
// (forge:tkmap:*, forge:trk:*, forge:trkusers) are the exception — they
// survive the pull by design, see the tracking section below.

import crypto from "node:crypto";

const KV_URL = process.env.FORGE_KV_REST_URL || "";
const KV_TOKEN = process.env.FORGE_KV_REST_TOKEN || "";
const TOKEN = process.env.FORGE_CONSOLE_TOKEN || "";

// KV key layout ---------------------------------------------------------
export const Q_QUEUE = "forge:queue";       // string JSON array of queue items
export const Q_IMGS = "forge:imgs";         // string JSON array: usernames with an image in KV
export const Q_DECS = "forge:decisions";    // Redis list of decision objects
export const Q_STAGED = "forge:staged";     // string JSON array: [{username, choice, at}] — pre-lock review state
export const Q_BATCH = "forge:batch";       // string JSON: the active batch {id, secret, at, items:[...]} or empty
export const imgKey = (username) => `forge:img:${username}`;
export const claimKey = (username) => `forge:claim:${username}`; // batchsend dedup claim, SET NX EX 3600

// Email tracking (stage 4c) -----------------------------------------------
// Every batch email carries a per-send token (tk = 24 hex). At build time the
// signature URL is mechanically rewritten to {trackBase}/api/r?tk=… (click,
// 302 back to the site) and an invisible HTML mirror part adds
// {trackBase}/api/pix?tk=… (open). Events land under forge:trk:* — keys the
// console clear never touches, so KPIs outlive the review lifecycle.
export const SITE_URL = "https://forgefitapp.co/";          // the one URL in every email
export const SITE_LINE = "Forge — https://forgefitapp.co/"; // house-rule closing line (revise.js mirrors it)
export const Q_TRK_USERS = "forge:trkusers";                // set: usernames with a tracked send
export const tkMapKey = (tk) => `forge:tkmap:${tk}`;        // token -> {username, sentAt}
export const trackKey = (username) => `forge:trk:${username}`; // list of events {kind, tk, at, ...}, newest first
export const TRK_LIST_CAP = 100;        // LTRIM bound per prospect
export const TRK_MAP_TTL_S = 7776000;   // tk map TTL: 90 days — any reply lands well before that
export const OUTCOMES = ["positive", "neutral", "negative", "bounce"];

const TRACK_BASE_DEFAULT = "https://go.forgefitapp.co"; // CNAME -> the console project
export function trackBase() {
  return (process.env.FORGE_TRACK_BASE || TRACK_BASE_DEFAULT).replace(/\/+$/, "");
}
export const trackerUrl = (tk) => `${trackBase()}/api/r?tk=${tk}`;
export const pixelUrl = (tk) => `${trackBase()}/api/pix?tk=${tk}`; // no trailing slash: a 308 on the pixel would be cached forever

/** The signature URL in the text body becomes the tracked link. The
 *  rewritten text is what SMTP ships AND what the decision records, so the
 *  pulled md stays byte-truthful. Mechanical, post-freeze, at build time. */
export function rewriteText(body, tk) {
  return String(body).split(SITE_URL).join(trackerUrl(tk));
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain-text mirror as an HTML part carrying the open pixel. Visible copy
 *  identical to the text part; nodemailer nests it as multipart/alternative.
 *  (track contains no & < >, so it survives escHtml verbatim.) */
export function htmlMirror(text, tk) {
  const track = trackerUrl(tk);
  const mirrored = String(text)
    .split(/\r?\n/)
    .map((line) => escHtml(line).replaceAll(track, `<a href="${track}">${track}</a>`))
    .join("<br>\n");
  return `${mirrored}<br>\n<img src="${pixelUrl(tk)}" width="1" height="1" alt="" style="display:none">`;
}

/** 1x1 transparent GIF89a — the open-pixel payload. */
export const PIXEL_GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** ?name=… from req.url (hand-rolled like image.js — no URLSearchParams). */
export function qParam(url, name) {
  const q = String(url || "").split("?")[1] || "";
  for (const part of q.split("&")) {
    const kv = part.split("=");
    if (kv[0] === name) {
      try { return decodeURIComponent(kv[1] || ""); } catch { return kv[1] || ""; }
    }
  }
  return "";
}

export const trackEvt = (kind, tk, at, extra) =>
  JSON.stringify(Object.assign({ kind, tk, at }, extra));

// KV --------------------------------------------------------------------
async function kvFetch(path, body) {
  const res = await fetch(`${KV_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  // Single commands answer {"result": ...}; /pipeline answers a bare array of
  // {"result"|"error"} objects. Handle both.
  if (!res.ok || (data && data.error && !Array.isArray(data))) {
    const err = new Error(`KV error (${res.status}): ${(data && data.error) || res.statusText}`);
    err.kv = true;
    throw err;
  }
  return Array.isArray(data) ? data : (data ? data.result : null);
}

/** One Redis command. */
export async function kv(cmd, ...args) {
  return kvFetch("/", [cmd, ...args]);
}

/** N independent Redis commands in one pipeline (not atomic — fine here:
 *  every multi-key op is idempotent and re-runnable). */
export async function kvPipeline(commands) {
  return kvFetch("/pipeline", commands);
}

// Token gate + JSON plumbing --------------------------------------------
export function missingServerEnv(name) {
  // Called first so the browser never sees a raw stack on misconfiguration.
  if (!process.env[name]) return `server env ${name} is not set`;
  return "";
}

export function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 4_500_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function requireToken(req, res) {
  const got = req.headers["x-forge-token"] || "";
  if (!TOKEN) {
    json(res, 500, { error: "server env FORGE_CONSOLE_TOKEN is not set — the console refuses to run without it" });
    return false;
  }
  if (got !== TOKEN) {
    json(res, 401, { error: "invalid console token" });
    return false;
  }
  return true;
}

// Queue helpers shared by the API routes --------------------------------
export async function kvGetQueue() {
  const raw = await kv("GET", Q_QUEUE);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function kvGetDecisions() {
  const rows = await kv("LRANGE", Q_DECS, "0", "-1");
  return Array.isArray(rows) ? rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean) : [];
}

export function smtpConfig() {
  const host = process.env.FORGE_SMTP_HOST || "";
  const port = Number(process.env.FORGE_SMTP_PORT || (host === "smtp.zoho.com" ? "587" : "587"));
  const user = process.env.FORGE_SMTP_USER || "";
  const pass = process.env.FORGE_SMTP_PASS || "";
  const from = process.env.FORGE_EMAIL_FROM || user;
  const fromName = process.env.FORGE_EMAIL_FROM_NAME || "";
  const missing = [];
  for (const [k, v] of [["FORGE_SMTP_HOST", host], ["FORGE_SMTP_USER", user],
                         ["FORGE_SMTP_PASS", pass], ["FORGE_EMAIL_FROM", from]]) {
    if (!v) missing.push(k);
  }
  return { host, port, user, pass, from, fromName, missing };
}

// Batch review state (stage/lock) ------------------------------------------
export async function kvGetStaged() {
  const raw = await kv("GET", Q_STAGED);
  if (!raw) return [];
  try {
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export async function kvGetBatch() {
  const raw = await kv("GET", Q_BATCH);
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    return b && b.id && Array.isArray(b.items) ? b : null;
  } catch {
    return null;
  }
}

/**
 * Items of an active batch that have no sent decision yet. A batch item is
 * only ever SENT (rejections are decided at lock, they never enter the
 * batch), so the sent-decision IS the durable "done" marker: the SMTP
 * success LPUSHes it BEFORE the item status moves, and a later batchsend
 * delivery (next cron tick) that finds it heals the item status. Pending
 * derives from decisions, never
 * from item.status — a crash between SMTP and status-update can therefore
 * never wedge the batch.
 */
export function batchPending(batch, decisions) {
  if (!batch) return [];
  return batch.items.filter((i) => !decisions.some((d) => d.username === i.username));
}

const BATCH_LOCK_KEY = "forge:batchlock"; // serializes writers of forge:batch
const BATCH_LOCK_BUDGET_MS = 10_500; // give up acquiring after this long
const BATCH_LOCK_STEP_MS = 150; // poll interval while the lock is held
const BATCH_LOCK_TTL_MS = 20_000; // crash-safety: a dead writer releases the lock

/**
 * Serializes mutations of the forge:batch document. Only batchsend.js writes
 * it (tries bump, decided-heal, sent status after SMTP), but two overlapping
 * cron ticks can deliver concurrently — a naive read-modify-write
 * last-writer-wins on the whole document loses one writer's update
 * (observed in tests: a sent status rolled back to "queued"). fn() must
 * RE-READ forge:batch inside the lock and patch only its own item before
 * SETting the document again. NX semantics are server-side, so two
 * concurrent acquisitions can never both win.
 */
export async function withBatchLock(fn) {
  const token = crypto.randomBytes(12).toString("hex");
  const deadline = Date.now() + BATCH_LOCK_BUDGET_MS;
  for (;;) {
    const claimed = await kv("SET", BATCH_LOCK_KEY, token, "NX", "PX", String(BATCH_LOCK_TTL_MS));
    if (claimed === "OK") break;
    if (Date.now() > deadline) {
      throw new Error("batch lock busy — another send is mid-flight; the next tick will retry");
    }
    await new Promise((r) => setTimeout(r, BATCH_LOCK_STEP_MS));
  }
  try {
    await fn();
  } finally {
    // Only release our own hold (the TTL may have expired it mid-run).
    const mine = await kv("GET", BATCH_LOCK_KEY);
    if (mine === token) await kv("DEL", BATCH_LOCK_KEY);
  }
}

/** One SMTP send over nodemailer (Zoho creds = Vercel secrets). Throws on failure. */
export async function smtpSend(cfg, mail) {
  const nodemailer = (await import("nodemailer")).default;
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
  });
  try {
    const info = await transport.sendMail(mail);
    return (info && info.response ? info.response : "accepted by server").slice(0, 160);
  } finally {
    transport.close();
  }
}
