// POST /api/senddue  ->  { ok, pending, fired? } | { ok: false, error }
//
// The GitHub Actions cron (see ../.github/workflows/send-due.yml, every
// 5 min) POSTs here to tick the locked batch. Pacing rule: at most ONE
// email per tick — the first queued item (by scheduleAt) is relayed to
// /api/batchsend; the next email goes at the following tick, so real
// spacing is one email every 5-10 min by construction. A tick that finds
// no batch or nothing queued is a cheap no-op, and a stalled cron
// self-heals: the oldest queued item fires on the first tick after the
// stall, regardless of how late it is.
//
// Auth: FORGE_CONSOLE_TOKEN (x-forge-token), like the rest of the console —
// the workflow holds it as a GitHub secret. The relay body carries the
// batch secret read from the forge:batch document, which is batchsend's own
// auth; SMTP creds never leave the Vercel secrets.

import { json, requireToken, readBody, kv, kvGetBatch } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!requireToken(req, res)) return;
  try {
    await readBody(req); // drain — the workflow sends {} anyway
  } catch {
    /* empty body is fine for a tick */
  }

  const batch = await kvGetBatch();
  if (!batch) return json(res, 200, { ok: true, pending: 0 });

  const queued = batch.items
    .filter((i) => i.status === "queued")
    .sort((a, b) => (a.scheduleAt < b.scheduleAt ? -1 : a.scheduleAt > b.scheduleAt ? 1 : 0));
  if (!queued.length) return json(res, 200, { ok: true, pending: 0 });

  const next = queued[0];
  const base = (process.env.FORGE_CONSOLE_URL || "").replace(/\/+$/, "");
  try {
    const r = await fetch(`${base}/api/batchsend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch: batch.id, secret: batch.secret, username: next.username }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 200);
      return json(res, r.status, { ok: false, error: `batchsend ${r.status}: ${text}`, pending: queued.length });
    }
    let data = {};
    try { data = await r.json(); } catch { /* 200 without a JSON body */ }
    // ok:false => batchsend skipped it (claim held by an overlapping tick,
    // or the decision landed between our read and the relay) — nothing fired.
    if (data.ok === false) {
      return json(res, 200, { ok: true, skipped: data.skipped || "batchsend skipped", pending: queued.length });
    }
    return json(res, 200, { ok: true, fired: next.username, pending: queued.length - 1 });
  } catch (e) {
    return json(res, 502, { ok: false, error: String(e.message || e), pending: queued.length });
  }
}
