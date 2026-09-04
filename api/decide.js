// POST /api/decide  { username, action: "sent"|"rejected_manual",
//                      confirmAddress?, reason? }  ->  { ok, ... }
//
// The send itself happens HERE, serverless, the moment a human validates on
// the console — over SMTP (nodemailer) with the Zoho credentials stored as
// Vercel env secrets. Guards, mirroring the terminal mastermind:
//   - sending requires typing the recipient's address (confirmAddress must
//     equal the queued address, case-insensitive) — a stray tap can't send;
//   - a username with a recorded decision cannot be decided again — the
//     double-send path is closed on the server side, not just in the UI;
//   - nothing is recorded unless SMTP accepted the message; a failed send
//     leaves the card undecided so the human can retry or reject.
//
// No LLM in the loop, same as the terminal console: the draft was written
// and fact-checked by the writer agent; the human is the final gate.

import { json, requireToken, readBody, kv, kvGetQueue, kvGetDecisions, kvGetStaged, kvGetBatch, smtpConfig, smtpSend, Q_DECS, imgKey } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!requireToken(req, res)) return;

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  const { username, action } = body;
  if (!username || !["sent", "rejected_manual"].includes(action)) {
    return json(res, 400, { error: "username + action (sent|rejected_manual) required" });
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
           + `at ${prior.at} — a draft is decided once. Refresh to see the recorded decision.`,
    });
  }
  // The immediate-send path (/api/decide) is retired from the UI in favour of
  // the batch review — a stale client must not bypass it.
  const stagedMark = staged.find((s) => s.username === username);
  if (stagedMark) {
    return json(res, 409, {
      error: `${username} is staged for the batch (${stagedMark.choice}) — decisions happen at lock time. `
           + "Refresh to use the batch review.",
    });
  }
  if (batch && batch.items.some((i) => i.username === username)) {
    return json(res, 409, {
      error: `${username} is inside the running batch — its send is scheduled on a 5-10 min interval. `
           + "Decide it by pulling the batch decisions afterwards.",
    });
  }

  const at = new Date().toISOString();

  if (action === "rejected_manual") {
    await kv("LPUSH", Q_DECS, JSON.stringify({
      username, action, at, reason: (body.reason || "no reason given").slice(0, 500),
    }));
    return json(res, 200, { ok: true, action, at });
  }

  // ---- send -------------------------------------------------------------
  const typed = typeof body.confirmAddress === "string" ? body.confirmAddress.trim() : "";
  if (!typed || typed.toLowerCase() !== item.email_address.toLowerCase()) {
    return json(res, 400, { error: "address mismatch — send cancelled. Type the recipient address exactly." });
  }

  const cfg = smtpConfig();
  if (cfg.missing.length) {
    return json(res, 500, { error: `SMTP not configured on the server — missing env: ${cfg.missing.join(", ")}` });
  }

  const from = cfg.fromName ? `"${cfg.fromName.replace(/"/g, "'")}" <${cfg.from}>` : cfg.from;
  const mail = {
    from,
    to: item.email_address,
    subject: item.subject,
    text: item.body,
  };
  const att = item.attachment;
  if (att && att.present) {
    const b64 = await kv("GET", imgKey(item.username));
    if (b64) {
      mail.attachments = [{ filename: att.filename || "app-preview.png", content: Buffer.from(b64, "base64") }];
    }
  }

  try {
    const detail = await smtpSend(cfg, mail);
    // Record the EXACT text that went out (possibly console-revised) so the
    // local --send-pull can sync the draft md to reality.
    await kv("LPUSH", Q_DECS, JSON.stringify({
      username, action: "sent", at, to: item.email_address,
      subject: item.subject, body: item.body,
      revised: !!item.revised, revision: item.revision || "",
      detail,
    }));
    return json(res, 200, { ok: true, action: "sent", at, detail });
  } catch (e) {
    const why = e && e.response ? e.response : String(e.message || e);
    // Nothing recorded: the draft stays queued for a retry or a reject.
    return json(res, 502, { error: `SMTP send failed — ${String(why).slice(0, 300)}` });
  }
}

