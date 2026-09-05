// GET /api/image?username=<u>  ->  { username, present, b64, bytes }
// POST /api/image { username, b64 }  ->  { ok, username, bytes }
//
// GET — the page needs the token header, so the mockup is fetched through
// JS (fetch cannot be driven by <img src> with headers) and shown as a data
// URI. 404 when no image was pushed for this user.
//
// POST — the image half of a --send-push: mockups are uploaded ONE per
// request (they live one-per-key in the KV anyway, and a single /api/push
// carrying 16 × ~300 KB of base64 would exceed the Vercel function body cap
// → HTTP 413). The queue is then pushed lean to /api/push with
// attachment.present = true; an image whose user is not queued is purged
// there.

import { json, requireToken, readBody, kv, imgKey } from "./_lib.js";

const MAX_B64 = 380_000; // mirrors /api/push — one KV value must stay small

export default async function handler(req, res) {
  if (req.method === "POST") return upload(req, res);
  if (req.method !== "GET") return json(res, 405, { error: "GET or POST only" });
  if (!requireToken(req, res)) return;

  const username = (req.url.split("?")[1] || "")
    .split("&")
    .map((kv) => kv.split("="))
    .filter(([k]) => k === "username")
    .map(([, v]) => decodeURIComponent(v || ""))[0];
  if (!username) return json(res, 400, { error: "username query param required" });

  const b64 = await kv("GET", imgKey(username));
  if (!b64) return json(res, 404, { username, present: false });

  json(res, 200, { username, present: true, bytes: Math.round((b64.length * 3) / 4), b64 });
}

async function upload(req, res) {
  if (!requireToken(req, res)) return;

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
  const username = typeof body.username === "string" ? body.username : "";
  const b64 = typeof body.b64 === "string" ? body.b64 : "";
  if (!username || !b64) return json(res, 400, { error: "username and b64 are required" });
  if (b64.length > MAX_B64) {
    return json(res, 400, {
      error: `image for ${username} is ${(b64.length / 1000) | 0} KB of base64 — `
           + `over the ${(MAX_B64 / 1000) | 0} KB cap. Re-run --send-push from a machine with Pillow.`,
    });
  }

  const r = await kv("SET", imgKey(username), b64);
  if (r && r.error) throw new Error(`KV: ${r.error}`);
  json(res, 200, { ok: true, username, bytes: Math.round((b64.length * 3) / 4) });
}
