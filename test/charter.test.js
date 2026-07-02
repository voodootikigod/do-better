// test/charter.test.js — D0 charter: static question plan, scripted-answer
// interview (DOBETTER_ANSWERS seam), taxonomy floor enforcement, approval
// gate flow (HUMAN GATE 1), parseCharter validation. No network ever.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PHASE_ID, approve, buildStaticQuestionPlan, parseCharter, run } from "../src/charter.js";
import { run as scanRun, collectRepoFacts } from "../src/scan.js";
import { OfflineError, OpError, TAXONOMY, makeExec } from "../src/utils.js";
import { defaultState } from "../src/state.js";
import { LAYOUT, readArtifact } from "../src/artifacts.js";

const NOW = "2026-06-12T00:00:00.000Z";

const TINY_REPO = {
  "package.json":
    JSON.stringify(
      {
        name: "tiny",
        version: "1.0.0",
        scripts: { test: "node --test", start: "node src/server.js" },
        dependencies: { express: "^4.19.0" },
        devDependencies: { nodemon: "^3.0.0" },
      },
      null,
      2
    ) + "\n",
  "src/server.js": ['import http from "node:http";', "// TODO: handle errors", "export const x = 1;", ""].join("\n"),
  "test/server.test.js": ['test("placeholder", () => {});', ""].join("\n"),
  "README.md": ["# tiny", "", "Fixture repo.", ""].join("\n"),
};

// No tests, no manifests → exercises the grill-me codebase-check clause.
const BARE_REPO = {
  "src/app.js": ['console.log("app");', "function main() {}", ""].join("\n"),
  "README.md": ["# bare", ""].join("\n"),
};

function gitIn(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function makeRepo(files = TINY_REPO) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-charter-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  gitIn(root, ["init", "-q"]);
  gitIn(root, ["config", "user.email", "tests@example.com"]);
  gitIn(root, ["config", "user.name", "do-better tests"]);
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-q", "-m", "init"]);
  return { root, headSha: gitIn(root, ["rev-parse", "HEAD"]).trim() };
}

function stubLog() {
  const noop = () => {};
  return {
    info: noop,
    success: noop,
    warn: noop,
    error: noop,
    phase: noop,
    gate: noop,
    step: noop,
    substep: noop,
    errorTrace: noop,
  };
}

const ZERO_SPEND = { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 };

function makeOfflineLLM() {
  return {
    offline: true,
    provider: "offline",
    models: {},
    call: async () => {
      throw new OfflineError("offline mode: no LLM calls");
    },
    callJson: async () => {
      throw new OfflineError("offline mode: no LLM calls");
    },
    drainSpend: () => ({ ...ZERO_SPEND }),
    estimateTokens: (t) => Math.ceil(String(t).length / 4),
  };
}

function makeScriptedLLM(script) {
  const calls = [];
  const counts = {};
  const spend = { ...ZERO_SPEND };
  async function call(prompt, opts = {}) {
    const { label = "LLM", tier = "mid" } = opts;
    calls.push({ label, tier, prompt: String(prompt) });
    spend.calls += 1;
    spend.tokensIn += Math.ceil(String(prompt).length / 4);
    spend.tokensOut += 50;
    spend.costUSD += 0.01;
    const entry = script[label];
    if (entry == null) throw new Error(`scripted LLM: no response for label "${label}"`);
    const idx = counts[label] ?? 0;
    counts[label] = idx + 1;
    const item = Array.isArray(entry) ? entry[Math.min(idx, entry.length - 1)] : entry;
    return typeof item === "function" ? item({ prompt, ...opts }) : item;
  }
  const llm = {
    offline: false,
    provider: "fake",
    models: { cheap: "fake-cheap", mid: "fake-mid", frontier: "fake-frontier" },
    call,
    callJson: async (prompt, opts = {}) => JSON.parse(await call(prompt, { ...opts, jsonMode: true })),
    drainSpend: () => {
      const out = { ...spend };
      spend.calls = 0;
      spend.tokensIn = 0;
      spend.tokensOut = 0;
      spend.costUSD = 0;
      return out;
    },
    estimateTokens: (t) => Math.ceil(String(t).length / 4),
  };
  return { llm, calls };
}

function makeCtx(root, headSha, { llm = makeOfflineLLM(), state = null, ask = null } = {}) {
  return {
    root,
    dotdir: path.join(root, ".dobetter"),
    state: state ?? defaultState({ headSha, now: NOW }),
    llm,
    adlc: { mode: "absent", dir: null, available: {} },
    flags: { command: "charter", target: root, offline: llm.offline === true },
    log: stubLog(),
    now: () => NOW,
    exec: makeExec(),
    ask,
  };
}

// Run scan first so state carries facts (charter reads them from state, D9).
async function scannedCtx(files, opts = {}) {
  const { root, headSha } = makeRepo(files);
  const scanResult = await scanRun(makeCtx(root, headSha));
  return { ctx: makeCtx(root, headSha, { ...opts, state: scanResult.state }), root, headSha };
}

async function withAnswers(answers, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-ans-"));
  const file = path.join(dir, "answers.json");
  fs.writeFileSync(file, JSON.stringify(answers));
  const prev = process.env.DOBETTER_ANSWERS;
  process.env.DOBETTER_ANSWERS = file;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DOBETTER_ANSWERS;
    else process.env.DOBETTER_ANSWERS = prev;
  }
}

function readCharterRaw(ctx) {
  return fs.readFileSync(path.join(ctx.dotdir, LAYOUT.charter), "utf8");
}

// pain, intent, constraints, then all 8 taxonomy weights in canonical order.
const FULL_ANSWERS = [
  "Slow CI and flaky deploys",
  "scale",
  "No database schema changes",
  "4", // correctness
  "5", // security
  "3", // maintainability
  "2", // performance
  "3", // operability
  "0", // test-quality — below floor, must be corrected to 1
  "1", // dependency-health
  "2", // dx
];

test("buildStaticQuestionPlan covers pain, intent, constraints and all 8 dimensions", () => {
  const { root } = makeRepo();
  const facts = collectRepoFacts(root, makeExec());
  const plan = buildStaticQuestionPlan(facts);

  assert.ok(plan.length <= 12, "≤12 questions");
  const ids = plan.map((q) => q.id);
  for (const id of ["pain", "intent", "constraints"]) assert.ok(ids.includes(id), `plan includes ${id}`);
  for (const dim of TAXONOMY) {
    const q = plan.find((p) => p.id === `weight-${dim.id}`);
    assert.ok(q, `plan includes weight question for ${dim.id}`);
    assert.equal(q.dimension, dim.id);
  }
  for (const q of plan) {
    assert.equal(typeof q.text, "string");
    assert.ok(q.text.length > 0);
    assert.equal(typeof q.recommended, "string");
  }
  // questions cite concrete scan facts
  assert.match(plan.find((q) => q.id === "pain").text, /4 files/);
  assert.equal(PHASE_ID, "charter");
});

test("run() without scan facts is an OpError pointing at `do-better scan`", async () => {
  const { root, headSha } = makeRepo();
  const ctx = makeCtx(root, headSha); // defaultState: no facts
  await withAnswers(FULL_ANSWERS, () =>
    assert.rejects(
      () => run(ctx),
      (err) => {
        assert.ok(err instanceof OpError);
        assert.match(err.message, /do-better scan/);
        return true;
      }
    )
  );
});

test("offline run() with scripted answers drafts the charter and pauses at HUMAN GATE 1", async () => {
  const { ctx, headSha } = await scannedCtx(TINY_REPO);
  const result = await withAnswers([...FULL_ANSWERS, "n"], () => run(ctx));

  // human gate, not approved, with resume instructions
  assert.deepEqual(
    { name: result.gate.name, passed: result.gate.passed, human: result.gate.human },
    { name: "charter", passed: false, human: true }
  );
  assert.match(result.gate.detail, /charter --approve/);
  assert.match(result.summary, /charter --approve/);

  // gate state untouched; phase recorded done + pinned
  assert.equal(result.state.gates.charter.approved, false);
  assert.equal(result.state.gates.charter.charterSha256, null);
  assert.equal(result.state.phases.charter.status, "done");
  assert.equal(result.state.pins.charter, headSha);

  // charter content round-trips through parseCharter with the floor enforced
  const raw = readCharterRaw(ctx);
  const charter = parseCharter(raw);
  assert.equal(charter.intent, "scale");
  assert.deepEqual(charter.pain, ["Slow CI and flaky deploys"]);
  assert.deepEqual(charter.constraints, ["No database schema changes"]);
  assert.equal(charter.approved, false);
  assert.deepEqual(charter.weights, {
    correctness: 4,
    security: 5,
    maintainability: 3,
    performance: 2,
    operability: 3,
    "test-quality": 1, // "0" answered → floor-corrected
    "dependency-health": 1,
    dx: 2,
  });
  assert.match(raw, /1 \(floor\)/);
  assert.match(raw, /every question was asked/i);
});

test("answering y at the approval prompt sets HUMAN GATE 1 and flips approved", async () => {
  const { ctx } = await scannedCtx(TINY_REPO);
  const result = await withAnswers([...FULL_ANSWERS, "y"], () => run(ctx));

  assert.equal(result.gate.passed, true);
  assert.equal(result.gate.human, true);
  assert.equal(result.state.gates.charter.approved, true);
  assert.equal(result.state.gates.charter.approvedAt, NOW);
  assert.match(result.state.gates.charter.charterSha256, /^[0-9a-f]{64}$/);

  const artifact = readArtifact(ctx.dotdir, LAYOUT.charter);
  assert.equal(artifact.meta.approved, true);
  assert.equal(parseCharter(readCharterRaw(ctx)).approved, true);
});

test("approve(ctx) approves a previously drafted charter; missing charter is an OpError", async () => {
  const { ctx } = await scannedCtx(TINY_REPO);

  // missing charter file
  await assert.rejects(
    () => approve(ctx),
    (err) => {
      assert.ok(err instanceof OpError);
      assert.match(err.message, /No charter found/);
      return true;
    }
  );

  const drafted = await withAnswers([...FULL_ANSWERS, "n"], () => run(ctx));
  assert.equal(drafted.state.gates.charter.approved, false);

  const approveResult = await approve({ ...ctx, state: drafted.state });
  assert.equal(approveResult.gate.passed, true);
  assert.equal(approveResult.state.gates.charter.approved, true);
  assert.match(approveResult.state.gates.charter.charterSha256, /^[0-9a-f]{64}$/);
  assert.match(approveResult.summary, /audit/);
  assert.equal(readArtifact(ctx.dotdir, LAYOUT.charter).meta.approved, true);
});

test("parseCharter rejects a charter missing a taxonomy weight; approve() fails closed on it", async () => {
  const { ctx } = await scannedCtx(TINY_REPO);
  const drafted = await withAnswers([...FULL_ANSWERS, "n"], () => run(ctx));
  const raw = readCharterRaw(ctx);
  assert.ok(parseCharter(raw), "untouched charter parses");

  const mutated = raw.replace(/^ {2}dx: \d+\r?\n/m, "");
  assert.notEqual(mutated, raw, "mutation must remove the dx weight line");
  assert.throws(
    () => parseCharter(mutated),
    (err) => {
      assert.ok(err instanceof OpError);
      assert.match(err.message, /taxonomy weight for "dx"/);
      return true;
    }
  );

  fs.writeFileSync(path.join(ctx.dotdir, LAYOUT.charter), mutated);
  await assert.rejects(() => approve({ ...ctx, state: drafted.state }), /taxonomy weight for "dx"/);
});

test("frontier synthesis omitting a dimension is floor-corrected; extra dimensions survive", async () => {
  const script = {
    // invalid plan (<4 questions) → documented fallback to the static plan
    "charter-questions": JSON.stringify({ questions: [] }),
    "charter-synthesis": JSON.stringify({
      intent: "extend",
      weights: {
        correctness: 4,
        security: 5,
        maintainability: 3,
        performance: 2,
        operability: 3,
        "test-quality": 4,
        "dependency-health": 2,
        // dx omitted on purpose
      },
      extraDimensions: [{ id: "Compliance", label: "Compliance", weight: 4 }],
      pain: ["Auth module is a swamp"],
      constraints: [],
      rationale: { security: "stakeholder weighted security 5" },
    }),
  };
  const { llm, calls } = makeScriptedLLM(script);
  const { ctx } = await scannedCtx(TINY_REPO, { llm });
  const result = await withAnswers([...FULL_ANSWERS, "n"], () => run(ctx));

  // §6 tier discipline: D0 question synthesis + charter synthesis are frontier
  const byLabel = Object.fromEntries(calls.map((c) => [c.label, c.tier]));
  assert.equal(byLabel["charter-questions"], "frontier");
  assert.equal(byLabel["charter-synthesis"], "frontier");

  const raw = readCharterRaw(ctx);
  const charter = parseCharter(raw);
  assert.equal(charter.intent, "extend");
  assert.equal(charter.weights.dx, 1, "omitted dimension floor-corrected to 1");
  assert.equal(charter.weights.security, 5);
  assert.match(raw, /1 \(floor\)/);
  assert.match(raw, /taxonomy floor applied/);
  assert.deepEqual(charter.extraDimensions, [{ id: "compliance", label: "Compliance", weight: 4 }]);
  assert.deepEqual(charter.pain, ["Auth module is a swamp"]);
  assert.deepEqual(charter.constraints, []);

  // spend threaded into state
  assert.equal(result.state.phases.charter.spend.calls, 2);
  assert.ok(result.state.budget.spentUSD > 0);
});

test("codebase-check clause auto-answers decisive questions and skips asking them", async () => {
  const { ctx } = await scannedCtx(BARE_REPO);
  // 9 asked questions (pain, intent, constraints, 6 non-established weights) + approval
  const answers = ["Legacy mess", "extend it further", "None", "2", "3", "4", "2", "3", "2", "n"];
  await withAnswers(answers, () => run(ctx));

  const raw = readCharterRaw(ctx);
  const charter = parseCharter(raw);
  assert.equal(charter.intent, "extend");
  assert.deepEqual(charter.weights, {
    correctness: 2,
    security: 3,
    maintainability: 4,
    performance: 2,
    operability: 3,
    "test-quality": 5, // established: no test directories
    "dependency-health": 1, // established: no manifests
    dx: 2, // last consumed answer — proves auto-answered questions consumed nothing
  });
  assert.match(raw, /## Established from the codebase/);
  assert.match(raw, /no test directories/);
  assert.match(raw, /no dependency manifests/);
});

test("non-interactive run with neither TTY ask nor DOBETTER_ANSWERS fails fast", async () => {
  const { ctx } = await scannedCtx(TINY_REPO);
  const prev = process.env.DOBETTER_ANSWERS;
  delete process.env.DOBETTER_ANSWERS;
  try {
    await assert.rejects(
      () => run(ctx),
      (err) => {
        assert.ok(err instanceof OpError);
        assert.match(err.message, /DOBETTER_ANSWERS/);
        return true;
      }
    );
  } finally {
    if (prev !== undefined) process.env.DOBETTER_ANSWERS = prev;
  }
});

test("exhausted scripted answers accept the recommended answers (and decline approval)", async () => {
  const { ctx } = await scannedCtx(TINY_REPO);
  const result = await withAnswers(["My main pain is onboarding"], () => run(ctx));
  assert.equal(result.gate.passed, false); // empty approval answer → default N
  const charter = parseCharter(readCharterRaw(ctx));
  assert.equal(charter.intent, "stabilize"); // recommended default
  assert.deepEqual(charter.pain, ["My main pain is onboarding"]);
  assert.deepEqual(charter.constraints, []); // recommended "None" → no constraints
});

test("interactive ctx.ask path: empty input accepts recommendations question by question", async () => {
  const prev = process.env.DOBETTER_ANSWERS;
  delete process.env.DOBETTER_ANSWERS;
  try {
    const prompts = [];
    const ask = async (prompt) => {
      prompts.push(prompt);
      return "";
    };
    const { ctx } = await scannedCtx(TINY_REPO, { ask });
    const result = await run(ctx);
    assert.equal(result.gate.passed, false);
    assert.equal(prompts.length, 12, "11 static questions + approval prompt, one at a time");
    assert.match(prompts[0], /recommended/);
    assert.match(prompts.at(-1), /Approve charter now\? \[y\/N\]/);
    const charter = parseCharter(readCharterRaw(ctx));
    assert.equal(charter.intent, "stabilize");
    for (const dim of TAXONOMY) assert.ok(charter.weights[dim.id] >= 1);
  } finally {
    if (prev !== undefined) process.env.DOBETTER_ANSWERS = prev;
  }
});
