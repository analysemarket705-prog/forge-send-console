// POST /api/clear  { applied: [username, ...] }  ->  { ok, queue, decisions, images }
//
// The local `--send-pull` calls this after walking every recorded decision:
// queue + decisions + staged + batch + image keys all go away and the
// console is empty again, ready for the next push. `applied` lists the
// usernames the pull just processed (recorded into an md, ignored as
// already-terminal, or abandoned loudly because the md is gone) — the clear
// refuses only when a decision exists that the pull did NOT walk, or when a
// batch item still has no sent decision (its scheduled send is still
// coming — the image key must not vanish before the send), so nothing can
// ever be lost between the console and the local side.

import { json, requireToken, readBody, kv, kvPipeline, kvGetDecisions, kvGetBatch,
         batchPending, Q_QUEUE, Q_IMGS, Q_DECS, Q_STAGED, Q_BATCH, imgKey } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!requireToken(req, res)) return;

  let body = {};
  try {
    body = await readBody(req);
  } catch {
    body = {};
  }
  const applied = Array.isArray(body.applied) ? body.applied : [];

  const [decisions, batch] = await Promise.all([
    kvGetDecisions(), kvGetBatch(),
  ]);
  const pending = decisions.filter((d) => !applied.includes(d.username));
  if (pending.length) {
    return json(res, 409, {
      error: `${pending.length} decision(s) not walked by the pull: `
           + pending.map((d) => d.username).join(", ")
           + " — run --send-pull first so no send/reject record is lost.",
      pending,
    });
  }
  const stillSending = batchPending(batch, decisions);
  if (stillSending.length) {
    return json(res, 409, {
      error: `batch ${batch.id} is still delivering — ${stillSending.length} item(s) have no sent decision yet `
           + `(${stillSending.map((i) => i.username).join(", ")}). The console cannot be cleared before `
           + "their scheduled sends land. Check back after the last scheduled time.",
      batch: batch.id,
    });
  }

  const prevImgs = JSON.parse((await kv("GET", Q_IMGS)) || "[]");
  await kvPipeline([
    ["DEL", Q_QUEUE],
    ["DEL", Q_DECS],
    ["DEL", Q_IMGS],
    ["DEL", Q_STAGED],
    ["DEL", Q_BATCH],
    ...(prevImgs.length ? [["DEL", ...prevImgs.map(imgKey)]] : []),
  ]);

  json(res, 200, { ok: true, queue: 0, decisions: 0, images: prevImgs.length });
}
