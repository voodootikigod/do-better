// test/llm.test.js — provider config, tier resolution, budget refusal,
// offline throw, fake hook. NO NETWORK EVER: every llm path here runs through
// DOBETTER_FAKE_LLM or --offline; fetchImpl is a tripwire where injected.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  TIERS,
  DEFAULT_MODELS,
  PRICES,
  MAX_OUTPUT_TOKENS,
  configureProvider,
  createLLM,
  withFallback,
  cleanJsonResponse,
} from "../src/llm.js";
import { OpError, BudgetError, OfflineError } from "../src/utils.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function writeFakeModule(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-fakellm-"));
  const file = path.join(dir, "fake.mjs");
  fs.writeFileSync(file, body);
  return file;
}

const ECHO_FAKE = `export default async function fake({ prompt, system, tier, label, jsonMode }) {
  return JSON.stringify({ tier, label, jsonMode, promptLen: prompt.length });
}`;

const FIXED_FAKE = `export default async function fake() { return "12345678"; }`; // 8 chars = 2 est. tokens

function fakeEnv(fakePath, extra = {}) {
  return { DOBETTER_FAKE_LLM: fakePath, ...extra };
}

const tripwireFetch = () => {
  throw new Error("network touched — fetch must be unreachable in tests");
};

// ── exported constants ───────────────────────────────────────────────────────

test("TIERS are the spec §6 names, in order", () => {
  assert.deepEqual(TIERS, ["cheap", "mid", "frontier"]);
});

test("MAX_OUTPUT_TOKENS and price table cover every default model", () => {
  assert.equal(MAX_OUTPUT_TOKENS, 16000);
  for (const provider of Object.keys(DEFAULT_MODELS)) {
    for (const tier of TIERS) {
      const model = DEFAULT_MODELS[provider][tier];
      assert.ok(PRICES[model], `PRICES missing for ${provider}/${tier} default ${model}`);
    }
  }
});

// ── configureProvider ────────────────────────────────────────────────────────

test("configureProvider autodetects anthropic first when several keys are set", () => {
  const config = configureProvider(
    {},
    { ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" }
  );
  assert.equal(config.provider, "anthropic");
  assert.equal(config.apiKey, "a");
  assert.equal(config.offline, false);
});

test("configureProvider autodetects gemini then openai when anthropic key absent", () => {
  assert.equal(configureProvider({}, { GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" }).provider, "gemini");
  assert.equal(configureProvider({}, { OPENAI_API_KEY: "o" }).provider, "openai");
});

test("named provider without its key throws OpError naming the env var", () => {
  assert.throws(
    () => configureProvider({ provider: "openai" }, { ANTHROPIC_API_KEY: "a" }),
    (err) => err instanceof OpError && /OPENAI_API_KEY is not set/.test(err.message)
  );
});

test("arbitrary local CLI providers are rejected in v1", () => {
  assert.throws(
    () => configureProvider({ provider: "claude" }, {}),
    (err) => err instanceof OpError && /anthropic\|gemini\|openai/.test(err.message)
  );
});

// ── local provider (SPEC D2: Anthropic default; Gemini/OpenAI/local) ─────────

test("local provider: OpenAI-compatible endpoint via DOBETTER_LOCAL_BASE_URL", () => {
  const env = { DOBETTER_LOCAL_BASE_URL: "http://localhost:11434/v1/", DOBETTER_LOCAL_MODEL: "qwen2.5-coder" };
  const config = configureProvider({ provider: "local" }, env);
  assert.equal(config.provider, "local");
  assert.equal(config.baseUrl, "http://localhost:11434/v1", "trailing slash normalized");
  assert.deepEqual(config.models, { cheap: "qwen2.5-coder", mid: "qwen2.5-coder", frontier: "qwen2.5-coder" });
  // per-tier overrides win over the env default
  const tiered = configureProvider(
    { provider: "local", modelFrontier: "llama3.3-70b" },
    env
  );
  assert.equal(tiered.models.frontier, "llama3.3-70b");
  assert.equal(tiered.models.cheap, "qwen2.5-coder");
});

test("local provider requires the base URL and model names (fail closed, with remediation)", () => {
  assert.throws(
    () => configureProvider({ provider: "local" }, {}),
    (err) => err instanceof OpError && /DOBETTER_LOCAL_BASE_URL/.test(err.message)
  );
  assert.throws(
    () => configureProvider({ provider: "local" }, { DOBETTER_LOCAL_BASE_URL: "http://localhost:1234/v1" }),
    (err) => err instanceof OpError && /DOBETTER_LOCAL_MODEL/.test(err.message) && /--model-cheap/.test(err.message)
  );
  assert.throws(
    () => configureProvider({ provider: "local" }, { DOBETTER_LOCAL_BASE_URL: "ftp://nope", DOBETTER_LOCAL_MODEL: "m" }),
    (err) => err instanceof OpError && /http\(s\)/.test(err.message)
  );
});

test("local endpoint is autodetected last — hosted keys win", () => {
  const localEnv = { DOBETTER_LOCAL_BASE_URL: "http://x/v1", DOBETTER_LOCAL_MODEL: "m" };
  assert.equal(configureProvider({}, { ANTHROPIC_API_KEY: "a", ...localEnv }).provider, "anthropic");
  assert.equal(configureProvider({}, localEnv).provider, "local");
});

test("local provider posts to <base>/chat/completions (OpenAI shape) and costs $0", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: "pong" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    };
  };
  const llm = createLLM({
    flags: { provider: "local" },
    env: { DOBETTER_LOCAL_BASE_URL: "http://localhost:8080/v1", DOBETTER_LOCAL_MODEL: "local-model" },
    fetchImpl,
  });
  assert.equal(llm.provider, "local");
  assert.equal(await llm.call("ping", { tier: "mid", label: "t" }), "pong");
  assert.equal(seen[0].url, "http://localhost:8080/v1/chat/completions");
  assert.equal(seen[0].body.model, "local-model");
  assert.equal(seen[0].body.messages[0].content, "ping");
  const spend = llm.drainSpend();
  assert.equal(spend.calls, 1);
  assert.equal(spend.costUSD, 0, "local inference accounted at $0");
});

test("no provider at all throws OpError listing the env vars and --offline", () => {
  assert.throws(
    () => configureProvider({}, {}),
    (err) =>
      err instanceof OpError &&
      /ANTHROPIC_API_KEY/.test(err.message) &&
      /GEMINI_API_KEY/.test(err.message) &&
      /OPENAI_API_KEY/.test(err.message) &&
      /--offline/.test(err.message)
  );
});

test("no provider + --offline yields the offline escape hatch config", () => {
  const config = configureProvider({ offline: true }, {});
  assert.equal(config.provider, "offline");
  assert.equal(config.offline, true);
  assert.equal(config.apiKey, null);
});

test("tier default models per provider match DEFAULT_MODELS", () => {
  for (const [provider, keyVar] of [
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["gemini", "GEMINI_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
  ]) {
    const config = configureProvider({ provider }, { [keyVar]: "k" });
    assert.deepEqual(config.models, DEFAULT_MODELS[provider], provider);
  }
});

test("per-tier model overrides apply and are charset-validated", () => {
  const env = { ANTHROPIC_API_KEY: "a" };
  const config = configureProvider({ modelCheap: "my-cheap-model", modelFrontier: "vendor/model:tag" }, env);
  assert.equal(config.models.cheap, "my-cheap-model");
  assert.equal(config.models.mid, DEFAULT_MODELS.anthropic.mid);
  assert.equal(config.models.frontier, "vendor/model:tag");

  for (const bad of ["x; rm -rf /", "$(cmd)", "a model"]) {
    assert.throws(() => configureProvider({ modelMid: bad }, env), OpError, bad);
  }
});

// ── createLLM: offline ───────────────────────────────────────────────────────

test("offline LLM constructs but call()/callJson() throw OfflineError immediately", async () => {
  const llm = createLLM({ flags: { offline: true }, env: {} });
  assert.equal(llm.offline, true);
  assert.equal(llm.provider, "offline");
  await assert.rejects(llm.call("hello"), OfflineError);
  await assert.rejects(llm.callJson("hello"), OfflineError);
});

test("offline wins even when DOBETTER_FAKE_LLM is set", async () => {
  const fakePath = writeFakeModule(ECHO_FAKE);
  const llm = createLLM({ flags: { offline: true }, env: fakeEnv(fakePath) });
  assert.equal(llm.offline, true);
  await assert.rejects(llm.call("hello"), OfflineError);
});

test("withFallback routes to fallbackFn when offline", async () => {
  const llm = createLLM({ flags: { offline: true }, env: {} });
  const value = await withFallback(llm, { prompt: "x", tier: "cheap", label: "t" }, () => "static");
  assert.equal(value, "static");
});

test("withFallback does NOT swallow non-Offline errors (fail closed)", async () => {
  const fakePath = writeFakeModule(`export default async function fake() { throw new Error("boom"); }`);
  const llm = createLLM({ env: fakeEnv(fakePath) });
  await assert.rejects(
    withFallback(llm, { prompt: "x", tier: "cheap", label: "t" }, () => "static"),
    /boom/
  );
});

test("withFallback json:true routes through callJson", async () => {
  const fakePath = writeFakeModule(`export default async function fake() { return '{"a": 1}'; }`);
  const llm = createLLM({ env: fakeEnv(fakePath) });
  const value = await withFallback(llm, { prompt: "x", json: true, tier: "mid", label: "t" }, () => null);
  assert.deepEqual(value, { a: 1 });
});

// ── createLLM: fake hook + no-network proof ─────────────────────────────────

test("DOBETTER_FAKE_LLM ignores providers/keys entirely; fake receives call args", async () => {
  const fakePath = writeFakeModule(ECHO_FAKE);
  const llm = createLLM({
    flags: { provider: "anthropic" }, // no key in env — would throw without the fake seam
    env: fakeEnv(fakePath),
    fetchImpl: tripwireFetch,
  });
  assert.equal(llm.provider, "fake");
  const seen = JSON.parse(await llm.call("hello", { tier: "cheap", label: "codemap", jsonMode: true }));
  assert.equal(seen.tier, "cheap");
  assert.equal(seen.label, "codemap");
  assert.equal(seen.jsonMode, true);
  assert.equal(seen.promptLen, 5);
});

test("no-network proof: bogus key + fake seam never touches fetch", async () => {
  const fakePath = writeFakeModule(FIXED_FAKE);
  const llm = createLLM({
    env: fakeEnv(fakePath, { ANTHROPIC_API_KEY: "bogus" }),
    fetchImpl: tripwireFetch,
  });
  assert.equal(await llm.call("ping"), "12345678");
});

test("unknown tier is rejected (fail closed)", async () => {
  const fakePath = writeFakeModule(FIXED_FAKE);
  const llm = createLLM({ env: fakeEnv(fakePath) });
  await assert.rejects(llm.call("x", { tier: "strong" }), (err) => err instanceof OpError && /tier/.test(err.message));
});

test("empty or non-string prompt is rejected", async () => {
  const fakePath = writeFakeModule(FIXED_FAKE);
  const llm = createLLM({ env: fakeEnv(fakePath) });
  await assert.rejects(llm.call(""), OpError);
  await assert.rejects(llm.call(42), OpError);
});

// ── spend accounting + budget (D10) ─────────────────────────────────────────

test("spend is accounted in fake mode from estimateTokens + anthropic tier prices", async () => {
  const fakePath = writeFakeModule(FIXED_FAKE);
  const llm = createLLM({ env: fakeEnv(fakePath) });
  const prompt = "x".repeat(400); // 100 estimated tokens; response 8 chars → 2 tokens
  await llm.call(prompt, { tier: "cheap" });

  const haiku = PRICES[DEFAULT_MODELS.anthropic.cheap];
  const expectedCost = (100 / 1e6) * haiku.in + (2 / 1e6) * haiku.out;
  const spend = llm.drainSpend();
  assert.equal(spend.calls, 1);
  assert.equal(spend.tokensIn, 100);
  assert.equal(spend.tokensOut, 2);
  assert.ok(Math.abs(spend.costUSD - expectedCost) < 1e-12, `costUSD ${spend.costUSD}`);

  // drainSpend resets the accumulator
  assert.deepEqual(llm.drainSpend(), { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 });
});

test("budget: first call fits, second call is refused with resume instructions", async () => {
  const fakePath = writeFakeModule(FIXED_FAKE);
  const haiku = PRICES[DEFAULT_MODELS.anthropic.cheap];
  // Pre-call projection per call: 100 in-tokens + MAX_OUTPUT_TOKENS reserved out.
  const projection = (100 / 1e6) * haiku.in + (MAX_OUTPUT_TOKENS / 1e6) * haiku.out;
  const actualFirstCost = (100 / 1e6) * haiku.in + (2 / 1e6) * haiku.out;
  const limit = projection + actualFirstCost / 2; // fits once, not twice

  const llm = createLLM({ flags: { budget: limit }, env: fakeEnv(fakePath) });
  const prompt = "x".repeat(400);
  await llm.call(prompt, { tier: "cheap" }); // fits exactly under limit
  await assert.rejects(
    llm.call(prompt, { tier: "cheap" }),
    (err) =>
      err instanceof BudgetError &&
      /--budget/.test(err.message) &&
      /state\.json preserves completed work/.test(err.message)
  );
});

test("budget limit and prior spend come from state.json when no --budget flag", async () => {
  const fakePath = writeFakeModule(FIXED_FAKE);
  const state = { budget: { limitUSD: 0.05, spentUSD: 0.04 } };
  const llm = createLLM({ state, env: fakeEnv(fakePath) });
  // cheap-tier projection ≈ $0.0801 — 0.04 already spent blows the $0.05 limit.
  await assert.rejects(llm.call("x".repeat(400), { tier: "cheap" }), BudgetError);
  // Nothing was spent on the refused call.
  assert.deepEqual(llm.drainSpend(), { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 });
});

test("invalid budget values are rejected at construction", () => {
  const fakePath = writeFakeModule(FIXED_FAKE);
  for (const bad of [-1, 0, NaN, Infinity, "ten"]) {
    assert.throws(() => createLLM({ flags: { budget: bad }, env: fakeEnv(fakePath) }), OpError, String(bad));
  }
});

test("estimateTokens is ceil(length/4)", () => {
  const llm = createLLM({ flags: { offline: true }, env: {} });
  assert.equal(llm.estimateTokens(""), 0);
  assert.equal(llm.estimateTokens("abcd"), 1);
  assert.equal(llm.estimateTokens("abcde"), 2);
});

// ── callJson ─────────────────────────────────────────────────────────────────

test("callJson parses fenced JSON responses", async () => {
  const fakePath = writeFakeModule(
    'export default async function fake() { return "```json\\n{\\"a\\": 1}\\n```"; }'
  );
  const llm = createLLM({ env: fakeEnv(fakePath) });
  assert.deepEqual(await llm.callJson("x", { tier: "mid", label: "t" }), { a: 1 });
});

test("callJson re-asks once on a parse failure, then succeeds", async () => {
  const fakePath = writeFakeModule(`let n = 0;
export default async function fake({ prompt }) {
  n += 1;
  if (n === 1) return "this is not json at all";
  return JSON.stringify({ ok: true, reasked: prompt.includes("valid JSON") });
}`);
  const llm = createLLM({ env: fakeEnv(fakePath) });
  const value = await llm.callJson("x", { tier: "mid", label: "t" });
  assert.equal(value.ok, true);
  assert.equal(value.reasked, true, "re-ask suffix must instruct: Return ONLY valid JSON");
  assert.equal(llm.drainSpend().calls, 2);
});

test("callJson throws a labelled OpError after garbage twice", async () => {
  const fakePath = writeFakeModule(`export default async function fake() { return "still not json"; }`);
  const llm = createLLM({ env: fakeEnv(fakePath) });
  await assert.rejects(
    llm.callJson("x", { tier: "frontier", label: "verdict" }),
    (err) => err instanceof OpError && /verdict/.test(err.message) && /unparseable JSON/.test(err.message)
  );
});

// ── cleanJsonResponse ────────────────────────────────────────────────────────

test("cleanJsonResponse extracts JSON from fences, prose, and arrays", () => {
  assert.equal(cleanJsonResponse('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(cleanJsonResponse('Sure! Here you go: {"a":1} — enjoy'), '{"a":1}');
  assert.equal(cleanJsonResponse("[1, 2, 3] trailing"), "[1, 2, 3]");
  assert.equal(cleanJsonResponse('```\n[{"x":1}]\n```'), '[{"x":1}]');
});
