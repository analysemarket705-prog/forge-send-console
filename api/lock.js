// POST /api/lock  { confirm, missingOnly? }  ->  { ok, batch }
//
// The single human gate for the whole batch review: staged approvals and
// rejections become real here, ONCE. There is no per-email confirmation —
// typing "ENVOYER N" (N = number of approvals being locked) replaces typing
// every recipient address, and the string is checked SERVER-SIDE (the UI
// never tells the server it has confirmed; the server compares the phrase
// itself, uppercased+trimmed).
//
// What lock does, in order:
//   1. records every staged REJECTION as a rejected_manual decision
//      immediately — a rejected draft must never be re-reviewed later;
//   2. snapshots every staged APPROVAL into a batch record (forge:batch):
//      username, email, the EXACT subject/body text to send, the mockup
//      flag — the queue item is no longer read at send time, so a later
//      push/edit can never change what a scheduled send ships;
//   3. marks every item published and leaves the batch in the KV. There is
//      no external scheduler call here: a GitHub Actions cron (every 5 min,
//      see .github/workflows/send-due.yml) ticks /api/senddue, which paces
//      the batch at ONE email per tick — the first send lands on the tick
//      after the lock, each following email one tick later, so real spacing
//      is one email every 5-10 min. The random cumulative delays below only
//      feed the per-item scheduleAt/ETA display. The reviewer can close the
//      tab: the cron, not this function, keeps the calendar alive, and a
//      stalled cron self-heals — senddue fires the oldest queued item
//      regardless of how late it is.
//
// Refuses to run while an active batch is still delivering (409) — one
// batch at a time. All rejections and approvals must exist in forge:staged;
// staging happens through /api/stage on each card.

import crypto from "node:crypto";

import {
  json, requireToken, readBody, kv, kvGetQueue, kvGetDecisions, kvGetStaged,
  kvGetBatch, batchPending, smtpConfig,
  Q_DECS, Q_STAGED, Q_BATCH,
} from "./_lib.js";

const RANDOM_MIN = 300; // s — spacing floor
const RANDOM_SPAN = 301; // s — spacing floor + [0,301) -> 300-600 s between sends

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!requireToken(req, res)) return;

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  const confirm = (typeof body.confirm === "string" ? body.confirm : "").trim().toUpperCase();
  const missingOnly = body.missingOnly === true;
  const rejectReason = (typeof body.rejectReason === "string" ? body.rejectReason.trim() : "")
    .slice(0, 500); // optional, applied to every staged rejection at lock

  const [queue, decisions, staged, active] = await Promise.all([
    kvGetQueue(), kvGetDecisions(), kvGetStaged(), kvGetBatch(),
  ]);

  // ---- which items does this lock schedule? ------------------------------
  let targets = []; // { queue item, snapshot } to schedule NOW
  if (active) {
    // The batch record exists. Nothing is ever "missing" from the scheduler
    // anymore (senddue fires the oldest queued item on every cron tick, so a
    // stalled cron self-heals without a relock) — a plain lock refuses while
    // a batch delivers; missingOnly exists only for API compatibility and
    // finds nothing to do.
    const missing = batchPending(active, decisions)
      .filter((i) => !i.published)
      .map((i) => queue.find((q) => q.username === i.username))
      .filter(Boolean);
    if (!missingOnly) {
      return json(res, 409, {
        error: `a batch is already delivering (${active.items.length - missing.length} of ${active.items.length} scheduled). `
             + "Wait for its sends to complete, then --send-pull and start a new review.",
        batch: summarize(active),
      });
    }
    if (!missing.length) {
      return json(res, 409, { error: "nothing missing to schedule — every batch item is delivered or still within its window.", batch: summarize(active) });
    }
    targets = missing.map((item) => ({ item, into: active }));
  } else {
    const approved = staged.filter((s) => s.choice === "approved");
    const queued = approved.filter((s) => queue.some((q) => q.username === s.username) && !decisions.some((d) => d.username === s.username));
    if (!queued.length) {
      const noneLeft = staged.length > 0;
      return json(res, 400, {
        error: noneLeft
          ? "every staged draft is already decided — refresh the review."
          : "nothing staged — mark each card ✓ Valider or ✗ Rejeter first, then lock the batch.",
      });
    }
    if (missingOnly) {
      return json(res, 409, { error: "no batch record exists — a plain lock starts the batch." });
    }
    targets = queued.map((s) => ({ item: queue.find((q) => q.username === s.username), into: null }));
  }

  // ---- the one typed confirmation, checked server-side -------------------
  const expected = `ENVOYER ${targets.length}`;
  if (confirm !== expected) {
    return json(res, 400, {
      error: `confirmation mismatch — type exactly “${expected}” (${targets.length} email${targets.length > 1 ? "s" : ""} will be sent on a 5-10 min interval).`,
    });
  }

  const smtp = smtpConfig();
  if (smtp.missing.length) {
    return json(res, 500, { error: `SMTP not configured on the server — missing env: ${smtp.missing.join(", ")}` });
  }

  // ---- 1. staged rejections become decisions NOW --------------------------
  const rejected = staged.filter((s) => s.choice === "rejected");
  const at = new Date().toISOString();
  for (const s of rejected) {
    const prior = decisions.find((d) => d.username === s.username);
    if (!prior) {
      await kv("LPUSH", Q_DECS, JSON.stringify({
        username: s.username, action: "rejected_manual", at,
        reason: rejectReason || "rejected during the console batch review (no reason given)",
      }));
    }
  }
  const lockedUsernames = [...rejected.map((s) => s.username), ...targets.map((t) => t.item.username)];
  await kv("SET", Q_STAGED, JSON.stringify(staged.filter((s) => !lockedUsernames.includes(s.username))));

  // ---- 2. the batch record, persisted before the response -----------------
  let batch = active;
  if (!batch) {
    batch = {
      id: `b${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
      secret: crypto.randomBytes(24).toString("hex"),
      at,
      locked: targets.map((t) => t.username), // the review decision record (order of approval)
      items: [],
    };
  }
  const now = Date.now();
  let cumulative = 0;
  const fresh = targets.map((t) => {
    const q = t.item;
    const att = q.attachment || {};
    cumulative = targets.indexOf(t) === 0 ? 0 : cumulative + RANDOM_MIN + Math.floor(Math.random() * RANDOM_SPAN);
    return {
      username: q.username,
      email: q.email_address,
      subject: q.subject,          // <-- the exact text, frozen at lock time
      body: q.body,
      revised: !!q.revised,
      revision: q.revision || "",
      attach: { filename: att.filename || "app-preview.png", present: Boolean(att.present) },
      delaySec: cumulative,        // ETA display only — the real pacing is one
      scheduleAt: new Date(now + cumulative * 1000).toISOString(), // email per cron tick (see /api/senddue)
      status: "queued",            // "queued" -> "sent"; decisions are the durable truth (see _lib.batchPending)
      published: true,             // handed to the scheduler = always (no publish step can fail)
      tries: 0,
    };
  });
  const byName = new Map(batch.items.map((i) => [i.username, i]));
  for (const f of fresh) {
    const existing = byName.get(f.username);
    if (existing) Object.assign(existing, f); // (legacy missingOnly path: refresh the ETA)
    else {
      batch.items.push(f);
      byName.set(f.username, f);
    }
  }
  await kv("SET", Q_BATCH, JSON.stringify(batch));

  // ---- 3. the schedule lives in the KV; the cron ticks it ----------------
  // No publish step: /api/senddue (GitHub Actions, every 5 min) reads this
  // batch and fires ONE queued item per tick. Re-read for the response so
  // the reply is fresh even if a tick raced the persist.
  const finalBatch = (await kvGetBatch()) || batch;
  json(res, 200, { ok: true, batch: summarize(finalBatch) });
}

function summarize(batch) {
  return {
    id: batch.id,
    at: batch.at,
    items: batch.items.map((i) => ({
      username: i.username, email: i.email, subject: i.subject,
      delaySec: i.delaySec, scheduleAt: i.scheduleAt, status: i.status,
      published: i.published, tries: i.tries,
    })),
  };
}
