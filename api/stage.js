// POST /api/stage
//   { username, choice: "approved"|"rejected"|null }  ->  { ok, staged }
//   { reset: true }                                     ->  { ok, reset, cleared }
//
// The batch review flow: instead of deciding each card on the spot (old
// /api/decide — send/reject recorded immediately), the reviewer walks the
// queue and marks every card "approved" or "rejected" with one click. These
// marks live in forge:staged — NO decision is recorded, NOTHING is sent —
// until the single /api/lock turns the whole staged review into decisions +
// scheduled sends. choice null (or "none") removes a previous mark.
//
// The {reset:true} dispatch clears every mark in ONE atomic SET (the client
// used to POST N sequential clears; now it is a single ↺ click). It refuses
// while a batch is still delivering — the review is inert during the
// delivery, so resetting would clear marks that silently would not apply —
// but a finished batch record is fine (its decisions are what matter).
//
// Guards, server-side so two tabs can't disagree:
//   - the username must be a queued, undecided draft (404/409);
//   - staging is refused while an active batch is still sending (409) —
//     the review happens before the lock, not during the delivery;
//   - a staged username still answers 409 to /api/revise and /api/decide
//     (revise.js/decide.js), so editing under a pending verdict is impossible.

import { json, requireToken, readBody, kv, kvGetQueue, kvGetDecisions, kvGetStaged, kvGetBatch,
         batchPending, Q_STAGED } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!requireToken(req, res)) return;

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  // B.3 — atomic review reset: {reset:true}, no username.
  if (body && body.reset === true) {
    const [decisions, batch, staged] = await Promise.all([
      kvGetDecisions(), kvGetBatch(), kvGetStaged(),
    ]);
    if (batch) {
      const still = batchPending(batch, decisions);
      if (still.length) {
        return json(res, 409, {
          error: `batch ${batch.id} is still delivering — ${still.length} scheduled send(s) have not landed yet. `
               + "The review is inert until the batch ends; the marks it froze cannot be reset now.",
          batch: { id: batch.id, pending: still.map((i) => i.username) },
        });
      }
    }
    const cleared = staged.length;
    await kv("SET", Q_STAGED, "[]"); // kvGetStaged parses [] on empty/falsy — safe either way
    return json(res, 200, { ok: true, reset: true, cleared });
  }

  const { username } = body;
  const choice = body.choice === null || body.choice === undefined || body.choice === "none"
    ? null
    : body.choice === "approved" || body.choice === "rejected" ? body.choice : "invalid";
  if (!username || choice === "invalid") {
    return json(res, 400, { error: 'username + choice ("approved"|"rejected"|null) or {reset:true} required' });
  }

  const [queue, decisions, staged, batch] = await Promise.all([
    kvGetQueue(), kvGetDecisions(), kvGetStaged(), kvGetBatch(),
  ]);
  const item = queue.find((q) => q.username === username);
  if (!item) return json(res, 404, { error: `no queued draft for ${username}` });

  const prior = decisions.find((d) => d.username === username);
  if (prior) {
    return json(res, 409, {
      error: `${username} was already ${prior.action === "sent" ? "SENT" : "rejected"} `
           + `at ${prior.at} — a decided draft cannot be staged. Refresh to see the recorded decision.`,
    });
  }

  if (batch && batch.items.some((i) => i.username === username)) {
    return json(res, 409, { error: `${username} is inside the running batch — it can no longer be re-reviewed.` });
  }

  const rest = staged.filter((s) => s.username !== username);
  if (choice) rest.push({ username, choice, at: new Date().toISOString() });
  await kv("SET", Q_STAGED, JSON.stringify(rest));

  json(res, 200, { ok: true, username, choice, staged: rest });
}
