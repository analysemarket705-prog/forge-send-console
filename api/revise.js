// POST /api/revise  { username, instruction }  ->  { ok, subject, body, revised, revision }
//
// The console's "Modifier" button: calls a variant of the email writer agent
// (DeepSeek chat, like the local writer) to REWRITE the queued draft's
// subject + body according to the reviewer's free-text instruction. The
// revised text is written back into the KV queue item, so:
//   - the card in the browser shows the revised email immediately;
//   - /api/decide sends EXACTLY the revised text (it reads the queue item);
//   - the decision records the sent text so the local pull can sync the md.
//
// House rules are enforced deterministically here, mirroring
// agents/email_contact_writer.py (ensure_house_rules) in the repo: subject
// starts with "[Partnership] ", body ends "-Ronan Delerue\nForge — …". The
// writer instruction may drift; this cannot.
//
// Requires DEEPSEEK_API_KEY as a Vercel env secret. FORGE_REVISE_MODEL /
// FORGE_REVISE_BASE override the endpoint (defaults: deepseek-chat,
// https://api.deepseek.com).

import { json, requireToken, readBody, kv, kvGetQueue, kvGetDecisions, kvGetStaged, kvGetBatch, Q_QUEUE } from "./_lib.js";

const SUBJECT_PREFIX = "[Partnership]";
const SIGN_OFF = "-Ronan Delerue";
const SITE_LINE = "Forge — https://forgefitapp.co/";

const SYSTEM = `You are the Email Contact Agent Writer for Forge, modified to revise an \
existing outreach email on request. Forge builds custom fitness apps for fitness \
creators: $0 upfront, revenue share only, custom-built around how the coach \
already coaches (never a white-label template). Keep every creator-specific \
fact that is already in the email UNLESS the instruction says otherwise — never \
invent new facts about the creator or new product claims about Forge. The email \
is plain text, in English, ~120-180 words, direct no-BS founder voice.

HOUSE RULES (never violated):
1. The subject MUST start with the literal tag "[Partnership] " followed by \
~8-9 low-key specific words about this creator.
2. The body MUST end with the two-line closing: "-Ronan Delerue" then \
"Forge — https://forgefitapp.co/" — nothing after it, never twice.
3. No HTML/markdown, no booking links mid-body, no emoji spam.

You answer ONLY with a JSON object: {"subject": "...", "body": "..."} — the \
complete rewritten email, no preamble.`;

const USER = (item, instruction, attempt) => `REWRITE this Forge outreach email following the reviewer's \
instruction. Preserve the recipient identity, the mockup mention if present, and all facts unless \
the instruction overrides them.

RECIPIENT: ${item.full_name || item.username} <${item.email_address}>
CURRENT SUBJECT: ${item.subject}
CURRENT BODY:
${item.body}

THE REVIEWER'S INSTRUCTION (rewrite accordingly):
${instruction}

Reply with the JSON object only.${attempt === 0 ? "" : `

NOTE (attempt ${attempt + 1}): your previous revision was byte-identical to the email above. The \
reviewer explicitly asked for a change — rewrite the flagged part(s) with genuinely different \
wording, and return the complete revised email.`}`;

export function enforceHouseRules(subject, body) {
  let s = String(subject || "").trim().replace(/^\s*\[?\s*[Pp]artnership\s*\]?\s*[:—-]?\s*/, "");
  subject = s ? `${SUBJECT_PREFIX} ${s}` : String(subject || "").trim();
  body = String(body || "").trimEnd();
  if (!body.endsWith(SITE_LINE)) {
    body = body.replace(/\s*[-—]?\s*Ronan Delerue\s*$/, "").trimEnd();
    body = `${body}\n\n${SIGN_OFF}\n${SITE_LINE}`;
  }
  return { subject, body };
}

async function callModel(key, base, model, messages) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      temperature: 0.7,
      max_tokens: 1500,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`DeepSeek revision failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned); // throws -> 502 below
}

// Observed: deepseek-chat sometimes returns the CURRENT email byte-identical
// (~1 draw in 3 with a declarative instruction like "the intro is bad") — the
// reviewer would see "modifié" with zero change. Retry up to 2 times with a
// nudge; only a genuinely different text counts as a revision, and an
// exhausted model fails loudly (502) instead of silently no-op'ing.
const MAX_ATTEMPTS = 3;

export async function reviseEmail(item, instruction) {
  const key = process.env.DEEPSEEK_API_KEY || "";
  if (!key) {
    const err = new Error("server env DEEPSEEK_API_KEY is not set — the modifier cannot run");
    err.missingEnv = true;
    throw err;
  }
  const base = (process.env.FORGE_REVISE_BASE || "https://api.deepseek.com").replace(/\/$/, "");
  const model = process.env.FORGE_REVISE_MODEL || "deepseek-chat";
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: "" }, // per-attempt below
  ];
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    messages[1] = { role: "user", content: USER(item, instruction, attempt) };
    const parsed = await callModel(key, base, model, messages);
    const revised = enforceHouseRules(parsed.subject, parsed.body);
    const sameSubject = revised.subject === item.subject;
    const sameBody = revised.body === item.body;
    if (!sameSubject || !sameBody) return revised;
  }
  const err = new Error(
    "the writer returned the email unchanged "
    + `${MAX_ATTEMPTS} times — the instruction may be too vague to act on. `
    + "Rephrase what should change concretely (e.g. \"raccourcis l'introduction de moitié\") and retry."
  );
  err.unchanged = true;
  throw err;
}

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
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (!username || !instruction) {
    return json(res, 400, { error: "username + instruction required" });
  }
  if (instruction.length > 2000) {
    return json(res, 400, { error: "instruction too long (max 2000 chars)" });
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
           + `at ${prior.at} — a decided draft cannot be rewritten. Refresh to see the recorded decision.`,
    });
  }
  const stagedMark = staged.find((s) => s.username === username);
  if (stagedMark) {
    return json(res, 409, {
      error: `${username} is ${stagedMark.choice === "approved" ? "approved for the batch" : "marked rejected"} `
           + `— un-mark the card first (✓ Valider again to toggle off) if you want to revise before locking.`,
    });
  }
  if (batch && batch.items.some((i) => i.username === username)) {
    return json(res, 409, {
      error: `${username} is inside the running batch — its locked text cannot be rewritten. `
           + "If it has not been sent yet, cancel the delivery and start a new review.",
    });
  }

  let revised;
  try {
    revised = await reviseEmail(item, instruction);
  } catch (e) {
    const msg = e.missingEnv ? e.message : `revision failed — ${String(e.message || e).slice(0, 300)}`;
    return json(res, e.missingEnv ? 500 : 502, { error: msg });
  }
  if (!revised.subject || !revised.body) {
    return json(res, 502, { error: "the writer returned an empty revision" });
  }

  // Write the revised text back into the queue item — the send then ships
  // exactly what the reviewer approved, and the decision records it.
  const at = new Date().toISOString();
  item.subject = revised.subject;
  item.body = revised.body;
  item.revised = true;
  item.revision = instruction.slice(0, 300);
  item.revisedAt = at;
  await kv("SET", Q_QUEUE, JSON.stringify(queue));

  return json(res, 200, {
    ok: true, username, subject: revised.subject, body: revised.body,
    revised: true, revision: item.revision, revisedAt: at,
  });
}
