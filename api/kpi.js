// GET /api/kpi  ->  { totals, rows }   (console token required)
//
// Folds the tracking events (forge:trkusers set + forge:trk:<u> lists) into
// the numbers the KPI tab shows. Events per prospect, newest first:
//   {kind:"sent", tk, at}              — one per delivered batch email
//   {kind:"open",  tk, at}             — one per pixel fetch (proxy-prone)
//   {kind:"click", tk, at}             — one per tracked-link redirect
//   {kind:"reply", tk, at, outcome}    — set semi-manually via /api/reply
// Opened is folded as ">=1 open + first-open delay" (a proxy fetch is not a
// human open, so counting fetches as reads would overstate); clicks count
// events. Replies carry an outcome. Empty store -> all-zero totals, never
// an error. Rows sorted by sentAt desc. This data lives in keys the console
// clear never touches, so it survives the review lifecycle by design.

import { json, requireToken, kv, Q_TRK_USERS, trackKey } from "./_lib.js";

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

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });
  if (!requireToken(req, res)) return;

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
