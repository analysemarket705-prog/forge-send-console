// GET /api/image?username=<u>  ->  { username, present, b64, bytes }
// The page needs the token header, so the mockup is fetched through JS
// (fetch cannot be driven by <img src> with headers) and shown as a data
// URI. 404 when no image was pushed for this user.

import { json, requireToken, kv, imgKey } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });
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
