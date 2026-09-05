// POST /api/batchsend  { batch, secret, username }  ->  { ok: true|false, ... }
//
// /api/senddue relays the cron tick here (GitHub Actions, every 5 min — see
// lock.js/senddue.js). It delivers ONE approved email over SMTP and records
// the sent decision — the same recording shape as /api/decide, plus
// `via: "batch"` so the local pull worded the send record accordingly.
//
// No FORGE_CONSOLE_TOKEN gate here — the caller carries the batch secret,
// not a browser session. Auth is the batch secret: 24 random bytes chosen
// at lock time, stored in the forge:batch document that senddue reads (an
// attacker who guesses it can only re-trigger emails the reviewer already
// locked, each guarded below — never send, edit or reject anything else).
//
// Idempotence (an overlapping tick or a duplicate delivery must never
// double-send):
//   - a username with a sent decision answers 200 {skipped} — the send
//     already happened, stop here (this also heals the item status if a
//     crash between SMTP and status-update left it "queued");
//   - a per-item claim (SET forge:claim:<username> NX EX 3600) dedups
//     concurrent deliveries; a claim younger than 45 min means another
//     delivery is in flight — skip. Older than 45 min (a crashed attempt)
//     is stale: claim over it and retry.
//   - SMTP failure drops the claim and answers 502 — senddue surfaces it and
//     the next cron tick naturally retries — UNTIL the per-item retry cap
//     (MAX_TRIES below) is hit: a hard-failing email would otherwise starve
//     every later email in the batch AND wedge the console (a live batch
//     blocks lock/clear/push). At the cap the item is dead-lettered: a
//     `failed` decision (no subject/body/tk — nothing was delivered, there is
//     nothing to sync or track) and item.status = "failed", and the drip
//     moves on to the next queued email on the following tick.
//
// Reads NOTHING from the queue item: subject/body/email/attachment flag are
// the snapshot frozen in the batch record at lock time — a send ships
// exactly what the reviewer locked, even if the console was re-pushed since.
//
// Tracking (every delivery): a fresh tk is built per attempt and the frozen
// body is mechanically rewritten — the signature URL becomes the tracked
// /api/r?tk=… link, mirrored into an HTML part with the open pixel. That is
// the ONLY post-freeze mutation, and it happens at build time below. The
// recorded decision carries the REWRITTEN body (the exact bytes SMTP
// shipped), so the local pull syncs the md to reality.

import crypto from "node:crypto";

import { json, readBody, kv, kvPipeline, kvGetDecisions, kvGetBatch, smtpConfig, smtpSend, withBatchLock, rewriteText, htmlMirror, trackKey, tkMapKey, trackEvt, Q_DECS, Q_BATCH, Q_TRK_USERS, imgKey, claimKey, TRK_MAP_TTL_S, TRK_LIST_CAP } from "./_lib.js";

const CLAIM_FRESH_MS = 45 * 60 * 1000; // a claim older than this is a crashed attempt
// Failed-attempt cap before an item is dead-lettered (see header). A value of
// 3 = ~15-30 min of cron ticks before a broken address stops blocking the
// batch — bounded, never infinite again.
const MAX_TRIES = Math.max(1, parseInt(process.env.FORGE_BATCH_MAX_TRIES || "3", 10) || 3);
const TK_RE = /\?tk=([0-9a-f]{24})/;   // extracts the tracking token from a recorded body

/**
 * Idempotent tracking re-apply for the heal path: a crash between SMTP
 * success and the pipeline write leaves a decision but no events — the next
 * tick must close the gap. The tk lives in the recorded body (the tracked
 * text is what decisions store); a legacy pre-tracking decision has none and
 * needs nothing. KV failures are swallowed — the next tick tries again.
 */
async function healTracking(username, prior) {
  const m = TK_RE.exec(prior.body || "");
  if (!m) return;
  const tk = m[1];
  const rows = await kv("LRANGE", trackKey(username), "0", "-1").catch(() => null);
  if (!Array.isArray(rows)) return;
  const hasSent = rows.some((r) => {
    try { const e = JSON.parse(r); return e.kind === "sent" && e.tk === tk; } catch { return false; }
  });
  if (hasSent) return;
  await kvPipeline([
    ["SET", tkMapKey(tk), JSON.stringify({ username, sentAt: prior.at }), "EX", String(TRK_MAP_TTL_S)],
    ["LPUSH", trackKey(username), trackEvt("sent", tk, prior.at)],
    ["LTRIM", trackKey(username), "0", String(TRK_LIST_CAP - 1)],
    ["SADD", Q_TRK_USERS, username],
  ]).catch(() => {});
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  const { username } = body;
  if (!body.batch || !body.secret || !username) {
    return json(res, 400, { error: "batch + secret + username required" });
  }

  const [batch, decisions] = await Promise.all([kvGetBatch(), kvGetDecisions()]);
  const item = batch && batch.id === body.batch && batch.items.find((i) => i.username === username);

  // Secret check only against the REAL batch record (timing-safe-ish: same
  // length compare). A missing batch + an existing decision means the batch
  // finished and was cleared — benign, stop retries with a 200.
  if (!batch) {
    const prior = decisions.find((d) => d.username === username);
    return json(res, 200, { ok: false, skipped: prior ? "decided" : "unknown batch" });
  }
  const bA = Buffer.from(batch.secret);
  const bB = Buffer.from(String(body.secret));
  const secretOk = bA.length === bB.length && crypto.timingSafeEqual(bA, bB);
  if (!secretOk) {
    return json(res, 401, { error: "bad batch secret" });
  }
  if (!item) {
    return json(res, 200, { ok: false, skipped: "not in batch" });
  }

  const prior = decisions.find((d) => d.username === username);
  if (prior) {
    // Tracking heal first: a crash between SMTP success and the pipeline
    // write left the sent decision without its events — re-apply them
    // idempotently from the tk embedded in the recorded (tracked) body.
    await healTracking(username, prior);
    // Heal: the decision is the durable truth — make the item match it.
    // Action-gated: only a `sent` decision heals the item to sent; a `failed`
    // decision (dead-letter — a crash between the decision write and the
    // status write) converges it to failed instead. Anything else leaves the
    // item untouched.
    // Serialized under withBatchLock against a FRESH read: the document
    // snapshot read above may already be stale (another delivery wrote it
    // meanwhile), and a whole-document SET would roll their update back.
    await withBatchLock(async () => {
      const cur = await kvGetBatch();
      const it = cur && cur.id === body.batch && cur.items.find((i) => i.username === username);
      if (!it) return;
      if (prior.action === "sent" && it.status !== "sent") {
        it.status = "sent";
        it.sentAt = prior.at;
        await kv("SET", Q_BATCH, JSON.stringify(cur));
      } else if (prior.action === "failed" && it.status !== "failed") {
        it.status = "failed";
        it.error = prior.detail ? `SMTP send failed — ${String(prior.detail).slice(0, 200)}` : "SMTP send failed (dead-lettered)";
        await kv("SET", Q_BATCH, JSON.stringify(cur));
      }
    });
    await kv("DEL", claimKey(username));
    return json(res, 200, { ok: false, skipped: "decided" });
  }

  // ---- claim: one delivery per item ---------------------------------------
  const claim = JSON.stringify({ batch: batch.id, at: new Date().toISOString() });
  const claimed = await kv("SET", claimKey(username), claim, "NX", "EX", "3600");
  if (claimed === null) {
    const existingRaw = await kv("GET", claimKey(username));
    let existing = null;
    try { existing = existingRaw ? JSON.parse(existingRaw) : null; } catch { existing = null; }
    if (existing && existing.batch === batch.id && Date.now() - new Date(existing.at).getTime() < CLAIM_FRESH_MS) {
      return json(res, 200, { ok: false, skipped: "claimed" }); // another delivery is on it
    }
    // stale claim -> fall through and take it over
  }

  // ---- deliver -------------------------------------------------------------
  const at = new Date().toISOString();
  const cfg = smtpConfig();
  if (cfg.missing.length) {
    await kv("DEL", claimKey(username));
    return json(res, 500, { error: `SMTP not configured on the server — missing env: ${cfg.missing.join(", ")}` });
  }

  const from = cfg.fromName ? `"${cfg.fromName.replace(/"/g, "'")}" <${cfg.from}>` : cfg.from;
  // Tracking: a fresh tk per attempt; the locked body gets ONE mechanical
  // rewrite — the signature URL becomes the tracked /api/r?tk=… link —
  // mirrored into an HTML part (multipart/alternative) carrying the open
  // pixel. The rewritten text is what SMTP ships AND what the decision records.
  const tk = crypto.randomBytes(12).toString("hex");
  const textBody = rewriteText(item.body, tk);
  const mail = {
    from,
    to: item.email,
    subject: item.subject, // the locked snapshot, verbatim
    text: textBody,
    html: htmlMirror(textBody, tk),
  };
  if (item.attach && item.attach.present) {
    const b64 = await kv("GET", imgKey(username));
    if (b64) {
      mail.attachments = [{ filename: item.attach.filename || "app-preview.png", content: Buffer.from(b64, "base64") }];
    }
  }

  // Bump tries on a fresh read under the batch lock (two overlapping ticks
  // can race this document).
  await withBatchLock(async () => {
    const cur = await kvGetBatch();
    const it = cur && cur.id === body.batch && cur.items.find((i) => i.username === username);
    if (it) {
      it.tries = (it.tries || 0) + 1;
      await kv("SET", Q_BATCH, JSON.stringify(cur));
    }
  });

  try {
    const detail = await smtpSend(cfg, mail);
    // Tracking + decision in ONE pipeline: tk map, the sent event
    // (LPUSH/LTRIM), the trkusers set — then the decision LAST, the durable
    // "done" marker (see batchPending), so decision-exists => tracking-exists.
    // The decision carries the REWRITTEN body (the exact bytes SMTP shipped),
    // so the local --send-pull syncs the md to reality.
    await kvPipeline([
      ["SET", tkMapKey(tk), JSON.stringify({ username, sentAt: at }), "EX", String(TRK_MAP_TTL_S)],
      ["LPUSH", trackKey(username), trackEvt("sent", tk, at, { via: "batch" })],
      ["LTRIM", trackKey(username), "0", String(TRK_LIST_CAP - 1)],
      ["SADD", Q_TRK_USERS, username],
      ["LPUSH", Q_DECS, JSON.stringify({
        username, action: "sent", at, to: item.email,
        subject: item.subject, body: textBody,
        revised: item.revised, revision: item.revision || "",
        detail, via: "batch",
      })],
    ]);
    // Same fresh-read discipline as the heal path — never SET the snapshot.
    await withBatchLock(async () => {
      const cur = await kvGetBatch();
      const it = cur && cur.id === body.batch && cur.items.find((i) => i.username === username);
      if (it) {
        it.status = "sent";
        it.sentAt = at;
        await kv("SET", Q_BATCH, JSON.stringify(cur));
      }
    });
    await kv("DEL", claimKey(username));
    return json(res, 200, { ok: true, action: "sent", at, detail });
  } catch (e) {
    const why = e && e.response ? e.response : String(e.message || e);
    const short = String(why).slice(0, 300);
    // Dead-letter at the retry cap (see header). Fresh read under the batch
    // lock — the tries bump above was on another fresh read, and two
    // overlapping ticks can race this document.
    let tries = 0;
    let deadAt = "";
    try {
      await withBatchLock(async () => {
        const cur = await kvGetBatch();
        const it = cur && cur.id === body.batch && cur.items.find((i) => i.username === username);
        if (!it) return;
        tries = it.tries || 0;
        if (tries < MAX_TRIES) return; // below the cap: plain retry next tick
        deadAt = new Date().toISOString();
        // No subject, no body, no tk: the email never left. The `failed`
        // decision terminates the item for batchPending (the console unlocks)
        // and the local pull records it as status send_failed on the md.
        await kv("LPUSH", Q_DECS, JSON.stringify({
          username, action: "failed", at: deadAt, to: item.email,
          tries, via: "batch",
          detail: `SMTP send failed after ${tries} attempts — ${short}`,
        }));
        it.status = "failed";
        it.error = `SMTP failed after ${tries} attempts`;
        await kv("SET", Q_BATCH, JSON.stringify(cur));
      });
    } catch {
      // batch lock busy (another delivery mid-flight): fall through to the
      // plain 502 — the next tick's attempt dead-letters once the cap is hit.
    }
    // Claim dropped either way: the next cron tick retries naturally.
    await kv("DEL", claimKey(username));
    if (deadAt) {
      return json(res, 200, { ok: true, action: "failed", at: deadAt, tries, detail: `SMTP send failed after ${tries} attempts — ${short}` });
    }
    return json(res, 502, { error: `SMTP send failed — ${short}` });
  }
}
