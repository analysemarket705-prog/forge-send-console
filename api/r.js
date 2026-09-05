// GET /api/r?tk=<24-hex>  ->  302 Location: https://forgefitapp.co/
//
// The tracked signature link: at mail-build time the only URL in the body
// (the Forge signature line) is rewritten to go through this redirect. Like
// the pixel, NO console token — the tk in the URL is the auth. A known tk
// records one "click" event, best-effort. Every request answers 302 to the
// site, even a dead/expired/malformed tk — the recipient must never see a
// broken link, and a redirect a client followed stays a redirect.
//
// no-store on the 302: a cached 3xx would collapse later clicks into one.

import { json, kv, kvPipeline, qParam, tkMapKey, trackKey, trackEvt, SITE_URL, TRK_LIST_CAP } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });

  const tk = qParam(req.url, "tk");
  if (tk && /^[0-9a-f]{24}$/.test(tk)) {
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
        await kvPipeline([
          ["LPUSH", trackKey(username), trackEvt("click", tk, at)],
          ["LTRIM", trackKey(username), "0", String(TRK_LIST_CAP - 1)],
        ]).catch(() => {});
      }
    }
  }

  res.statusCode = 302;
  res.setHeader("Location", SITE_URL);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}
