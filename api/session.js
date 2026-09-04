// GET /api/session  ->  { queue, decisions, staged, batch, serverAt }
// The page renders from this one call. Queue items carry no image payload
// (they are fetched per-username through /api/image); decisions are the
// sends/rejects recorded since the last push — the local `--send-pull`
// applies them to the draft mds and then clears this console. `staged` is
// the pre-lock review (approved/rejected marks), `batch` the running
// delivery {id, items:[{username, delaySec, scheduleAt, status, ...}]}.

import { json, requireToken, kvGetQueue, kvGetDecisions, kvGetStaged, kvGetBatch } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });
  if (!requireToken(req, res)) return;

  const [queue, decisions, staged, batch] = await Promise.all([
    kvGetQueue(), kvGetDecisions(), kvGetStaged(), kvGetBatch(),
  ]);
  json(res, 200, {
    queue,
    decisions,
    staged,
    batch,
    serverAt: new Date().toISOString(),
  });
}
