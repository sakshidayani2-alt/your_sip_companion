// Netlify Function: the only place the AI API keys are used. They live in Netlify's environment variables, never in the page.
// GET  /api/companion  -> health: is a key set, which provider and model, which prompt version (no AI call, no credit used)
// POST /api/companion  -> {step:"extract", text} or {step:"explain", text, route, facts}
//
// v7: runs on Anthropic's Claude (paid API credits) by default. Google's Gemini is kept behind a setting so you can switch back:
//   AI_PROVIDER = "anthropic" (default when ANTHROPIC_API_KEY is set) or "gemini".
// The prompts in core.mjs are the same for both. Changing the provider or model switches AI replies off in the page
// until the quality check has been run again on the new model.
import { PROMPT_VERSION, ROUTES, TOPICS, CAUSES, GOAL_KEYS, extractPrompt, explainPrompt, ruleCheck, scrub } from "./core.mjs";

const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2026-10-21"; // current API version (no temperature/top_p/top_k, which this function never sends)
const UPSTREAM_TIMEOUT_MS = 9000; // Netlify ends synchronous functions at 10 s
const MAX_TEXT = 1500;
const MAX_FACTS = 4000;

function env(name) {
  try { if (globalThis.Netlify && Netlify.env && typeof Netlify.env.get === "function") { const v = Netlify.env.get(name); if (v !== undefined) return v; } } catch { /* not on Netlify */ }
  return process.env[name];
}
const clean = v => (v === undefined || v === null ? "" : String(v).trim());
function provider() {
  const p = clean(env("AI_PROVIDER")).toLowerCase();
  if (p === "anthropic" || p === "claude") return "anthropic";
  if (p === "gemini" || p === "google") return "gemini";
  return clean(env("ANTHROPIC_API_KEY")) || !clean(env("GEMINI_API_KEY")) ? "anthropic" : "gemini";
}
const keyName = () => (provider() === "anthropic" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY");
const apiKey = () => clean(env(keyName()));
const model = () => (provider() === "anthropic" ? clean(env("ANTHROPIC_MODEL")) || DEFAULT_CLAUDE_MODEL : clean(env("GEMINI_MODEL")) || DEFAULT_GEMINI_MODEL);
// Claude: thinking off and low effort keep both calls of a typed message well inside the page's 10-second limit.
const claudeThinking = () => (clean(env("CLAUDE_THINKING")).toLowerCase() === "adaptive" ? "adaptive" : "disabled");
const claudeEffort = () => { const v = clean(env("CLAUDE_EFFORT")).toLowerCase(); return ["low", "medium", "high"].includes(v) ? v : v === "none" ? "" : "low"; };
const geminiThinkingLevel = () => { const v = env("GEMINI_THINKING_LEVEL"); return v === undefined ? "minimal" : v.trim(); };

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const fail = (status, code, extra) => Object.assign(new Error(code), { status, code }, extra || {});

// Best-effort limit per visitor (per function instance), so one person can't use up the credit. The provider's own limits apply on top.
const hits = new Map();
function overLimit(ip) {
  const now = Date.now(), windowMs = 10 * 60 * 1000, max = Number(env("MAX_REQUESTS_PER_10_MIN") || 150);
  const list = (hits.get(ip) || []).filter(t => now - t < windowMs);
  const over = list.length >= max; if (!over) list.push(now);
  hits.set(ip, list); if (hits.size > 5000) hits.clear();
  return over;
}

const timeoutMs = () => Number(env("UPSTREAM_TIMEOUT_MS") || UPSTREAM_TIMEOUT_MS);
const pause = ms => new Promise(r => setTimeout(r, ms));
const BUSY_STATUSES = [500, 502, 503, 504, 529]; // "overloaded" and internal errors: usually pass on a retry

// ---------- JSON shapes the model must return (Claude enforces these; the prompts describe the same shapes) ----------
const nullableNumber = { type: ["number", "null"] };
const nullableOneOf = list => ({ anyOf: [{ type: "string", enum: list }, { type: "null" }] });
const EXTRACT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    route: { type: "string", enum: ROUTES }, topic: nullableOneOf(TOPICS), cause: nullableOneOf(CAUSES), goal: nullableOneOf(GOAL_KEYS),
    monthly_amount: nullableNumber, months_invested: nullableNumber, invested_total: nullableNumber, current_value: nullableNumber,
    expectation: { type: "object", additionalProperties: false, properties: { kind: { type: "string", enum: ["multiple", "annual_pct", "target_amount", "none"] }, value: nullableNumber, horizon_months: nullableNumber }, required: ["kind", "value", "horizon_months"] },
    sip_day: nullableNumber, salary_day: nullableNumber, reason: { type: "string" },
  },
  required: ["route", "topic", "cause", "goal", "monthly_amount", "months_invested", "invested_total", "current_value", "expectation", "sip_day", "salary_day", "reason"],
};
const EXPLAIN_SCHEMA = { type: "object", additionalProperties: false, properties: { message: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] } }, required: ["message", "confidence"] };

function parseJson(text) {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(t); } catch { /* try the outermost object */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  throw fail(502, "bad_json");
}
function signalFor(outerSignal, ms) {
  const timeout = AbortSignal.timeout(ms);
  return { timeout, signal: outerSignal && AbortSignal.any ? AbortSignal.any([outerSignal, timeout]) : timeout };
}

// ---------- Anthropic (Claude) ----------
function anthropicDetail(status, data) {
  const e = data && data.error;
  const msg = e && typeof e.message === "string" ? e.message.replace(/\s+/g, " ").slice(0, 160) : "";
  return [String(status), e && e.type, msg].filter(Boolean).join(" ");
}
async function callAnthropicOnce(prompt, schema, outerSignal, ms) {
  const key = apiKey(); if (!key) throw fail(503, "not_configured");
  const thinking = claudeThinking(), effort = claudeEffort();
  const body = { model: model(), max_tokens: thinking === "adaptive" ? 4096 : 1024, messages: [{ role: "user", content: prompt }], thinking: { type: thinking }, output_config: { format: { type: "json_schema", schema } } };
  if (effort) body.output_config.effort = effort;
  const { timeout, signal } = signalFor(outerSignal, ms);
  const headers = { "content-type": "application/json", authorization: `Bearer ${key}`, "anthropic-version": clean(env("ANTHROPIC_VERSION")) || ANTHROPIC_VERSION };
  const ws = clean(env("ANTHROPIC_WORKSPACE_ID")); if (ws) headers["anthropic-workspace-id"] = ws; // only needed for a key that isn't scoped to a workspace
  const post = () => fetch(ANTHROPIC_URL, { method: "POST", headers, body: JSON.stringify(body), signal });

  let res;
  try {
    res = await post();
    // If this model doesn't take one of the optional settings, drop it and try once more. The prompt still asks for JSON only.
    for (let i = 0; i < 3 && res.status === 400; i++) {
      const t = await res.clone().text();
      if (/thinking/i.test(t) && body.thinking) { delete body.thinking; body.max_tokens = 4096; } // default thinking counts toward max_tokens
      else if (/effort/i.test(t) && body.output_config && body.output_config.effort) delete body.output_config.effort;
      else if (/output_config|json_schema|schema|format/i.test(t) && body.output_config && body.output_config.format) delete body.output_config.format;
      else break;
      if (body.output_config && !Object.keys(body.output_config).length) delete body.output_config;
      res = await post();
    }
  } catch (e) {
    if (timeout.aborted) throw fail(504, "timeout");
    throw fail(502, "upstream_unreachable");
  }

  let data = null; try { data = await res.json(); } catch { /* not JSON */ }
  const detail = anthropicDetail(res.status, data);
  if (res.status === 429) { const ra = parseInt(res.headers.get("retry-after") || "", 10); throw fail(429, "rate_limited", { retryAfter: isFinite(ra) && ra > 0 ? ra : 20, detail }); }
  if (BUSY_STATUSES.includes(res.status)) throw fail(503, "upstream_busy", { retryAfter: 5, detail });
  if (res.status === 401 || res.status === 403) throw fail(502, "upstream_auth", { detail });
  if (res.status === 404) throw fail(502, "model_not_found", { detail });
  if (res.status === 400 && /credit balance/i.test(detail)) throw fail(502, "no_credit", { detail });
  if (res.status === 400 && /anthropic-workspace-id|scoped to a workspace/i.test(detail)) throw fail(502, "needs_workspace", { detail });
  if (!res.ok) throw fail(502, "upstream_error", { detail });

  const text = ((data && data.content) || []).filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join("").trim();
  if (!text) throw fail(502, "no_answer", { detail: data && data.stop_reason });
  if (data.stop_reason === "max_tokens") throw fail(502, "bad_json", { detail: "max_tokens" });
  return parseJson(text);
}

// ---------- Google (Gemini), kept so you can switch back with AI_PROVIDER=gemini ----------
function retrySeconds(errBody) {
  try {
    const details = (errBody && errBody.error && errBody.error.details) || [];
    for (const d of details) if (d && typeof d.retryDelay === "string") { const n = parseFloat(d.retryDelay); if (isFinite(n)) return Math.ceil(n); }
  } catch { /* ignore */ }
  return 30;
}
function geminiDetail(status, data) {
  const e = data && data.error;
  const msg = e && typeof e.message === "string" ? e.message.replace(/\s+/g, " ").slice(0, 160) : "";
  return [String(status), e && e.status, msg].filter(Boolean).join(" ");
}
async function callGeminiOnce(prompt, schema, outerSignal, ms) {
  const key = apiKey(); if (!key) throw fail(503, "not_configured");
  const level = geminiThinkingLevel();
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: 2048 } };
  if (level) body.generationConfig.thinkingConfig = { thinkingLevel: level };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model())}:generateContent`;
  const { timeout, signal } = signalFor(outerSignal, ms);
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
  if (res.status === 429) throw fail(429, "rate_limited", { retryAfter: retrySeconds(data), detail: geminiDetail(res.status, data) });
  if (BUSY_STATUSES.includes(res.status)) throw fail(503, "upstream_busy", { retryAfter: 5, detail: geminiDetail(res.status, data) });
  if (res.status === 401 || res.status === 403) throw fail(502, "upstream_auth", { detail: geminiDetail(res.status, data) });
  if (res.status === 404) throw fail(502, "model_not_found", { detail: geminiDetail(res.status, data) });
  if (!res.ok) throw fail(502, "upstream_error", { detail: geminiDetail(res.status, data) });

  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter(p => p && !p.thought && typeof p.text === "string").map(p => p.text).join("").trim();
  if (!text) throw fail(502, "no_answer", { detail: [cand && cand.finishReason, data && data.promptFeedback && data.promptFeedback.blockReason].filter(Boolean).join(" ") });
  return parseJson(text);
}

// One model call, retried within the function's time budget when the provider reports it is busy.
async function callModel(prompt, schema, outerSignal) {
  const once = provider() === "anthropic" ? callAnthropicOnce : callGeminiOnce;
  const started = Date.now(), budget = timeoutMs(); let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const left = budget - (Date.now() - started);
    if (left < 2500) break;
    try { return await once(prompt, schema, outerSignal, left); }
    catch (e) {
      lastErr = e;
      if (e.code !== "upstream_busy") throw e;
      const wait = Math.min(1000 * (attempt + 1), budget - (Date.now() - started) - 2500);
      if (wait <= 0) break;
      await pause(wait);
    }
  }
  throw lastErr || fail(504, "timeout");
}

const low = v => (typeof v === "string" ? v.trim().toLowerCase() : v);
const meta = () => ({ provider: provider(), model: model(), prompt_version: PROMPT_VERSION });

export default async (req, context) => {
  if (req.method === "GET") return reply(200, Object.assign({ ok: true, configured: !!apiKey() }, meta()));
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
      const x = await callModel(extractPrompt(text), EXTRACT_SCHEMA, req.signal);
      if (x) { for (const k of ["route", "topic", "cause", "goal"]) x[k] = low(x[k]); if (x.expectation && typeof x.expectation === "object") x.expectation.kind = low(x.expectation.kind); }
      if (!x || !ROUTES.includes(x.route)) return reply(502, { code: "bad_route" });
      if (x.route === "payment_help" && !CAUSES.includes(x.cause)) x.cause = "unknown";
      if (x.route !== "payment_help") x.cause = null;
      if (!GOAL_KEYS.includes(x.goal)) x.goal = null;
      if (!TOPICS.includes(x.topic)) x.topic = null;
      return reply(200, Object.assign({ extract: x }, meta()));
    }
    if (b.step === "explain") {
      if (!ROUTES.includes(b.route)) return reply(400, { code: "bad_route" });
      const facts = b.facts && typeof b.facts === "object" && !Array.isArray(b.facts) ? b.facts : {};
      if (JSON.stringify(facts).length > MAX_FACTS) return reply(400, { code: "facts_too_long" });
      const y = await callModel(explainPrompt(text, b.route, facts), EXPLAIN_SCHEMA, req.signal);
      const message = y && typeof y.message === "string" ? y.message.trim() : "";
      const confidence = y && ["high", "medium", "low"].includes(low(y.confidence)) ? low(y.confidence) : null;
      return reply(200, Object.assign({ message, confidence, issues: ruleCheck(message, facts, text) }, meta()));
    }
    return reply(400, { code: "bad_step" });
  } catch (e) {
    return reply(e.status || 502, { code: e.code || "error", retryAfter: e.retryAfter, detail: e.detail });
  }
};

export const config = { path: "/api/companion" };
