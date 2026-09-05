// GET  /api/kpi              ->  { totals, rows }
// POST /api/kpi  { username, outcome }  ->  { ok, at, outcome, username, replies }
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
// POST is the semi-manual reply counting (Zoho free has no IMAP — the
// server cannot read the mailbox; the reviewer marks replies in the KPI
// tab). outcome is one of positive / neutral / negative / bounce — or
// EMPTY, which removes the reply mark (a mis-click stays reversible).
// REPLACE semantics: a re-mark overwrites the previous reply, so
// corrections never double-count. 404 when the prospect has no tracked send
// (a reply to an untracked email cannot be counted here).

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

async function markReply(req, res) {
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

export default async function handler(req, res) {
  if (!requireToken(req, res)) return;
  if (req.method === "POST") return markReply(req, res);
  if (req.method !== "GET") return json(res, 405, { error: "GET or POST only" });

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
