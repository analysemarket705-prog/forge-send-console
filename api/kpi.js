// GET  /api/kpi              ->  { totals, rows }
// POST /api/kpi  — two reviewer actions, same route:
//   { username, outcome }        ->  { ok, at, outcome, username, replies }
//   { username, clearSelf: true }->  { ok, username, removed }
//
// One token-gated resource behind the KPI tab — two methods on the same
// route keep the serverless-function count under the Hobby cap (12 per
// deployment; every file in api/ is one function, so new endpoints are
// merged into existing files, not added).
//
// GET folds the tracking events (forge:trkusers set + forge:trk:<u> lists)
// into the numbers the tab shows. Events per prospect, newest first:
//   {kind:"sent", tk, at}              — one per delivered batch email
//   {kind:"open",  tk, at}             — one per pixel fetch (proxy-prone)
//   {kind:"click", tk, at}             — one per tracked-link redirect
//   {kind:"reply", tk, at, outcome}    — set semi-manually via POST /api/kpi
// Opened is folded as ">=1 open + first-open delay" (a proxy fetch is not a
// human open, so counting fetches as reads would overstate); clicks count
// events. Replies carry an outcome. Empty store -> all-zero totals, never
// an error. Rows sorted by sentAt desc. This data lives in keys the console
// clear never touches, so it survives the review lifecycle by design.
//
// POST is the reviewer's semi-manual bookkeeping (Zoho free has no IMAP —
// the server cannot read the mailbox; the reviewer marks replies and cleans
// self-tests in the KPI tab). The pixel/click endpoints carry no identity
// (no IP/UA ever stored, by design) so the reviewer's OWN fetches — opening
// the sent copy in Zoho's Sent folder to check it, test-clicking the link —
// are indistinguishable from a prospect's at record time. Both POST shapes
// keep this honest with explicit reviewer actions:
//   { username, outcome }         reply mark: positive / neutral / negative /
//                                 bounce — or EMPTY, which removes the mark
//                                 (a mis-click stays reversible). REPLACE
//                                 semantics: a re-mark overwrites the previous
//                                 reply, so corrections never double-count.
//   { username, clearSelf: true } "c'était moi": drops the prospect's open and
//                                 click events (the reviewer's own checks)
//                                 from the folds. The sent baseline and any
//                                 reply marks survive — the row stays, only
//                                 fetch-attributable noise goes. Idempotent:
//                                 nothing to drop answers removed: 0.
// 404 when the prospect has no tracked send (nothing to reply to / to clear).

import { json, requireToken, readBody, kv, kvPipeline, Q_TRK_USERS, trackKey, trackEvt, OUTCOMES, TRK_LIST_CAP } from "./_lib.js";

const OUTCOME_LABELS = { positive: "positive", neutral: "neutral", negative: "negative", bounce: "bounce" };

function parseRows(rawRows) {
  if (!Array.isArray(rawRows)) return [];
  const out = [];
  for (const r of rawRows) {
    try {
      const e = JSON.parse(r);
      if (e && typeof e.kind === "string") out.push(e);
    } catch {
      // one corrupt event never kills the whole tab
    }
  }
  return out;
}

function fold(events) {
  // events are newest-first; walk them and keep the FIRST occurrence of each
  // "first" metric (i.e. the oldest open/click is the last matching element).
  let sentAt = null;
  let openEvents = 0;
  let clickEvents = 0;
  let firstOpenAt = null;
  let firstClickAt = null;
  let lastSentTk = null;
  const replies = [];
  for (const e of events) {
    if (e.kind === "sent") {
      if (!sentAt) sentAt = e.at;
      if (!lastSentTk) lastSentTk = e.tk;
    } else if (e.kind === "open") {
      openEvents += 1;
      if (e.at) firstOpenAt = firstOpenAt === null ? e.at : minAt(firstOpenAt, e.at);
    } else if (e.kind === "click") {
      clickEvents += 1;
      if (e.at) firstClickAt = firstClickAt === null ? e.at : minAt(firstClickAt, e.at);
    } else if (e.kind === "reply") {
      const outcome = OUTCOME_LABELS[e.outcome] ? e.outcome : "neutral";
      replies.push({ at: e.at, outcome });
    }
  }
  return { sentAt, lastSentTk, openEvents, clickEvents, firstOpenAt, firstClickAt, replies };
}

function minAt(a, b) {
  return b < a ? b : a; // ISO strings compare lexicographically
}

function delaySec(from, to) {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return ms >= 0 && Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

async function markReply(res, body) {
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

async function clearSelf(res, body) {
  const { username } = body;
  if (!username) return json(res, 400, { error: "username required" });

  const events = parseRows(await kv("LRANGE", trackKey(username), "0", "-1").catch(() => null));
  // Same tracked-send guard as markReply: without a sent event there is
  // nothing whose noise could be cleared.
  const sent = events.find((e) => e.kind === "sent");
  if (!sent) {
    return json(res, 404, { error: `${username} has no tracked send — nothing to clear` });
  }

  // Drop fetch-attributable events only (the reviewer's own Sent-folder
  // opens and test clicks); the sent baseline and deliberate reply marks
  // survive. Rewrite the list in place, same shape as markReply's replace.
  const survivors = events.filter((e) => e.kind !== "open" && e.kind !== "click");
  const removed = events.length - survivors.length;
  if (!removed) return json(res, 200, { ok: true, username, removed: 0 }); // idempotent

  const cmds = [["DEL", trackKey(username)]];
  for (let i = survivors.length - 1; i >= 0; i--) {
    cmds.push(["LPUSH", trackKey(username), JSON.stringify(survivors[i])]);
  }
  cmds.push(["LTRIM", trackKey(username), "0", String(TRK_LIST_CAP - 1)]);
  await kvPipeline(cmds).catch(() => {});

  return json(res, 200, { ok: true, username, removed });
}

export default async function handler(req, res) {
  if (!requireToken(req, res)) return;
  if (req.method !== "POST" && req.method !== "GET") {
    return json(res, 405, { error: "GET or POST only" });
  }
  if (req.method === "POST") {
    // The request body is readable once — peek at it here and hand the shape
    // to the right action (clearSelf:true needs no outcome; anything else is
    // a reply mark, which validates its own outcome below).
    let body = {};
    try {
      body = await readBody(req);
    } catch {
      body = {};
    }
    if (body.clearSelf === true) return clearSelf(res, body);
    return markReply(res, body);
  }

  const users = await kv("SMEMBERS", Q_TRK_USERS).catch(() => null);
  const list = Array.isArray(users) ? users : [];

  const rows = [];
  for (const username of list) {
    const events = parseRows(await kv("LRANGE", trackKey(username), "0", "-1").catch(() => null));
    const f = fold(events);
    if (!f.sentAt) continue; // no sent event yet — never counted
    rows.push({
      username,
      sentAt: f.sentAt,
      opened: f.openEvents > 0,
      firstOpenAt: f.firstOpenAt,
      firstOpenDelaySec: delaySec(f.sentAt, f.firstOpenAt),
      openEvents: f.openEvents,
      clicks: f.clickEvents,
      firstClickAt: f.firstClickAt,
      firstClickDelaySec: delaySec(f.sentAt, f.firstClickAt),
      replies: f.replies,
    });
  }
  rows.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));

  const totals = {
    sent: rows.length,
    opened: rows.filter((r) => r.opened).length,
    openEvents: rows.reduce((s, r) => s + r.openEvents, 0),
    clicks: rows.reduce((s, r) => s + r.clicks, 0),
    clickUsers: rows.filter((r) => r.clicks > 0).length,
    replies: rows.reduce((s, r) => s + r.replies.length, 0),
    byOutcome: {
      positive: rows.reduce((s, r) => s + r.replies.filter((x) => x.outcome === "positive").length, 0),
      neutral: rows.reduce((s, r) => s + r.replies.filter((x) => x.outcome === "neutral").length, 0),
      negative: rows.reduce((s, r) => s + r.replies.filter((x) => x.outcome === "negative").length, 0),
      bounce: rows.reduce((s, r) => s + r.replies.filter((x) => x.outcome === "bounce").length, 0),
    },
  };

  json(res, 200, { totals, rows });
}
