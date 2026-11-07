// /api/market: where the main indices stand right now, for the chat's "market today" card.
// Reads NSE Indices' public live index file. No AI, no key. If it can't be reached, the page hides the card.
export const config = { path: "/api/market" };

const SOURCE = "https://liveindexsa.niftyindices.com/jsonfiles/LiveIndicesWatch.json";
// NSE's live file names the small-cap index "NIFTY SMLCAP 250" (checked 7 Nov 2026); the long form is kept in case it changes.
export const WANT = { "NIFTY 50": "n50", "NIFTY MIDCAP 150": "mid150", "NIFTY SMLCAP 250": "small250", "NIFTY SMALLCAP 250": "small250", "NIFTY 500": "n500" };
const TTL_MS = 60 * 1000;
let cache = null; // { at, body }

const num = v => { const n = Number(String(v ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : null; };
export function pickIndices(json) {
  const rows = Array.isArray(json) ? json : Array.isArray(json && json.data) ? json.data : [];
  const out = {};
  for (const r of rows) {
    const key = WANT[String(r.indexName || r.IndexName || "").trim().toUpperCase()];
    if (!key) continue;
    const last = num(r.last), prev = num(r.previousClose), hi = num(r.yearHigh), lo = num(r.yearLow);
    if (!last || !prev) continue;
    out[key] = { last, previousClose: prev, changePct: num(r.percChange) ?? Math.round((last / prev - 1) * 10000) / 100, yearHigh: hi, yearLow: lo, asOf: String(r.timeVal || "").slice(0, 40) };
  }
  return out;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=30",
  "Netlify-CDN-Cache-Control": "public, durable, s-maxage=60, stale-while-revalidate=120",
} });

export default async (req) => {
  if (req.method !== "GET") return json({ ok: false, code: "method_not_allowed" }, 405);
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return json(cache.body);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(SOURCE, { signal: ac.signal, headers: { "User-Agent": "MySIPBuddy/1.0 (case-study prototype)", Accept: "application/json" } });
    if (!r.ok) throw new Error("http " + r.status);
    const indices = pickIndices(await r.json());
    if (!Object.keys(indices).length) throw new Error("no indices");
    const body = { ok: true, source: "NSE Indices", fetched: new Date(now).toISOString(), indices };
    cache = { at: now, body };
    return json(body);
  } catch (e) {
    if (cache) return json(Object.assign({}, cache.body, { stale: true }));
    return json({ ok: false, code: "unavailable" });
  } finally { clearTimeout(t); }
};
