// test/identify-pool.test.js — T2 acceptance tests: charter-weighted pooled,
// lens-diverse D2 finders. No network ever (DOBETTER_FAKE_LLM seam). Covers
// AC1–AC7 from the T2 ticket. Sibling of test/identify.test.js — this file is
// NEW and owned by T2; it does not touch the frozen identify.test.js rails.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as identify from "../src/identify.js";
import * as utils from "../src/utils.js";
import * as stateMod from "../src/state.js";
import * as artifacts from "../src/artifacts.js";
import * as llmMod from "../src/llm.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REFUTE_DOC = fs.readFileSync(
  path.join(here, "..", "do-better", "references", "refute-charter.md"),
  "utf8",
);
const LENS_IDS = ["exploit-author", "oncall-3am", "new-hire-reader", "performance-profiler", "staff-skeptic"];

// --- inline fixtures (house style: helpers live in the test file) ------------
const quietLog = {
  info() {}, success() {}, warn() {}, error() {}, phase() {}, gate() {},
  step() {}, substep() {}, errorTrace() {},
};

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-pool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "tiny", version: "1.0.0", type: "module" }, null, 2) + "\n",
  );
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "util.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  fs.writeFileSync(path.join(root, "README.md"), "# tiny\n");
  sh(root, "git", ["init", "-q"]);
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  const headSha = sh(root, "git", ["rev-parse", "HEAD"]);
  return { root, dotdir: path.join(root, ".dobetter"), headSha };
}

function prepState({ headSha, weights }) {
  const now = new Date().toISOString();
  let s = stateMod.defaultState({ headSha, now });
  s = stateMod.recordPhase(s, "scan", { status: "done", sha: headSha, now });
  s = stateMod.setGate(s, "charter", { approved: true, approvedAt: now, charterSha256: "0".repeat(64) });
  s = stateMod.setGate(s, "comprehend", { passed: true, divergence: 0.1 });
  s = stateMod.recordPhase(s, "comprehend", { status: "done", sha: headSha, now });
  s._weights = weights;
  return s;
}

function writeComprehensionInputs(dotdir, headSha, weights) {
  artifacts.ensureLayout(dotdir);
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.charter, {
    meta: { approved: true, headSha, generatedAt: new Date().toISOString(), intent: "stabilize", weights },
    body: "# Charter\n\nPain: stability.\n",
  });
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.comprehension.coverageManifest, {
    meta: { headSha, generatedAt: new Date().toISOString(), deepPct: 100, scanPct: 0, skipPct: 0 },
    body: [
      "# Coverage Manifest", "",
      "## Deep-read files", "- src/util.js", "",
      "## Scanned files", "- (none)", "",
      "## Skipped files", "- (none)", "",
      "## Degradations", "- (none)",
    ].join("\n") + "\n",
  });
}

// Fake LLM that logs one JSON line {label, system} per call, and returns per
// label: finder:<dim> from `script[label]` (cycling, last repeats), verdict from
// `script.verdict`, everything else (repro-cmd) from a null default.
function writeFakeLLM(t, { script = {}, logFile }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-pool-fake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-llm.mjs");
  fs.writeFileSync(file, [
    'import fs from "node:fs";',
    `const script = ${JSON.stringify(script)};`,
    `const logFile = ${JSON.stringify(logFile)};`,
    "const counts = {};",
    "function asText(v) { return typeof v === 'string' ? v : JSON.stringify(v); }",
    "export default async function fake({ system, label, jsonMode }) {",
    "  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ label, system }) + '\\n');",
    "  const entry = script[label];",
    "  if (entry !== undefined) {",
    "    const list = Array.isArray(entry) ? entry : [entry];",
    "    const i = counts[label] ?? 0; counts[label] = i + 1;",
    "    return asText(list[Math.min(i, list.length - 1)]);",
    "  }",
    "  if (typeof label === 'string' && label.startsWith('finder:')) return JSON.stringify({ candidates: [] });",
    "  if (label === 'repro-cmd') return JSON.stringify({ reproCmd: null });",
    "  return jsonMode ? '{}' : '(fake output)';",
    "}",
  ].join("\n"));
  return file;
}

const ABSENT_ADLC = Object.freeze({ mode: "absent", dir: null, available: {} });

function makeCtx(t, { root, dotdir, state, n = null, script = {}, logFile = null }) {
  const flags = {
    command: "audit", target: root, provider: null, budget: null, offline: false,
    modelCheap: "claude-haiku-4-5", modelMid: "claude-sonnet-4-6", modelFrontier: "claude-opus-4-8",
    n, threshold: null, approve: false, yes: false, json: false, help: false,
  };
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; delete env.GEMINI_API_KEY;
  delete env.DOBETTER_FAKE_LLM;
  env.DOBETTER_FAKE_LLM = writeFakeLLM(t, { script, logFile });
  const llm = llmMod.createLLM({ flags, state, env });
  return {
    root, dotdir, state, llm, adlc: ABSENT_ADLC, flags, log: quietLog,
    now: () => new Date().toISOString(), exec: utils.makeExec(), ask: null,
  };
}

function newLogFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-pool-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "calls.jsonl");
}

function readCalls(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// A charter weighting exactly one dimension high; everything else weight 1.
function weightsWith(overrides) {
  const base = Object.fromEntries(utils.TAXONOMY.map((d) => [d.id, 1]));
  return { ...base, ...overrides };
}

const CAND = (title, line = 1) => ({
  title, claim: `${title} — claim body`, file: "src/util.js", line, severity: "medium", confidence: 0.6, method: "reread",
});

// ---------------------------------------------------------------------------
// AC3 — parseLenses unit: doc-driven when present; hardcoded fallback + warn
// when absent. Tested directly on the pure function.
// ---------------------------------------------------------------------------
test("AC3: parseLenses uses the doc's 5 lenses when the '## Lenses' section is present", () => {
  const warns = [];
  const { base, lenses } = identify.parseLenses(REFUTE_DOC, { warn: (m) => warns.push(m) });
  assert.equal(warns.length, 0, "well-formed doc must not warn");
  assert.equal(lenses.length, 5);
  assert.deepEqual(lenses.map((l) => l.id).sort(), [...LENS_IDS].sort());
  for (const l of lenses) {
    assert.equal(typeof l.text, "string");
    assert.ok(l.text.length > 0);
  }
  // base is everything above the heading — the finder base prompt — and must
  // NOT carry the lens catalog heading (the leakage boundary).
  assert.ok(!base.includes("## Lenses"), "base must not include the Lenses heading");
  assert.ok(base.includes("REFUTE"), "base retains the refutation charter");
  // Exact-prefix check: base must start with the doc's own first characters,
  // not a slice shifted by one — a doc.slice(0,...) vs slice(1,...) regression
  // would silently drop the leading character of every finder's system prompt.
  assert.equal(base.slice(0, 20), REFUTE_DOC.slice(0, 20), "base is not shifted from the doc's actual start");
});

test("AC3: parseLenses falls back to the hardcoded 5 lenses AND warns when the section is absent", () => {
  const docNoLenses = "# Refute Charter\n\nSome doctrine without a lenses section.\n";
  const warns = [];
  const { base, lenses } = identify.parseLenses(docNoLenses, { warn: (m) => warns.push(m) });
  assert.equal(lenses.length, 5, "hardcoded fallback supplies 5 lenses");
  assert.deepEqual(lenses.map((l) => l.id).sort(), [...LENS_IDS].sort());
  assert.equal(warns.length, 1, "fallback must degrade loudly via log.warn");
  assert.match(warns[0], /Lenses/);
  assert.equal(base, docNoLenses.replace(/\s+$/, ""), "fallback base is the whole doc (pre-T2 behavior)");
});

test("AC3: parseLenses falls back + warns when the section is present but malformed (not 5 known lenses)", () => {
  const doc = "# Charter\n\nDoctrine.\n\n## Lenses\n\n### only-one\n\nJust one lens, wrong id.\n";
  const warns = [];
  const { lenses } = identify.parseLenses(doc, { warn: (m) => warns.push(m) });
  assert.equal(lenses.length, 5, "malformed catalog → hardcoded fallback");
  assert.equal(warns.length, 1);
});

test("AC3: parseLenses falls back when a lens heading has no body text (empty entry must not count as a valid lens)", () => {
  // All 5 known ids appear as headings, but one has zero body before the next
  // heading — a candidate lens with an id but no text (or vice versa) must be
  // rejected, not silently admitted as a well-formed 5th entry.
  const doc = [
    "# Charter", "", "Doctrine.", "", "## Lenses", "",
    "### exploit-author", "", "### oncall-3am", "", "Real text for oncall-3am.", "",
    "### new-hire-reader", "", "Real text for new-hire-reader.", "",
    "### performance-profiler", "", "Real text for performance-profiler.", "",
    "### staff-skeptic", "", "Real text for staff-skeptic.", "",
  ].join("\n");
  const warns = [];
  const { lenses } = identify.parseLenses(doc, { warn: (m) => warns.push(m) });
  assert.equal(lenses.length, 5, "the empty-bodied heading is dropped, so the catalog is incomplete → hardcoded fallback");
  assert.equal(warns.length, 1, "must degrade loudly, not silently admit a degenerate lens");
});

test("AC3: parseLenses falls back when the section has MORE than 5 headings (all 5 known ids present plus an extra)", () => {
  // Distinguishes the AND from an OR in the well-formedness check: if every
  // known id is present but there are 6 total headings, the catalog is not
  // well-formed (count must match exactly), not merely "contains the known 5."
  const doc = [
    "# Charter", "", "Doctrine.", "", "## Lenses", "",
    "### exploit-author", "", "Text A.", "",
    "### oncall-3am", "", "Text B.", "",
    "### new-hire-reader", "", "Text C.", "",
    "### performance-profiler", "", "Text D.", "",
    "### staff-skeptic", "", "Text E.", "",
    "### bonus-lens", "", "An unexpected 6th lens.", "",
  ].join("\n");
  const warns = [];
  const { lenses } = identify.parseLenses(doc, { warn: (m) => warns.push(m) });
  assert.equal(lenses.length, 5, "an extra, unknown heading must trigger the hardcoded fallback, not a 6-entry catalog");
  assert.deepEqual(lenses.map((l) => l.id).sort(), [...LENS_IDS].sort());
  assert.equal(warns.length, 1);
});

// ---------------------------------------------------------------------------
// AC6 (unit) — charter-weighted width computation.
// ---------------------------------------------------------------------------
test("AC6: charterPoolWidth — weight 1 → 1; weight 4-5 → full n; weight 2-3 → max(1, floor(n/2))", () => {
  // weight 1: always a single finder, regardless of n
  for (const n of [1, 2, 3, 4, 8]) assert.equal(identify.charterPoolWidth(1, n), 1, `weight1,n=${n}`);
  // weight >= 4: full n
  assert.equal(identify.charterPoolWidth(4, 3), 3);
  assert.equal(identify.charterPoolWidth(5, 3), 3);
  assert.equal(identify.charterPoolWidth(5, 4), 4);
  // weight 2-3: half, floored, min 1
  assert.equal(identify.charterPoolWidth(3, 3), 1, "floor(3/2)=1");
  assert.equal(identify.charterPoolWidth(2, 4), 2);
  assert.equal(identify.charterPoolWidth(3, 4), 2);
  assert.equal(identify.charterPoolWidth(3, 1), 1, "n=1 → min(1,...) = 1");
  // --n unset (null) is treated as ceiling 1 by charterPoolMax; the width fn
  // itself clamps a non-integer n to 1.
  assert.equal(identify.charterPoolWidth(5, null), 1);
  // A non-integer n that is numerically >= 1 must still be rejected, not
  // treated as a valid ceiling — distinguishes the AND from an OR in the cap
  // computation's own integer-validity guard (this fn is exported and called
  // directly, independent of the CLI's own upstream --n validation).
  assert.equal(identify.charterPoolWidth(5, 2.5), 1, "non-integer n, even if >= 1, must clamp to the default ceiling");
});

// ---------------------------------------------------------------------------
// AC1 — With --n 3, each pass of a weight-5 dimension issues exactly 3 finder
// calls with 3 DISTINCT lens strings.
// ---------------------------------------------------------------------------
test("AC1: --n 3 → weight-5 dimension issues 3 finder calls per pass with 3 distinct lens strings", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const weights = weightsWith({ security: 5 });
  writeComprehensionInputs(dotdir, headSha, weights);
  const logFile = newLogFile(t);
  const ctx = makeCtx(t, { root, dotdir, state: prepState({ headSha, weights }), n: 3, logFile });

  const res = await identify.run(ctx);
  assert.equal(res.gate.passed, true);

  const secCalls = readCalls(logFile).filter((c) => c.label === "finder:security");
  const perPass = res.state.phases.identify.passesByDimension.security;
  assert.ok(perPass >= 1);
  assert.equal(secCalls.length, perPass * 3, "3 finder calls per pass at --n 3, weight 5");

  // First pass = first 3 calls; each must carry a distinct lens.
  const firstPass = secCalls.slice(0, 3).map((c) => c.system.split("\n\nLens: ")[1]);
  assert.ok(firstPass.every((s) => typeof s === "string" && s.length > 0), "each call has a Lens suffix");
  assert.equal(new Set(firstPass).size, 3, "3 distinct lens strings within one pass");
});

// ---------------------------------------------------------------------------
// AC7 — Leakage regression: a finder's system prompt contains ONLY its assigned
// lens — never the "## Lenses" heading, never any other lens's text.
// ---------------------------------------------------------------------------
test("AC7: no finder system prompt leaks the Lenses heading or any non-assigned lens text", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const weights = weightsWith({ security: 5 });
  writeComprehensionInputs(dotdir, headSha, weights);
  const logFile = newLogFile(t);
  const ctx = makeCtx(t, { root, dotdir, state: prepState({ headSha, weights }), n: 3, logFile });
  await identify.run(ctx);

  const { lenses } = identify.parseLenses(REFUTE_DOC, quietLog);
  const finderCalls = readCalls(logFile).filter((c) => c.label.startsWith("finder:"));
  assert.ok(finderCalls.length > 0);

  for (const call of finderCalls) {
    assert.ok(!call.system.includes("## Lenses"), "system must never contain the Lenses catalog heading");
    // Exactly one lens's full text is present; the other four are absent.
    const present = lenses.filter((l) => call.system.includes(l.text));
    assert.equal(present.length, 1, `exactly one lens per finder prompt, found ${present.length}`);
    for (const other of lenses) {
      if (other.id === present[0].id) continue;
      assert.ok(!call.system.includes(other.text), `must not leak lens "${other.id}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// AC2 — Dry streak across a pool: pass A yields {2 new, 0, 0} (2 pooled new) →
// not dry; passes B and C all-zero → dry at K=2.
// ---------------------------------------------------------------------------
test("AC2: pooled dry streak — 2 new in pass A (not dry), then two all-zero pools → dry at K=2", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const weights = weightsWith({ security: 5 });
  writeComprehensionInputs(dotdir, headSha, weights);
  // finder:security calls in order: [A,B], [], [], [] ... → pass A (calls 1-3):
  // 2 new; pass B (4-6): 0; pass C (7-9): 0.
  const script = {
    "finder:security": [{ candidates: [CAND("alpha", 1), CAND("beta", 2)] }, { candidates: [] }],
    verdict: { verdict: "CONFIRM", reason: "holds" },
  };
  const ctx = makeCtx(t, { root, dotdir, state: prepState({ headSha, weights }), n: 3, script });
  const res = await identify.run(ctx);

  assert.equal(res.gate.passed, true);
  assert.equal(res.state.phases.identify.passesByDimension.security, 3, "pass A + 2 dry passes = 3 passes (pooled)");
  assert.equal(res.state.phases.identify.verified, 2, "both pooled candidates verified");
  const findings = artifacts.readFindings(dotdir);
  assert.equal(findings.length, 2);
});

// ---------------------------------------------------------------------------
// AC4 — --n 1 reproduces pre-T2 single-finder call counts: exactly one finder
// call per pass, regardless of weight.
// ---------------------------------------------------------------------------
test("AC4: --n 1 issues exactly one finder call per pass (pre-T2 backward compatibility)", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const weights = weightsWith({ security: 5 }); // even the top-weighted dim stays single at --n 1
  writeComprehensionInputs(dotdir, headSha, weights);
  const logFile = newLogFile(t);
  const ctx = makeCtx(t, { root, dotdir, state: prepState({ headSha, weights }), n: 1, logFile });
  const res = await identify.run(ctx);
  assert.equal(res.gate.passed, true);

  const calls = readCalls(logFile);
  const passes = res.state.phases.identify.passesByDimension;
  for (const dim of utils.TAXONOMY) {
    const dimCalls = calls.filter((c) => c.label === `finder:${dim.id}`).length;
    assert.equal(dimCalls, passes[dim.id], `${dim.id}: one finder call per pass at --n 1`);
  }
});

// ---------------------------------------------------------------------------
// AC6 (integration) — actual per-pass call counts follow the weighted width.
// n=4: weight-1 → 1 call/pass, weight-3 → 2, weight-5 → 4.
// ---------------------------------------------------------------------------
test("AC6: at --n 4, per-pass finder call counts are 1 (w1), 2 (w3), 4 (w5)", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const weights = weightsWith({ security: 5, correctness: 3, performance: 1 });
  writeComprehensionInputs(dotdir, headSha, weights);
  const logFile = newLogFile(t);
  // Everything returns empty → every dimension dries in exactly K_DRY=2 passes,
  // so per-pass width = total calls / 2.
  const ctx = makeCtx(t, { root, dotdir, state: prepState({ headSha, weights }), n: 4, logFile });
  const res = await identify.run(ctx);
  assert.equal(res.gate.passed, true);

  const calls = readCalls(logFile);
  const passes = res.state.phases.identify.passesByDimension;
  const width = (id) => calls.filter((c) => c.label === `finder:${id}`).length / passes[id];
  assert.equal(passes.security, 2);
  assert.equal(width("security"), 4, "weight 5 → full n=4");
  assert.equal(width("correctness"), 2, "weight 3 → floor(4/2)=2");
  assert.equal(width("performance"), 1, "weight 1 → 1 (no pooling)");
});

// ---------------------------------------------------------------------------
// Lens-catalog clamp (adversarial review finding, T2 follow-up): pool width
// must never exceed the number of available lenses. Beyond that, pool member
// i and i+lenses.length receive the SAME lens (rotation wraps) and thus an
// IDENTICAL system prompt — a fully redundant, budget-wasting call.
// ---------------------------------------------------------------------------
test("lens-catalog clamp: --n 8 on a weight-5 dimension issues at most 5 calls per pass (the lens catalog size), never 8", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const weights = weightsWith({ security: 5 });
  writeComprehensionInputs(dotdir, headSha, weights);
  const logFile = newLogFile(t);
  const ctx = makeCtx(t, { root, dotdir, state: prepState({ headSha, weights }), n: 8, logFile });
  const res = await identify.run(ctx);
  assert.equal(res.gate.passed, true);

  const calls = readCalls(logFile).filter((c) => c.label === "finder:security");
  const passes = res.state.phases.identify.passesByDimension.security;
  assert.equal(calls.length / passes, 5, "pool width clamps to 5 (the lens catalog size), not the raw --n 8 ceiling");

  // No two calls WITHIN THE SAME PASS may share an identical system prompt —
  // that would mean two pool members got the same lens (rotation wrapped)
  // and issued a fully redundant call.
  const perPass = [];
  for (let i = 0; i < calls.length; i += 5) perPass.push(calls.slice(i, i + 5));
  for (const passCalls of perPass) {
    const systems = new Set(passCalls.map((c) => c.system));
    assert.equal(systems.size, passCalls.length, "every pooled call in one pass has a distinct system prompt (distinct lens)");
  }
});
