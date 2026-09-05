// POST /api/reply  { username, outcome }  ->  { ok, at, outcome, username, replies }
//
// Semi-manual reply counting (Zoho free has no IMAP — the server cannot
// read the mailbox; the reviewer marks replies in the KPI tab). outcome is
// one of positive / neutral / negative / bounce — or EMPTY, which removes
// the reply mark (a mis-click stays reversible). REPLACE semantics: a
// re-mark overwrites the previous reply, so corrections never double-count.
// 404 when the prospect has no tracked send (a reply to an untracked email
// cannot be counted here). Console token required.

import { json, requireToken, readBody, kv, kvPipeline, trackKey, trackEvt, OUTCOMES, TRK_LIST_CAP } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!requireToken(req, res)) return;

  let body = {};
  try {
    body = await readBody(req);
  } catch {
    body = {};
  }
  const { username } = body;
  const outcome = typeof body.outcome === "string" ? body.outcome : "";
  if (!username) return json(res, 400, { error: "username required" });
  if (outcome && !OUTCOMES.includes(outcome)) {
    return json(res, 400, { error: `outcome must be one of: ${OUTCOMES.join(", ")}, or empty to clear the mark` });
  }

  const rows = await kv("LRANGE", trackKey(username), "0", "-1").catch(() => null);
  const events = Array.isArray(rows)
    ? rows.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean)
    : [];
  // The tk of the newest sent event is what this reply answers (there is at
  // most one send per prospect; the guard keeps the reply event well-formed).
  let tk = null;
  for (const e of events) {
    if (e.kind === "sent") { tk = e.tk; break; }
  }
  if (!tk) {
    return json(res, 404, { error: `${username} has no tracked send — nothing to reply to` });
  }

  // Replace semantics: drop any previous reply, re-push the survivors in
  // their current (newest-first) order, then the new reply on top — or no
  // reply when outcome is empty (clear the mark). One pipeline keeps the
  // write atomic enough for a human-paced control.
  const survivors = events.filter((e) => e.kind !== "reply");
  const at = new Date().toISOString();
  const cmds = [["DEL", trackKey(username)]];
  for (let i = survivors.length - 1; i >= 0; i--) {
    cmds.push(["LPUSH", trackKey(username), JSON.stringify(survivors[i])]);
  }
  if (outcome) {
    cmds.push(["LPUSH", trackKey(username), trackEvt("reply", tk, at, { outcome })]);
  }
  cmds.push(["LTRIM", trackKey(username), "0", String(TRK_LIST_CAP - 1)]);
  await kvPipeline(cmds).catch(() => {});

  return json(res, 200, {
    ok: true, username, outcome: outcome || null, at,
    replies: outcome ? 1 : 0, // replace semantics: ≤1 reply event on file after the write
  });
}
