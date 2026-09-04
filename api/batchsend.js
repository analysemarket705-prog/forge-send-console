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
//   - SMTP failure records NOTHING, drops the claim and answers 502 —
//     senddue surfaces it and the next cron tick naturally retries.
//
// Reads NOTHING from the queue item: subject/body/email/attachment flag are
// the snapshot frozen in the batch record at lock time — a send ships
// exactly what the reviewer locked, even if the console was re-pushed since.

import crypto from "node:crypto";

import { json, readBody, kv, kvGetDecisions, kvGetBatch, smtpConfig, smtpSend, withBatchLock, Q_DECS, Q_BATCH, imgKey, claimKey } from "./_lib.js";

const CLAIM_FRESH_MS = 45 * 60 * 1000; // a claim older than this is a crashed attempt

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
    // Heal: the decision is the durable truth — make the item match it.
    // Serialized under withBatchLock against a FRESH read: the document
    // snapshot read above may already be stale (another delivery wrote it
    // meanwhile), and a whole-document SET would roll their update back.
    await withBatchLock(async () => {
      const cur = await kvGetBatch();
      const it = cur && cur.id === body.batch && cur.items.find((i) => i.username === username);
      if (it && it.status !== "sent") {
        it.status = "sent";
        it.sentAt = prior.at;
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
  const mail = {
    from,
    to: item.email,
    subject: item.subject, // the locked snapshot, verbatim
    text: item.body,
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
    // Record the EXACT text that went out (frozen at lock) so the local
    // --send-pull can sync the draft md to reality. LPUSH BEFORE the status
    // update: the decision is the durable "done" marker (see batchPending).
    await kv("LPUSH", Q_DECS, JSON.stringify({
      username, action: "sent", at, to: item.email,
      subject: item.subject, body: item.body,
      revised: item.revised, revision: item.revision || "",
      detail, via: "batch",
    }));
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
    // Nothing recorded, claim dropped: the next cron tick retries naturally.
    await kv("DEL", claimKey(username));
    return json(res, 502, { error: `SMTP send failed — ${String(why).slice(0, 300)}` });
  }
}
