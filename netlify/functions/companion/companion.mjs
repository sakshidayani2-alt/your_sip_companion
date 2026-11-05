// Netlify Function: the only place the Gemini API key is used.
// GET  /api/companion  -> health: is a key set, which model, which prompt version (no AI call, no quota used)
// POST /api/companion  -> {step:"extract", text} or {step:"explain", text, route, facts}
import { PROMPT_VERSION, ROUTES, CAUSES, GOAL_KEYS, extractPrompt, explainPrompt, ruleCheck, scrub } from "./core.mjs";

const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const UPSTREAM_TIMEOUT_MS = 9000; // Netlify ends synchronous functions at 10 s
const MAX_TEXT = 1500;
const MAX_FACTS = 4000;

function env(name) {
  try { if (globalThis.Netlify && Netlify.env && typeof Netlify.env.get === "function") { const v = Netlify.env.get(name); if (v !== undefined) return v; } } catch { /* not on Netlify */ }
  return process.env[name];
}
const model = () => (env("GEMINI_MODEL") || DEFAULT_MODEL).trim();
const thinkingLevel = () => { const v = env("GEMINI_THINKING_LEVEL"); return v === undefined ? "minimal" : v.trim(); };

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, code, extra) => Object.assign(new Error(code), { status, code }, extra || {});

// Best-effort limit per visitor (per function instance). Google's own free-tier limits still apply on top.
const hits = new Map();
function overLimit(ip) {
  const now = Date.now(), windowMs = 10 * 60 * 1000, max = Number(env("MAX_REQUESTS_PER_10_MIN") || 150);
  const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
  const over = list.length >= max; if (!over) list.push(now);
  hits.set(ip, list); if (hits.size > 5000) hits.clear();
  return over;
}

function retrySeconds(errBody) {
  try {
    const details = (errBody && errBody.error && errBody.error.details) || [];
    for (const d of details) if (d && typeof d.retryDelay === "string") { const n = parseFloat(d.retryDelay); if (isFinite(n)) return Math.ceil(n); }
  } catch { /* ignore */ }
  return 30;
}

async function callGemini(prompt, outerSignal) {
  const key = env("GEMINI_API_KEY");
  if (!key) throw fail(503, "not_configured");
  const level = thinkingLevel();
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: 2048 } };
  if (level) body.generationConfig.thinkingConfig = { thinkingLevel: level };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model())}:generateContent`;
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const signal = outerSignal && AbortSignal.any ? AbortSignal.any([outerSignal, timeout]) : timeout;
  const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body), signal });

  let res;
  try {
    res = await post();
    if (res.status === 400 && body.generationConfig.thinkingConfig) {
      const t = await res.clone().text();
      if (/thinking/i.test(t)) { delete body.generationConfig.thinkingConfig; res = await post(); } // model doesn't take this thinking setting: retry without it
    }
  } catch (e) {
    if (timeout.aborted) throw fail(504, "timeout");
    throw fail(502, "upstream_unreachable");
  }

  let data = null; try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status === 429) throw fail(429, "rate_limited", { retryAfter: retrySeconds(data) });
  if (res.status === 401 || res.status === 403) throw fail(502, "upstream_auth");
  if (res.status === 404) throw fail(502, "model_not_found");
  if (!res.ok) throw fail(502, "upstream_error", { upstreamStatus: res.status });

  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter(p => p && !p.thought && typeof p.text === "string").map(p => p.text).join("").trim();
  if (!text) throw fail(502, "no_answer", { finishReason: cand && cand.finishReason });
  try { return JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch { throw fail(502, "bad_json"); }
}

export default async (req, context) => {
  if (req.method === "GET") return reply(200, { ok: true, configured: !!env("GEMINI_API_KEY"), model: model(), prompt_version: PROMPT_VERSION });
  if (req.method !== "POST") return reply(405, { code: "method_not_allowed" });

  const origin = req.headers.get("origin");
  if (origin) { try { if (new URL(origin).host !== new URL(req.url).host) return reply(403, { code: "forbidden_origin" }); } catch { return reply(403, { code: "forbidden_origin" }); } }
  const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "unknown";
  if (overLimit(ip)) return reply(429, { code: "rate_limited", retryAfter: 60, scope: "site" });

  let b; try { b = await req.json(); } catch { return reply(400, { code: "bad_request" }); }
  const text = scrub(typeof b.text === "string" ? b.text.trim() : "");
  if (!text || text.length > MAX_TEXT) return reply(400, { code: "bad_text" });

  try {
    if (b.step === "extract") {
      const x = await callGemini(extractPrompt(text), req.signal);
      if (!x || !ROUTES.includes(x.route)) return reply(502, { code: "bad_route" });
      if (x.route === "payment_help" && !CAUSES.includes(x.cause)) x.cause = "unknown";
      if (x.route !== "payment_help") x.cause = null;
      if (!GOAL_KEYS.includes(x.goal)) x.goal = null;
      return reply(200, { extract: x, model: model(), prompt_version: PROMPT_VERSION });
    }
    if (b.step === "explain") {
      if (!ROUTES.includes(b.route)) return reply(400, { code: "bad_route" });
      const facts = b.facts && typeof b.facts === "object" && !Array.isArray(b.facts) ? b.facts : {};
      if (JSON.stringify(facts).length > MAX_FACTS) return reply(400, { code: "facts_too_long" });
      const y = await callGemini(explainPrompt(text, b.route, facts), req.signal);
      const message = y && typeof y.message === "string" ? y.message.trim() : "";
      const confidence = y && ["high", "medium", "low"].includes(y.confidence) ? y.confidence : null;
      return reply(200, { message, confidence, issues: ruleCheck(message, facts, text), model: model(), prompt_version: PROMPT_VERSION });
    }
    return reply(400, { code: "bad_step" });
  } catch (e) {
    return reply(e.status || 502, { code: e.code || "error", retryAfter: e.retryAfter });
  }
};

export const config = { path: "/api/companion" };
