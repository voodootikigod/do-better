// test/identify-rails.test.js — ADLC P3 characterization rails for D2
// (identify) findings from `do-better/SKILL.md`'s "D2 — Identify (refute,
// then reproduce-or-kill)" section and the public contracts recorded in
// handoff.md §2/§5 (ctx shape, error classes, artifacts/state helpers,
// candidate shape). Authored fresh-context, WITHOUT reading src/identify.js's
// implementation — these rails pin observable boundary behavior (inputs via
// ctx + the DOBETTER_FAKE_LLM seam, outputs via thrown errors / the resolved
// run() value / files under .dobetter/findings) so a later restructure of the
// D2 loop's internals (T1-T4) can be checked against them.
//
// Non-pins (deliberately NOT asserted, per the T0 ticket): pass-count
// magnitudes beyond what SKILL.md/handoff.md explicitly promise (e.g.
// offline's "single pass"), the exact wording of GateError.detail or the
// summary string, and any LLM system/user prompt content. Only presence,
// shape, and invariants are pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as utils from "../src/utils.js";
import * as stateMod from "../src/state.js";
import * as artifacts from "../src/artifacts.js";
import * as llmMod from "../src/llm.js";
import * as identify from "../src/identify.js";

const { OpError, GateError, TAXONOMY } = utils;

// ---------------------------------------------------------------------------
// Fixture helpers (inline, house style per test/state.test.js /
// test/artifacts.test.js — no shared test utilities live in src/).
// ---------------------------------------------------------------------------

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A minimal, real git repo so citation verification (file exists, line in
// range) and headSha pinning have something genuine to check against.
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-rails-"));
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

// One dimension weighted above the rest so dimension processing order is
// deterministic (SKILL.md D2 step 1: "descending weight") without hardcoding
// the taxonomy list — it's read from utils.js's exported TAXONOMY.
const ALL_WEIGHTS = Object.fromEntries(TAXONOMY.map((d) => [d.id, d.id === "security" ? 5 : 1]));

// State with scan/charter/comprehend already satisfied — i.e. everything D2
// needs upstream except identify itself. Used by every test except the
// "missing comprehend gate" rail, which needs the opposite.
function comprehendPassedState({ headSha, now }) {
  let s = stateMod.defaultState({ headSha, now });
  s = stateMod.recordPhase(s, "scan", { status: "done", sha: headSha, now });
  s = stateMod.setGate(s, "charter", { approved: true, approvedAt: now, charterSha256: "0".repeat(64) });
  s = stateMod.setGate(s, "comprehend", { passed: true, divergence: 0.1 });
  s = stateMod.recordPhase(s, "comprehend", { status: "done", sha: headSha, now });
  return s;
}

// Writes the D1 comprehension artifacts D2 reads (documented LAYOUT keys
// from artifacts.js — charter + coverage manifest).
function writeComprehensionInputs(dotdir, headSha, now) {
  artifacts.ensureLayout(dotdir);
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.charter, {
    meta: { approved: true, headSha, generatedAt: now, intent: "stabilize", weights: ALL_WEIGHTS },
    body: "# Charter\n\nPain: stability.\n",
  });
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.comprehension.coverageManifest, {
    meta: { headSha, generatedAt: now, deepPct: 100, scanPct: 0, skipPct: 0 },
    body: [
      "# Coverage Manifest",
      "",
      "## Deep-read files",
      "- src/util.js",
      "",
      "## Scanned files",
      "- (none)",
      "",
      "## Skipped files",
      "- (none)",
      "",
      "## Degradations",
      "- (none)",
    ].join("\n") + "\n",
  });
}

const quietLog = {
  info() {},
  success() {},
  warn() {},
  error() {},
  phase() {},
  gate() {},
  step() {},
  substep() {},
  errorTrace() {},
};

const ABSENT_ADLC = Object.freeze({
  mode: "absent",
  dir: null,
  probedAt: null,
  available: {
    parallax: false,
    coldstart: false,
    "hollow-test": false,
    "behavior-diff": false,
    preflight: false,
    "skill-mining": false,
  },
});

// DOBETTER_FAKE_LLM module writer. `finder`/`verdict` are single responses or
// arrays (cycling; the last entry repeats once exhausted — same convention as
// the project's own fake-LLM seam). Every other label (e.g. the repro-cmd
// proposal call) gets `fallback`, defaulting to "no mechanical repro
// proposed" so JSON-mode calls always get parseable JSON.
function writeFakeLLM(t, { finder = { candidates: [] }, verdict = { verdict: "KILL" }, fallback = { reproCmd: null } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-rails-fake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-llm.mjs");
  const finderList = Array.isArray(finder) ? finder : [finder];
  const verdictList = Array.isArray(verdict) ? verdict : [verdict];
  fs.writeFileSync(
    file,
    [
      `const finderList = ${JSON.stringify(finderList)};`,
      `const verdictList = ${JSON.stringify(verdictList)};`,
      `const fallback = ${JSON.stringify(fallback)};`,
      "let finderN = 0, verdictN = 0;",
      "function asText(v) { return typeof v === 'string' ? v : JSON.stringify(v); }",
      "export default async function fake({ label, jsonMode }) {",
      "  if (typeof label === 'string' && label.includes('finder')) {",
      "    const v = finderList[Math.min(finderN, finderList.length - 1)]; finderN++;",
      "    return asText(v);",
      "  }",
      "  if (typeof label === 'string' && label.includes('verdict')) {",
      "    const v = verdictList[Math.min(verdictN, verdictList.length - 1)]; verdictN++;",
      "    return asText(v);",
      "  }",
      "  if (fallback !== null) return asText(fallback);",
      "  return jsonMode ? '{}' : '(fake output)';",
      "}",
    ].join("\n"),
  );
  return file;
}

// A finder fixture that never runs dry: every call returns one freshly
// distinct claim (own module-local counter), regardless of which dimension
// the pass belongs to. Used to force the "not dry within MAX_PASSES" gate
// failure without needing to know how identify.js labels per-dimension calls.
function writeAlwaysNewFinderLLM(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-rails-fake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-llm.mjs");
  fs.writeFileSync(
    file,
    [
      "let n = 0;",
      "export default async function fake({ label, jsonMode }) {",
      "  if (typeof label === 'string' && label.includes('finder')) {",
      "    n++;",
      "    return JSON.stringify({ candidates: [{",
      "      dimension: 'security', title: 'novel-' + n, claim: 'distinct claim number ' + n,",
      "      file: 'src/util.js', line: 1, severity: 'low', confidence: 0.5, method: 'reread',",
      "    }] });",
      "  }",
      "  if (typeof label === 'string' && label.includes('verdict')) return JSON.stringify({ verdict: 'KILL' });",
      "  return jsonMode ? '{\"reproCmd\": null}' : '(fake output)';",
      "}",
    ].join("\n"),
  );
  return file;
}

function makeCtx({ root, dotdir, state, fakeLLMFile = null, offline = false }) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.DOBETTER_FAKE_LLM;
  if (!offline && fakeLLMFile) env.DOBETTER_FAKE_LLM = fakeLLMFile;
  const flags = {
    command: "audit",
    target: root,
    provider: null,
    budget: null,
    offline,
    modelCheap: "claude-haiku-4-5",
    modelMid: "claude-sonnet-4-6",
    modelFrontier: "claude-opus-4-8",
    n: null,
    threshold: null,
    approve: false,
    yes: false,
    json: false,
    help: false,
  };
  const llm = llmMod.createLLM({ flags, state, env });
  return {
    root,
    dotdir,
    state,
    llm,
    adlc: ABSENT_ADLC,
    flags,
    log: quietLog,
    now: () => new Date().toISOString(),
    exec: utils.makeExec(),
    ask: null,
  };
}

// ---------------------------------------------------------------------------
// Pin 1 — run(ctx) without a passed comprehend gate throws OpError (exit 1).
// SKILL.md: D2 follows D1's comprehend gate; handoff.md §2: operational
// failure = OpError (exit 1), distinct from D2's own deterministic GateError.
// ---------------------------------------------------------------------------

test("identify.run(ctx) throws OpError (exitCode 1) when the comprehend gate has not passed", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  // Isolate the ONE precondition under test: every OTHER D1/D0 prerequisite
  // (charter artifact on disk, scan/charter phases recorded) is satisfied so
  // the comprehend-gate check is the only thing that can fire. Without this,
  // gates.comprehend.passed being false and no charter.md on disk are BOTH
  // true, and a mutation spot-check confirmed the assertion below cannot
  // distinguish "comprehend gate check fired" from "charter-missing check
  // fired next" — both produce an indistinguishable OpError/exitCode:1 under
  // the non-pin rule (no exact message assertion allowed). Writing the
  // charter artifact closes that gap.
  writeComprehensionInputs(dotdir, headSha, now);
  let state = stateMod.defaultState({ headSha, now });
  state = stateMod.recordPhase(state, "scan", { status: "done", sha: headSha, now });
  state = stateMod.setGate(state, "charter", { approved: true, approvedAt: now, charterSha256: "0".repeat(64) });
  // gates.comprehend.passed is left false by construction — the one
  // condition this test exists to pin.
  const fakeFile = writeFakeLLM(t, {});
  const ctx = makeCtx({ root, dotdir, state, fakeLLMFile: fakeFile });

  await assert.rejects(
    () => identify.run(ctx),
    (err) => {
      assert.ok(err instanceof OpError, `expected OpError, got ${err && err.constructor && err.constructor.name}`);
      assert.equal(err.exitCode, 1);
      assert.ok(!(err instanceof GateError));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Pin 2 — Gate pass requires all dimensions dry AND zero unverified written;
// gate fail throws GateError with .gate === "identify", .state attached,
// exit 2. verification.md "The gate": both conditions; SKILL.md D2 step 2:
// "a dimension not dry within 8 passes fails the gate."
// ---------------------------------------------------------------------------

test("identify gate: a dimension that never goes dry throws GateError(.gate='identify', .state, exitCode 2)", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  let state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);
  const fakeFile = writeAlwaysNewFinderLLM(t);
  const ctx = makeCtx({ root, dotdir, state, fakeLLMFile: fakeFile });

  await assert.rejects(
    () => identify.run(ctx),
    (err) => {
      assert.ok(err instanceof GateError, `expected GateError, got ${err && err.constructor && err.constructor.name}`);
      assert.equal(err.exitCode, 2);
      assert.equal(err.gate, "identify");
      assert.ok(err.state && typeof err.state === "object", ".state must be attached to the GateError");
      assert.equal(err.state.gates.identify.passed, false);
      // Zero unverified findings written is an invariant of the gate check
      // itself (writeFinding refuses non-"verified" status) — true even on
      // the failing path, asserted per verification.md's "true by
      // construction, asserted anyway."
      assert.equal(err.state.gates.identify.unverified, 0);
      // The dimension that never went dry recorded a positive dry-pass count
      // (shape/invariant only — never the exact magnitude, per the T0
      // non-pins).
      const dry = err.state.gates.identify.dryPassesByDimension;
      assert.ok(dry && typeof dry === "object");
      const values = Object.values(dry);
      assert.ok(values.length > 0);
      assert.ok(values.every((v) => Number.isInteger(v) && v >= 1));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Pin 3 — Verified findings are written via writeFinding with
// status: "verified", evidence [{file, line, sha}], and a reproduction
// record; killed candidates are never written.
// verification.md: "There is no third bucket: unverified findings never
// reach output" / "Killed candidates are counted ... but never written."
// ---------------------------------------------------------------------------

test("a CONFIRMed candidate is written as a verified finding; a KILLed sibling candidate is never written", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  let state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);

  const confirmedCandidate = {
    dimension: "security",
    title: "confirmed-finding",
    claim: "this claim gets confirmed",
    file: "src/util.js",
    line: 1,
    severity: "medium",
    confidence: 0.6,
    method: "reread",
  };
  const killedCandidate = {
    dimension: "security",
    title: "killed-finding",
    claim: "this claim gets killed",
    file: "src/util.js",
    line: 1,
    severity: "medium",
    confidence: 0.6,
    method: "reread",
  };
  const fakeFile = writeFakeLLM(t, {
    finder: [{ candidates: [confirmedCandidate, killedCandidate] }, { candidates: [] }],
    verdict: [{ verdict: "CONFIRM", reason: "checked" }, { verdict: "KILL" }],
  });
  const ctx = makeCtx({ root, dotdir, state, fakeLLMFile: fakeFile });

  const result = await identify.run(ctx);
  assert.equal(result.gate.passed, true);
  assert.equal(result.state.gates.identify.unverified, 0);

  const findings = artifacts.readFindings(dotdir);
  assert.equal(findings.length, 1, "exactly one finding should be written (the confirmed one)");

  const [finding] = findings;
  assert.equal(finding.status, "verified");
  assert.equal(finding.title, "confirmed-finding");

  assert.ok(Array.isArray(finding.evidence) && finding.evidence.length >= 1);
  const [ev] = finding.evidence;
  assert.equal(typeof ev.file, "string");
  assert.ok(ev.file.length > 0);
  assert.ok(Number.isInteger(ev.line) && ev.line >= 1);
  assert.ok(/^[0-9a-f]{7,40}$/i.test(ev.sha), `sha should look like a git sha, got ${JSON.stringify(ev.sha)}`);

  assert.ok(finding.reproduction && typeof finding.reproduction === "object");
  assert.ok(
    ["command", "reread", "static"].includes(finding.reproduction.method),
    `reproduction.method should be one of the documented enum, got ${JSON.stringify(finding.reproduction.method)}`,
  );
  assert.equal(typeof finding.reproduction.record, "string");
  assert.ok(finding.reproduction.record.length > 0);

  // The killed candidate never produced a finding file.
  assert.ok(!findings.some((f) => f.title === "killed-finding"));
});

// ---------------------------------------------------------------------------
// Pin 4 — Re-run seeds dedupe from readFindings: no duplicate finding files
// or IDs (D6 idempotency).
// ---------------------------------------------------------------------------

test("re-running identify with the same claim does not create a duplicate finding file or id", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  const state1 = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);

  const sameCandidate = () => ({
    dimension: "security",
    title: "repeat-finding",
    claim: "a claim that will be proposed twice, verbatim",
    file: "src/util.js",
    line: 1,
    severity: "medium",
    confidence: 0.6,
    method: "reread",
  });

  const fakeFile1 = writeFakeLLM(t, {
    finder: [{ candidates: [sameCandidate()] }, { candidates: [] }],
    verdict: { verdict: "CONFIRM", reason: "checked" },
  });
  const ctx1 = makeCtx({ root, dotdir, state: state1, fakeLLMFile: fakeFile1 });
  const result1 = await identify.run(ctx1);
  assert.equal(result1.gate.passed, true);

  const findingsAfterRun1 = artifacts.readFindings(dotdir);
  assert.equal(findingsAfterRun1.length, 1);
  const idAfterRun1 = findingsAfterRun1[0].id;
  const filesAfterRun1 = fs.readdirSync(path.join(dotdir, artifacts.LAYOUT.findingsDir));
  assert.equal(filesAfterRun1.length, 1);

  // Second run: state continuity from run 1's own returned state (the only
  // documented way to chain runs — run() returns a new state rather than
  // mutating ctx.state), same dotdir/findings on disk, and the finder
  // proposes the exact same claim again as if it had never seen it.
  const fakeFile2 = writeFakeLLM(t, {
    finder: [{ candidates: [sameCandidate()] }, { candidates: [] }],
    verdict: { verdict: "CONFIRM", reason: "checked" },
  });
  const ctx2 = makeCtx({ root, dotdir, state: result1.state, fakeLLMFile: fakeFile2 });
  const result2 = await identify.run(ctx2);
  assert.equal(result2.gate.passed, true);

  const findingsAfterRun2 = artifacts.readFindings(dotdir);
  assert.equal(findingsAfterRun2.length, 1, "no duplicate finding should be created on re-run");
  assert.equal(findingsAfterRun2[0].id, idAfterRun1, "the finding id must be stable across the idempotent re-run");
  const filesAfterRun2 = fs.readdirSync(path.join(dotdir, artifacts.LAYOUT.findingsDir));
  assert.equal(filesAfterRun2.length, 1, "no duplicate finding *file* should be created on re-run");
});

// ---------------------------------------------------------------------------
// Pin 5 — Offline mode: deterministic static pass per dimension, single
// pass, declared degradation in the summary string.
// verification.md: "Offline mode: only candidates whose reproduction is a
// deterministic native check survive"; SKILL.md's degrade-loudly doctrine:
// "a degradation that doesn't announce itself is a lie about coverage."
// ---------------------------------------------------------------------------

test("offline mode runs exactly one static pass per dimension and declares the degradation in the summary", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  const state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);
  const ctx = makeCtx({ root, dotdir, state, offline: true });

  const result = await identify.run(ctx);
  assert.equal(result.gate.passed, true);

  const passes = result.state.phases.identify.passesByDimension;
  assert.ok(passes && typeof passes === "object");
  for (const dim of TAXONOMY) {
    assert.equal(passes[dim.id], 1, `dimension "${dim.id}" should run exactly one offline pass`);
  }

  assert.equal(typeof result.summary, "string");
  assert.match(result.summary, /offline/i, "the summary must declare the offline degradation, never silently");
});

// ---------------------------------------------------------------------------
// Pin 6 — Candidate validation drops unsafe paths / bad severities silently
// (fail closed): the run completes cleanly, nothing invalid is written.
// ---------------------------------------------------------------------------

test("candidates with an unsafe path or an invalid severity are dropped, not written, and do not fail the run", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  const state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);

  const unsafePathCandidate = {
    dimension: "security",
    title: "path-traversal-candidate",
    claim: "escapes the repo root",
    file: "../../etc/passwd",
    line: 1,
    severity: "medium",
    confidence: 0.5,
    method: "reread",
  };
  const badSeverityCandidate = {
    dimension: "security",
    title: "bad-severity-candidate",
    claim: "severity is not in the documented enum",
    file: "src/util.js",
    line: 1,
    severity: "apocalyptic",
    confidence: 0.5,
    method: "reread",
  };
  const fakeFile = writeFakeLLM(t, {
    finder: [{ candidates: [unsafePathCandidate, badSeverityCandidate] }, { candidates: [] }],
    verdict: { verdict: "CONFIRM", reason: "would confirm if it ever got this far" },
  });
  const ctx = makeCtx({ root, dotdir, state, fakeLLMFile: fakeFile });

  const result = await identify.run(ctx);
  assert.equal(result.gate.passed, true, "fail-closed validation must not fail the run/gate");

  const findings = artifacts.readFindings(dotdir);
  assert.equal(findings.length, 0, "neither invalid candidate should ever be written as a finding");
  assert.ok(!findings.some((f) => f.title === "path-traversal-candidate"));
  assert.ok(!findings.some((f) => f.title === "bad-severity-candidate"));
});

// ---------------------------------------------------------------------------
// Pin 7 — State shape: phases.identify.{passesByDimension, killed, verified}
// and gates.identify.{passed, dryPassesByDimension, unverified} keys exist.
// (T1 may ADD keys; these must remain — no exhaustive key-set assertion.)
// ---------------------------------------------------------------------------

test("state shape: phases.identify and gates.identify carry the pinned keys in defaultState()", () => {
  const s = stateMod.defaultState({ headSha: "a".repeat(40), now: "2026-01-01T00:00:00.000Z" });

  assert.ok(Object.prototype.hasOwnProperty.call(s.phases.identify, "passesByDimension"));
  assert.ok(Object.prototype.hasOwnProperty.call(s.phases.identify, "killed"));
  assert.ok(Object.prototype.hasOwnProperty.call(s.phases.identify, "verified"));
  assert.equal(typeof s.phases.identify.passesByDimension, "object");
  assert.equal(typeof s.phases.identify.killed, "number");
  assert.equal(typeof s.phases.identify.verified, "number");

  assert.ok(Object.prototype.hasOwnProperty.call(s.gates.identify, "passed"));
  assert.ok(Object.prototype.hasOwnProperty.call(s.gates.identify, "dryPassesByDimension"));
  assert.ok(Object.prototype.hasOwnProperty.call(s.gates.identify, "unverified"));
  assert.equal(typeof s.gates.identify.passed, "boolean");
  assert.equal(typeof s.gates.identify.dryPassesByDimension, "object");
  assert.equal(typeof s.gates.identify.unverified, "number");
});

test("state shape: the pinned keys are still present and correctly typed on identify.run(ctx)'s resolved state", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  const state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);
  // Offline mode: cheapest possible way to get a real, completed run() result.
  const ctx = makeCtx({ root, dotdir, state, offline: true });

  const result = await identify.run(ctx);

  assert.ok(Object.prototype.hasOwnProperty.call(result.state.phases.identify, "passesByDimension"));
  assert.ok(Object.prototype.hasOwnProperty.call(result.state.phases.identify, "killed"));
  assert.ok(Object.prototype.hasOwnProperty.call(result.state.phases.identify, "verified"));
  assert.equal(typeof result.state.phases.identify.passesByDimension, "object");
  assert.equal(typeof result.state.phases.identify.killed, "number");
  assert.equal(typeof result.state.phases.identify.verified, "number");

  assert.ok(Object.prototype.hasOwnProperty.call(result.state.gates.identify, "passed"));
  assert.ok(Object.prototype.hasOwnProperty.call(result.state.gates.identify, "dryPassesByDimension"));
  assert.ok(Object.prototype.hasOwnProperty.call(result.state.gates.identify, "unverified"));
  assert.equal(typeof result.state.gates.identify.passed, "boolean");
  assert.equal(typeof result.state.gates.identify.dryPassesByDimension, "object");
  assert.equal(typeof result.state.gates.identify.unverified, "number");
});
