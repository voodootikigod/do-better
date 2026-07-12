// src/llm.js — provider-pluggable LLM service layer (SPEC D2, §6 tiering, D10 budget).
//
// Providers: anthropic (default) | gemini | openai | local (any OpenAI-compatible
// endpoint via DOBETTER_LOCAL_BASE_URL), via builtin fetch — no SDKs.
// Tiers (spec §6): cheap / mid / frontier. Budget is enforced before EVERY call.
// Offline (--offline) constructs a service whose calls throw OfflineError; phase
// modules route around it with withFallback(). Test seam: DOBETTER_FAKE_LLM.

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  OpError,
  BudgetError,
  OfflineError,
  assertSafeModelName,
  log,
} from "./utils.js";

export const TIERS = ["cheap", "mid", "frontier"];

export const DEFAULT_MODELS = {
  anthropic: { cheap: "claude-haiku-4-5", mid: "claude-sonnet-4-6", frontier: "claude-opus-4-8" },
  openai: { cheap: "gpt-4o-mini", mid: "gpt-4o", frontier: "gpt-4o" },
  gemini: { cheap: "gemini-2.5-flash", mid: "gemini-2.5-pro", frontier: "gemini-2.5-pro" },
};

// USD per 1M tokens { in, out }. Unknown model → its tier's default-model price
// for that provider; truly unknown → conservative fallback below.
export const PRICES = {
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
  "claude-sonnet-4-6": { in: 3.0, out: 15.0 },
  "claude-opus-4-8": { in: 5.0, out: 25.0 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10.0 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-pro": { in: 1.25, out: 10.0 },
};

export const MAX_OUTPUT_TOKENS = 16000;

const FALLBACK_PRICE = { in: 5, out: 25 };
const KEY_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};
// Local provider (SPEC D2: "Anthropic default; Gemini/OpenAI/local"): any
// OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, LM Studio, …) for
// customer data-governance constraints where code may not leave the network.
const LOCAL_BASE_URL_VAR = "DOBETTER_LOCAL_BASE_URL";
const LOCAL_API_KEY_VAR = "DOBETTER_LOCAL_API_KEY";
const LOCAL_MODEL_VAR = "DOBETTER_LOCAL_MODEL";
// Autodetect order is anthropic-first by contract; local is detected last.
const AUTODETECT_ORDER = ["anthropic", "gemini", "openai"];
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

// Robustly extract JSON from a model response even when wrapped in prose or
// markdown code fences (skill-mining pattern).
export function cleanJsonResponse(text) {
  let cleaned = String(text ?? "").trim();
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let startIdx = -1;
  let endIdx = -1;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endIdx = cleaned.lastIndexOf("}");
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = cleaned.lastIndexOf("]");
  }
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }
  if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
  return cleaned.trim();
}

function resolveModels(provider, flags) {
  // Validate overrides only when actually provided (blueprint §4: validate
  // model OVERRIDES; absent overrides resolve to the provider defaults).
  if (flags.modelCheap != null) assertSafeModelName(flags.modelCheap, "--model-cheap");
  if (flags.modelMid != null) assertSafeModelName(flags.modelMid, "--model-mid");
  if (flags.modelFrontier != null) assertSafeModelName(flags.modelFrontier, "--model-frontier");
  const defaults = DEFAULT_MODELS[provider] ?? DEFAULT_MODELS.anthropic;
  return {
    cheap: flags.modelCheap || defaults.cheap,
    mid: flags.modelMid || defaults.mid,
    frontier: flags.modelFrontier || defaults.frontier,
  };
}

// Local provider config: OpenAI-compatible base URL + model names from env
// (per-tier --model-* flags override the DOBETTER_LOCAL_MODEL default).
function configureLocal(flags, env) {
  const baseUrl = String(env[LOCAL_BASE_URL_VAR] ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new OpError(
      `Provider "local" requested but ${LOCAL_BASE_URL_VAR} is not set. Point it at an ` +
        `OpenAI-compatible endpoint (e.g. http://localhost:11434/v1 for Ollama).`
    );
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new OpError(`${LOCAL_BASE_URL_VAR} must be an http(s) URL, got "${baseUrl}".`);
  }
  const defaultModel = env[LOCAL_MODEL_VAR] || null;
  if (defaultModel != null) assertSafeModelName(defaultModel, LOCAL_MODEL_VAR);
  if (flags.modelCheap != null) assertSafeModelName(flags.modelCheap, "--model-cheap");
  if (flags.modelMid != null) assertSafeModelName(flags.modelMid, "--model-mid");
  if (flags.modelFrontier != null) assertSafeModelName(flags.modelFrontier, "--model-frontier");
  const models = {
    cheap: flags.modelCheap || defaultModel,
    mid: flags.modelMid || defaultModel,
    frontier: flags.modelFrontier || defaultModel,
  };
  const missing = TIERS.filter((t) => !models[t]);
  if (missing.length) {
    throw new OpError(
      `Provider "local" requires model names for tier(s) ${missing.join(", ")}: set ${LOCAL_MODEL_VAR} ` +
        `or pass --model-cheap/--model-mid/--model-frontier.`
    );
  }
  return {
    provider: "local",
    apiKey: env[LOCAL_API_KEY_VAR] || "local",
    baseUrl,
    models,
    offline: Boolean(flags.offline),
  };
}

// Resolve the provider configuration from flags + env (skill-mining pattern).
// Providers: anthropic|gemini|openai hosted APIs, plus "local" = any
// OpenAI-compatible endpoint (D2 data-governance escape hatch). Arbitrary
// local CLI agents remain unsupported in v1.
export function configureProvider(flags = {}, env = process.env) {
  const offline = Boolean(flags.offline);

  if (flags.provider != null) {
    const provider = flags.provider;
    if (provider === "local") return configureLocal(flags, env);
    if (!Object.hasOwn(KEY_VARS, provider)) {
      throw new OpError(
        `Unsupported provider "${provider}". do-better supports --provider anthropic|gemini|openai|local ` +
          `(local = an OpenAI-compatible endpoint via ${LOCAL_BASE_URL_VAR}; ` +
          `arbitrary local CLI providers are not supported in v1).`
      );
    }
    const keyVar = KEY_VARS[provider];
    if (!env[keyVar]) {
      throw new OpError(`Provider "${provider}" requested but ${keyVar} is not set.`);
    }
    return { provider, apiKey: env[keyVar], models: resolveModels(provider, flags), offline };
  }

  for (const provider of AUTODETECT_ORDER) {
    if (env[KEY_VARS[provider]]) {
      return { provider, apiKey: env[KEY_VARS[provider]], models: resolveModels(provider, flags), offline };
    }
  }

  // Local endpoint detected last: hosted keys win, but a configured local
  // server keeps fully air-gapped engagements LLM-capable (SPEC D2).
  if (env[LOCAL_BASE_URL_VAR]) return configureLocal(flags, env);

  if (offline) {
    // Offline still constructs a config so spend/budget plumbing exists; the
    // anthropic defaults are placeholders (no call ever leaves the process).
    return { provider: "offline", apiKey: null, models: resolveModels("anthropic", flags), offline: true };
  }

  throw new OpError(
    "No LLM provider configured. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY " +
      `(or pass --provider with its key), set ${LOCAL_BASE_URL_VAR} for a local OpenAI-compatible ` +
      "endpoint (--provider local), or run with --offline to degrade to static analysis."
  );
}

function buildRequest(provider, { model, prompt, system, jsonMode, apiKey, baseUrl }) {
  if (provider === "openai" || provider === "local") {
    return {
      url: provider === "local" ? `${baseUrl}/chat/completions` : "https://api.openai.com/v1/chat/completions",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: {
        model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          { role: "user", content: prompt },
        ],
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: jsonMode ? { type: "json_object" } : undefined,
      },
      parse(data) {
        const text = data?.choices?.[0]?.message?.content;
        if (typeof text !== "string") {
          throw new Error(`Invalid response format from ${provider === "local" ? "local OpenAI-compatible" : "OpenAI"} API: ${JSON.stringify(data).slice(0, 300)}`);
        }
        return { text, tokensIn: intOrNull(data?.usage?.prompt_tokens), tokensOut: intOrNull(data?.usage?.completion_tokens) };
      },
    };
  }
  if (provider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        messages: [{ role: "user", content: prompt }],
        system: system || undefined,
        max_tokens: MAX_OUTPUT_TOKENS,
      },
      parse(data) {
        const text = data?.content?.[0]?.text;
        if (typeof text !== "string") {
          throw new Error(`Invalid response format from Anthropic API: ${JSON.stringify(data).slice(0, 300)}`);
        }
        return { text, tokensIn: intOrNull(data?.usage?.input_tokens), tokensOut: intOrNull(data?.usage?.output_tokens) };
      },
    };
  }
  if (provider === "gemini") {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      headers: { "Content-Type": "application/json" },
      body: {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        generationConfig: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...(jsonMode ? { responseMimeType: "application/json" } : {}),
        },
      },
      parse(data) {
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== "string") {
          throw new Error(`Invalid response format from Gemini API: ${JSON.stringify(data).slice(0, 300)}`);
        }
        return {
          text,
          tokensIn: intOrNull(data?.usageMetadata?.promptTokenCount),
          tokensOut: intOrNull(data?.usageMetadata?.candidatesTokenCount),
        };
      },
    };
  }
  throw new OpError(`No request builder for provider "${provider}".`);
}

function intOrNull(v) {
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Create the LLM service object — the ONE sanctioned mutable accumulator
// (spend). Never returns null; offline still constructs.
export function createLLM({ flags = {}, state = null, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const fakePath = env.DOBETTER_FAKE_LLM || null;
  // Test seam: when DOBETTER_FAKE_LLM is set, providers/keys are ignored
  // entirely and no network code path is reachable.
  const config = fakePath
    ? { provider: "fake", apiKey: null, models: { ...DEFAULT_MODELS.anthropic }, offline: Boolean(flags.offline) }
    : configureProvider(flags, env);
  const offline = config.offline || config.provider === "offline";

  let limit = null;
  if (flags.budget != null) {
    if (typeof flags.budget !== "number" || !Number.isFinite(flags.budget) || flags.budget <= 0) {
      throw new OpError(`Invalid --budget: expected a positive number of USD, got "${flags.budget}".`);
    }
    limit = flags.budget;
  } else if (typeof state?.budget?.limitUSD === "number" && Number.isFinite(state.budget.limitUSD) && state.budget.limitUSD > 0) {
    limit = state.budget.limitUSD;
  }
  // Running total of spend already reconciled out of the accumulator. Seeded
  // from state.budget.spentUSD and ADVANCED by drainSpend() on every phase
  // boundary — one llm instance spans all phases of `do-better run`, so without
  // this promotion each drain would make later phases' budget checks forget all
  // prior spend and silently blow the hard --budget ceiling (D10).
  let spentBase = Number.isFinite(state?.budget?.spentUSD) ? state.budget.spentUSD : 0;

  const accumulated = { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 };
  let fakeFnPromise = null;

  function estimateTokens(text) {
    return Math.ceil(String(text ?? "").length / 4);
  }

  // Fake mode prices by the anthropic tier table (contract: budget logic stays
  // testable offline); provider mode prices by the resolved model.
  function priceFor(tier) {
    // Local inference has no per-token API cost; spend stays accounted at $0.
    if (config.provider === "local") return { in: 0, out: 0 };
    const priceProvider = config.provider === "fake" || config.provider === "offline" ? "anthropic" : config.provider;
    const model = config.provider === "fake" ? DEFAULT_MODELS.anthropic[tier] : config.models[tier];
    if (PRICES[model]) return PRICES[model];
    const tierDefault = DEFAULT_MODELS[priceProvider]?.[tier];
    if (tierDefault && PRICES[tierDefault]) return PRICES[tierDefault];
    return FALLBACK_PRICE;
  }

  function checkBudget(prompt, system, tier) {
    if (limit === null) return;
    const price = priceFor(tier);
    const spent = spentBase + accumulated.costUSD;
    const estCost =
      (estimateTokens(prompt + system) / 1e6) * price.in + (MAX_OUTPUT_TOKENS / 1e6) * price.out;
    if (spent + estCost > limit) {
      throw new BudgetError(
        `Budget $${limit} would be exceeded (spent $${spent.toFixed(4)}, next call ≈ $${estCost.toFixed(4)}). ` +
          `Re-run with a higher --budget to resume; state.json preserves completed work.`
      );
    }
  }

  function recordSpend(tokensIn, tokensOut, tier) {
    const price = priceFor(tier);
    accumulated.calls += 1;
    accumulated.tokensIn += tokensIn;
    accumulated.tokensOut += tokensOut;
    accumulated.costUSD += (tokensIn / 1e6) * price.in + (tokensOut / 1e6) * price.out;
  }

  function loadFake() {
    if (!fakeFnPromise) {
      fakeFnPromise = import(pathToFileURL(path.resolve(fakePath)).href).then((mod) => {
        if (typeof mod.default !== "function") {
          throw new OpError(`DOBETTER_FAKE_LLM module must default-export an async function: ${fakePath}`);
        }
        return mod.default;
      });
    }
    return fakeFnPromise;
  }

  async function callProvider(prompt, system, tier, jsonMode, label) {
    const model = config.models[tier];
    let delay = RETRY_BASE_DELAY_MS;
    let lastErr = null;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        const req = buildRequest(config.provider, { model, prompt, system, jsonMode, apiKey: config.apiKey, baseUrl: config.baseUrl });
        const res = await fetchImpl(req.url, {
          method: "POST",
          headers: req.headers,
          body: JSON.stringify(req.body),
        });
        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`${config.provider} API error (${res.status}): ${errText}`);
        }
        const data = await res.json();
        const { text, tokensIn, tokensOut } = req.parse(data);
        recordSpend(tokensIn ?? estimateTokens(prompt + system), tokensOut ?? estimateTokens(text), tier);
        return text;
      } catch (err) {
        lastErr = err;
        if (attempt < RETRY_ATTEMPTS) {
          log.warn(`${label}: LLM call failed (attempt ${attempt}/${RETRY_ATTEMPTS}): ${err.message} — retrying in ${delay}ms`);
          await sleep(delay);
          delay *= 2;
        }
      }
    }
    throw new OpError(
      `${label}: LLM call failed after ${RETRY_ATTEMPTS} attempts (${config.provider}/${model}): ${lastErr?.message ?? "unknown error"}`
    );
  }

  async function call(prompt, { system = "", tier = "mid", label = "LLM", jsonMode = false } = {}) {
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw new OpError(`${label}: LLM prompt must be a non-empty string.`);
    }
    if (typeof system !== "string") {
      throw new OpError(`${label}: LLM system instruction must be a string.`);
    }
    if (!TIERS.includes(tier)) {
      throw new OpError(`${label}: unknown LLM tier "${tier}" (expected one of: ${TIERS.join(", ")}).`);
    }
    if (offline) {
      throw new OfflineError(
        `${label}: LLM call attempted in --offline mode with no static fallback. ` +
          `Wrap call sites with withFallback() or remove --offline.`
      );
    }
    checkBudget(prompt, system, tier);
    if (config.provider === "fake") {
      const fake = await loadFake();
      const text = await fake({ prompt, system, tier, label, jsonMode });
      if (typeof text !== "string") {
        throw new OpError(`${label}: DOBETTER_FAKE_LLM module returned a non-string response.`);
      }
      recordSpend(estimateTokens(prompt + system), estimateTokens(text), tier);
      return text;
    }
    return callProvider(prompt, system, tier, jsonMode, label);
  }

  async function callJson(prompt, { system = "", tier = "mid", label = "LLM" } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const suffix =
        attempt === 0
          ? ""
          : "\n\nYour previous response was not valid JSON. Return ONLY valid JSON — no prose, no code fences.";
      const response = await call(prompt + suffix, { system, tier, label, jsonMode: true });
      try {
        return JSON.parse(cleanJsonResponse(response));
      } catch (err) {
        lastErr = err;
        log.warn(`${label}: response was not parseable JSON (attempt ${attempt + 1}/2)`);
      }
    }
    throw new OpError(`${label}: returned unparseable JSON after retry (${lastErr?.message ?? "unknown"}).`);
  }

  function drainSpend() {
    const out = { ...accumulated };
    // Promote drained cost into the running base BEFORE zeroing, so the budget
    // ceiling keeps counting cumulative spend across phase boundaries.
    spentBase += accumulated.costUSD;
    accumulated.calls = 0;
    accumulated.tokensIn = 0;
    accumulated.tokensOut = 0;
    accumulated.costUSD = 0;
    return out;
  }

  // Non-destructive read of cumulative USD spent so far (base + not-yet-drained
  // accumulator) — for progress display (H16). Unlike drainSpend() this does
  // NOT zero the accumulator, so it is safe to call mid-phase.
  function spentSoFar() {
    return spentBase + accumulated.costUSD;
  }

  return {
    offline,
    provider: config.provider,
    models: { ...config.models },
    call,
    callJson,
    drainSpend,
    spentSoFar,
    estimateTokens,
  };
}

// Deterministic-fallback wrapper for every LLM call site (D2/§4 --offline).
// Offline → fallbackFn(). Online → the LLM path; ONLY an OfflineError is
// downgraded to fallbackFn() — network/parse/budget failures rethrow (fail
// closed, never silently degrade). callArgs: { prompt, system?, tier?, label?,
// jsonMode?, json? } — json:true routes through callJson().
export async function withFallback(llm, callArgs, fallbackFn) {
  if (!llm || typeof llm.call !== "function") {
    throw new OpError("withFallback requires an LLM service object.");
  }
  if (typeof fallbackFn !== "function") {
    throw new OpError("withFallback requires a fallback function.");
  }
  const { prompt, json = false, ...opts } = callArgs ?? {};
  if (llm.offline) return fallbackFn();
  try {
    return json ? await llm.callJson(prompt, opts) : await llm.call(prompt, opts);
  } catch (err) {
    if (err instanceof OfflineError) return fallbackFn();
    throw err;
  }
}
