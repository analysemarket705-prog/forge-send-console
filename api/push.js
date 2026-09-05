// POST /api/push  { queue: [item, ...] }  ->  { ok, queued, images, purged }
//
// The local `--send-push` replaces the console state wholesale:
//   - queue items are stored WITHOUT their attachment b64 (kept lean);
//     each image is stored under its own forge:img:<username> key
//     (KV value-size limits make one-key-per-user mandatory);
//   - images are uploaded separately, ONE per POST /api/image (a single
//     request carrying every base64 exceeds the Vercel function body cap
//     → HTTP 413). Queue items announce those uploads with
//     attachment.present = true (no b64); inline b64 still works — the
//     image is registered/kept either way;
//   - the forge:decisions list is cleared, so a validation can never be
//     re-decided or double-sent from a stale queue;
//   - image keys for usernames no longer in the queue are purged.
//
// Idempotent: re-running push with the same queue is a no-op cost-wise.
// Refuses to run while un-pulled decisions exist — those mark mds sent or
// rejected locally, and pushing over them would let a sent prospect be
// sent a second time.

import { json, requireToken, readBody, kv, kvPipeline, kvGetDecisions, kvGetBatch, kvGetStaged,
         batchPending, Q_QUEUE, Q_IMGS, Q_DECS, Q_STAGED, Q_BATCH, imgKey } from "./_lib.js";

const MAX_B64 = 380_000; // ~285 KB PNG -> base64; well under KV value limits

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  if (!requireToken(req, res)) return;

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  const items = Array.isArray(body.queue) ? body.queue : [];
  if (!items.length) return json(res, 400, { error: "queue is empty — nothing to push" });

  const [pending, batch, staged] = await Promise.all([
    kvGetDecisions(), kvGetBatch(), kvGetStaged(),
  ]);
  if (pending.length) {
    return json(res, 409, {
      error: `${pending.length} decision(s) recorded here are not pulled back yet `
           + `(sent/rejected prospects must be recorded in their draft mds first). `
           + `Run the local sync: python run_forge_outreach.py --send-pull, then push again.`,
      pending,
    });
  }
  if (batch) {
    const sending = batchPending(batch, pending);
    if (sending.length) {
      return json(res, 409, {
        error: `batch ${batch.id} is still delivering — ${sending.length} scheduled send(s) have not landed yet. `
             + "A push would clear their records; wait for the batch, then --send-pull.",
        batch: { id: batch.id, pending: sending.map((i) => i.username) },
      });
    }
  }
  if (staged.length) {
    return json(res, 409, {
      error: `${staged.length} draft(s) are still staged from an unfinished review `
           + `(${staged.map((s) => s.username).join(", ")}). Lock or reset the review before pushing a new queue.`,
      staged,
    });
  }

  // Strip image payloads into per-user KV keys; keep a lean queue item.
  // The image may already live in the KV (uploaded via POST /api/image,
  // announced by present:true) or arrive inline below as b64 — registered
  // either way, so pre-uploaded images are never purged as stale.
  const clean = [];
  const imgUsers = [];
  for (const item of items) {
    if (!item || typeof item.username !== "string" || !item.username) continue;
    const c = { ...item };
    const att = c.attachment;
    const b64 = att && typeof att.b64 === "string" ? att.b64 : "";
    const hasImg = Boolean(b64) || att.present === true;
    c.attachment = {
      filename: (att && att.filename) || "app-preview.png",
      present: hasImg,
      bytes: b64 ? Math.round((b64.length * 3) / 4) : (att && att.bytes) || 0,
    };
    if (b64 && b64.length > MAX_B64) {
      return json(res, 400, {
        error: `image for ${item.username} is ${(b64.length / 1000) | 0} KB of base64 — `
             + `over the ${(MAX_B64 / 1000) | 0} KB cap. Re-run --send-push from a machine with Pillow.`,
      });
    }
    if (hasImg) imgUsers.push(item.username);
    clean.push(c);
  }

  // Purge images whose user is no longer queued.
  const prevImgs = JSON.parse((await kv("GET", Q_IMGS)) || "[]");
  const stale = prevImgs.filter((u) => !imgUsers.includes(u)).map(imgKey);

  // Small ops in one pipeline (not atomic; push is idempotent so a partial
  // failure is fixed by re-running push)… batch/staged leftovers are only
  // DELeted here once the guards above proved they are inert.
  const results = await kvPipeline([
    ["DEL", Q_DECS],
    ["SET", Q_QUEUE, JSON.stringify(clean)],
    ["SET", Q_IMGS, JSON.stringify(imgUsers)],
    ["DEL", Q_STAGED],
    ["DEL", Q_BATCH],
    ...(stale.length ? [["DEL", ...stale]] : []),
  ]);
  for (const r of results) {
    if (r && r.error) throw new Error(`KV pipeline: ${r.error}`);
  }

  // …then the big image values individually.
  for (const item of items) {
    const att = item.attachment;
    if (att && typeof att.b64 === "string" && att.b64) {
      await kv("SET", imgKey(item.username), att.b64);
    }
  }

  json(res, 200, {
    ok: true,
    queued: clean.length,
    images: imgUsers.length,
    purged: stale.length,
  });
}
