// GET /api/pix?tk=<24-hex>  ->  200 image/gif (43-byte transparent pixel)
//
// The open pixel inside the HTML mirror part of every tracked batch email.
// NO console token here on purpose: a mail client fetching the pixel cannot
// send an x-forge-token header — the per-email tk in the URL IS the auth
// (24 hex, unguessable, single-purpose). Every answer is the GIF:
//   - unknown / expired tk (map TTL 90 d) still gets 200 — an error status
//     in a mail client is at best noise and at worst triggers retries;
//   - a known tk records one "open" event, best-effort (KV errors are
//     swallowed — the pixel must never slow or break the client render).
// While the reviewer's "je teste" window is armed (see _lib.js
// Q_SELFTEST), the event is tagged {test:true} — the KPI folds exclude it,
// so the reviewer's own Sent-folder opens never move the KPIs.
// On top of that, the home-country filter (selfCountry in _lib.js): a pixel
// fetch whose country is one of the reviewer's own (FORGE_SELF_COUNTRIES,
// default SN,ES,FR — from Vercel's x-vercel-ip-country header) records
// NOTHING — dropped at the source, never an event, no IP seen or stored.
// Nothing else is stored: no IP, no User-Agent, no referrer.

import { json, kv, kvPipeline, qParam, tkMapKey, trackKey, trackEvt, selfTestArmed, selfCountry, PIXEL_GIF, TRK_LIST_CAP } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });

  const tk = qParam(req.url, "tk");
  // Home-country gate: a fetch from the reviewer's own countries (default
  // SN,ES,FR) records nothing — the event is dropped before any KV work.
  if (tk && !selfCountry(req) && /^[0-9a-f]{24}$/.test(tk)) {
    const mapRaw = await kv("GET", tkMapKey(tk)).catch(() => null);
    if (mapRaw) {
      let username = null;
      try {
        const map = JSON.parse(mapRaw);
        username = map && map.username ? map.username : null;
      } catch {
        username = null;
      }
      if (username) {
        const at = new Date().toISOString();
        const extra = (await selfTestArmed()) ? { test: true } : undefined;
        await kvPipeline([
          ["LPUSH", trackKey(username), trackEvt("open", tk, at, extra)],
          ["LTRIM", trackKey(username), "0", String(TRK_LIST_CAP - 1)],
        ]).catch(() => {});
      }
    }
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.end(PIXEL_GIF);
}
