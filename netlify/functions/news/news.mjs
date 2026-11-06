// /api/news: the latest market headlines for the chat's "Market highlights" strip.
// Headlines only, each linked to the publisher. No AI touches them.
// Stock picks, buy/sell calls and "best funds" lists are left out, so the page never passes on advice.
export const config = { path: "/api/news" };

export const FEEDS = [
  { source: "Business Standard", url: "https://www.business-standard.com/rss/markets-106.rss", host: "business-standard.com" },
  { source: "Mint", url: "https://www.livemint.com/rss/markets", host: "livemint.com" },
];
const TTL_MS = 3 * 60 * 1000;       // fetch the feeds at most every 3 minutes per function instance
const MAX_AGE_MS = 48 * 3600 * 1000; // ignore headlines older than 2 days
const FEED_TIMEOUT_MS = 4000;
const KEEP = 6;
let cache = null;                   // { at, items }

// Headlines that read as advice or tips: picks, buy/sell calls, targets, "best funds" and the like.
const ADVICE = /\b(stocks?|shares?|funds?|picks?) to (buy|sell|bet|watch|add|own|hold)\b|\bto buy\b|\bbuy or sell\b|\b(stock|diwali|muhurat|top) picks?\b|\bpicks? (for|from|include)\b|\btop \d+\b|\b\d+ (stocks|shares|funds|mutual funds|sips?)\b|\bmultibagger|\btarget price|\bupside of\b|\bbest (mutual )?funds?\b|\bbest (stocks?|shares?|sips?)\b|\bshould you (buy|sell|invest|exit|stay)\b|\brecommend|\btrading (ideas?|guide|strategy|setup)\b|\btrade setup\b|\bstock ideas?\b|\bexperts? (decode|suggest|say buy|recommend)\b|\bhunting for\b|\bwinners\b|^(buy|sell|accumulate|book profit)\b/i;
// Prefer headlines about Indian markets; others only fill the gaps.
const INDIA = /\b(sensex|nifty|dalal street|bse|nse|india|indian|rbi|sebi|amfi|rupee|fpis?|fiis?|diis?|mutual funds?|sips?|ipos?|gst|budget|inflation|gdp|samvat|d-street)\b/i;

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function clean(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === "#" ? safeChar(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m))
    .replace(/\s+/g, " ").trim();
}
function safeChar(n) { try { return String.fromCodePoint(n); } catch { return ""; } }
function field(item, tag) { const m = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i")); return m ? clean(m[1]) : ""; }
function when(s) {
  if (!s) return NaN;
  const t = /([+-]\d{4}|GMT|UTC|Z)\s*$/i.test(s) ? s : s + " +0530"; // Indian publishers: no zone means IST
  return Date.parse(t);
}
// Only links back to the publisher's own site, over https.
function safeUrl(u, host) {
  try { const x = new URL(u); return x.protocol === "https:" && (x.hostname === host || x.hostname.endsWith("." + host)) ? x.href : null; } catch { return null; }
}

export function parseFeed(xml, feed, now = Date.now()) {
  const out = [];
  for (const chunk of String(xml).split(/<item[\s>]/i).slice(1)) {
    const item = chunk.split(/<\/item>/i)[0];
    const title = field(item, "title"), url = safeUrl(field(item, "link"), feed.host), at = when(field(item, "pubDate"));
    if (!title || !url || !isFinite(at) || at > now + 3600e3 || now - at > MAX_AGE_MS) continue;
    out.push({ title: title.length > 160 ? title.slice(0, 157) + "…" : title, url, source: feed.source, published: new Date(at).toISOString(), _at: at });
  }
  return out;
}

export function pick(items, keep = KEEP) {
  const seen = new Set(), ok = [];
  for (const it of items.sort((a, b) => b._at - a._at)) {
    const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);
    if (seen.has(key) || ADVICE.test(it.title)) continue;
    seen.add(key); ok.push(it);
  }
  const india = ok.filter(i => INDIA.test(i.title)), rest = ok.filter(i => !INDIA.test(i.title));
  return india.concat(rest).slice(0, keep).sort((a, b) => b._at - a._at).map(({ _at, ...i }) => i);
}

async function getFeed(feed) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), FEED_TIMEOUT_MS);
  try {
    const r = await fetch(feed.url, { signal: ac.signal, headers: { "User-Agent": "MySIPBuddy/1.0 (case-study prototype; headlines with links)", Accept: "application/rss+xml, application/xml, text/xml" } });
    if (!r.ok) return [];
    return parseFeed(await r.text(), feed);
  } catch { return []; } finally { clearTimeout(t); }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=60",
  "Netlify-CDN-Cache-Control": "public, durable, s-maxage=120, stale-while-revalidate=300",
} });

export default async (req) => {
  if (req.method !== "GET") return json({ ok: false, code: "method_not_allowed" }, 405);
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return json({ ok: true, updated: new Date(cache.at).toISOString(), sources: FEEDS.map(f => f.source), items: cache.items });
  const lists = await Promise.all(FEEDS.map(getFeed));
  const items = pick(lists.flat());
  if (items.length) cache = { at: now, items };
  else if (cache) return json({ ok: true, stale: true, updated: new Date(cache.at).toISOString(), sources: FEEDS.map(f => f.source), items: cache.items });
  return json({ ok: items.length > 0, updated: new Date(now).toISOString(), sources: FEEDS.map(f => f.source), items });
};
