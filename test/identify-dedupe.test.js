// test/identify-dedupe.test.js — T3 semantic dedupe layer (D2 identify).
//
// A cheap-tier semantic-equivalence check layered OVER the existing free hash
// filter (dedupeKey). Only candidates that survive the hash filter reach it,
// and only online. It compares each survivor against prior ADMITTED entries
// (this run's admitted candidates + prior VERIFIED findings) sharing the SAME
// dimension AND SAME file, and suppresses paraphrases the hash filter cannot
// catch. It FAILS OPEN: any unparseable/erroring/out-of-range response admits
// the candidate (a false-new costs one wasted verification call; a
// false-duplicate permanently loses a finding).
//
// No network ever: the DOBETTER_FAKE_LLM seam scripts every call. House style
// follows test/identify.test.js (inline helpers, synthesized git repo).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as identify from "../src/identify.js";
import * as utils from "../src/utils.js";
import * as stateMod from "../src/state.js";
import * as artifacts from "../src/artifacts.js";
import * as llmMod from "../src/llm.js";

const { TAXONOMY } = utils;

// One dimension weighted above the rest so security is processed first and
// deterministically (SKILL.md D2 step 1: descending weight).
const ALL_WEIGHTS = Object.fromEntries(TAXONOMY.map((d) => [d.id, d.id === "security" ? 5 : 1]));

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// A minimal real git repo with two small deep-read files (both fit one packet,
// so security is a single (dimension × packet) cell). Citation verification and
// head-sha pinning have something genuine to check.
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-dedupe-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "tiny", version: "1.0.0", type: "module" }, null, 2) + "\n",
  );
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "util.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  fs.writeFileSync(path.join(root, "src", "other.js"), "export function mul(a, b) {\n  return a * b;\n}\n");
  fs.writeFileSync(path.join(root, "README.md"), "# tiny\n");
  sh(root, "git", ["init", "-q"]);
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  const headSha = sh(root, "git", ["rev-parse", "HEAD"]);
  return { root, dotdir: path.join(root, ".dobetter"), headSha, head7: headSha.slice(0, 7) };
}

function comprehendPassedState({ headSha, now }) {
  let s = stateMod.defaultState({ headSha, now });
  s = stateMod.recordPhase(s, "scan", { status: "done", sha: headSha, now });
  s = stateMod.setGate(s, "charter", { approved: true, approvedAt: now, charterSha256: "0".repeat(64) });
  s = stateMod.setGate(s, "comprehend", { passed: true, divergence: 0.1 });
  s = stateMod.recordPhase(s, "comprehend", { status: "done", sha: headSha, now });
  return s;
}

function writeComprehensionInputs(dotdir, headSha, now) {
  artifacts.ensureLayout(dotdir);
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.charter, {
    meta: { approved: true, headSha, generatedAt: now, intent: "stabilize", weights: ALL_WEIGHTS },
    body: "# Charter\n\nPain: stability.\n",
  });
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.comprehension.coverageManifest, {
    meta: { headSha, generatedAt: now, deepPct: 100, scanPct: 0, skipPct: 0 },
    body: [
      "# Coverage Manifest", "",
      "## Deep-read files", "- src/util.js", "- src/other.js", "",
      "## Scanned files", "- (none)", "",
      "## Skipped files", "- (none)", "",
      "## Degradations", "- (none)",
    ].join("\n") + "\n",
  });
}

// DOBETTER_FAKE_LLM writer. `script` maps label → response (a value, or an
// array cycled with last-entry-repeat). String values are returned verbatim
// (used to script unparseable JSON). Unknown labels get sensible category
// defaults so unrelated dimensions/verifications never block a run. When
// `logFile` is set, every call is appended as a JSON line {label, tier, prompt}.
function writeFakeLLM(t, { script = {}, logFile = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-dedupe-fake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-llm.mjs");
  fs.writeFileSync(file, [
    'import fs from "node:fs";',
    `const script = ${JSON.stringify(script)};`,
    `const logFile = ${JSON.stringify(logFile)};`,
    "const counts = {};",
    "function pick(entry, label) {",
    "  const list = Array.isArray(entry) ? entry : [entry];",
    "  const i = counts[label] ?? 0; counts[label] = i + 1;",
    "  return list[Math.min(i, list.length - 1)];",
    "}",
    "export default async function fake({ prompt, system, tier, label, jsonMode }) {",
    "  if (logFile) fs.appendFileSync(logFile, JSON.stringify({ label, tier, prompt }) + '\\n');",
    "  let entry = Object.prototype.hasOwnProperty.call(script, label) ? script[label] : undefined;",
    "  if (entry === undefined) {",
    "    if (typeof label === 'string' && label.startsWith('finder')) entry = { candidates: [] };",
    "    else if (typeof label === 'string' && label.startsWith('dedupe')) entry = { duplicateOf: null };",
    "    else if (label === 'verdict') entry = { verdict: 'CONFIRM', reason: 'ok' };",
    "    else if (label === 'repro-cmd') entry = { reproCmd: null };",
    "    else entry = jsonMode ? {} : '(fake output)';",
    "  }",
    "  const v = pick(entry, label);",
    "  return typeof v === 'string' ? v : JSON.stringify(v);",
    "}",
  ].join("\n"));
  return file;
}

function makeCtx({ root, dotdir, state, fakeLLMFile = null, offline = false, warnings = null }) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.DOBETTER_FAKE_LLM;
  if (!offline && fakeLLMFile) env.DOBETTER_FAKE_LLM = fakeLLMFile;
  const flags = {
    command: "audit", target: root, provider: null, budget: null, offline,
    modelCheap: "claude-haiku-4-5", modelMid: "claude-sonnet-4-6", modelFrontier: "claude-opus-4-8",
    n: null, threshold: null, approve: false, yes: false, json: false, help: false,
  };
  const log = {
    info() {}, success() {}, error() {}, phase() {}, gate() {},
    step() {}, substep() {}, errorTrace() {},
    warn(msg) { if (warnings) warnings.push(String(msg)); },
  };
  const llm = llmMod.createLLM({ flags, state, env });
  return {
    root, dotdir, state, llm,
    adlc: Object.freeze({ mode: "absent", dir: null, available: {} }),
    flags, log, now: () => new Date().toISOString(), exec: utils.makeExec(), ask: null,
  };
}

function readCalls(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function newLogFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-dedupe-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "calls.jsonl");
}

// A validated candidate the finder proposes. The semantic filter runs after
// validateCandidate + the hash filter, so these must be well-formed.
function cand({ title, claim, file = "src/util.js", line = 1, severity = "medium" }) {
  return { title, claim, file, line, severity, confidence: 0.6 };
}

// ---------------------------------------------------------------------------
// AC1 — a different-wording restatement of an already-admitted candidate
// (same dimension+file) is suppressed by the semantic filter; the dry streak
// still advances normally; no second finding is written on a re-run.
// ---------------------------------------------------------------------------
test("AC1: a same-dimension+file paraphrase is suppressed; dry streak advances; re-run writes no duplicate", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  const state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);

  const original = cand({ title: "unvalidated add inputs", claim: "the add function never validates its numeric inputs before use" });
  const paraphrase = cand({ title: "add lacks argument checks", claim: "arguments passed to add are used without any validation step" });

  const fake1 = writeFakeLLM(t, {
    script: {
      "finder:security": [
        { candidates: [original] },   // pass 1: novel → admitted (no prior → no dedupe call)
        { candidates: [paraphrase] }, // pass 2: paraphrase → hash-survivor → semantic dup → suppressed
        { candidates: [] },           // pass 3: dry
      ],
      "dedupe:security": { duplicateOf: 0 }, // the paraphrase duplicates prior entry 0
    },
  });
  const result1 = await identify.run(makeCtx({ root, dotdir, state, fakeLLMFile: fake1 }));
  assert.equal(result1.gate.passed, true);

  // The paraphrase did NOT reset/advance the streak as "new": pass1 (1 new),
  // pass2 (0 new → streak 1), pass3 (0 new → streak 2 → dry) = exactly 3 passes.
  // Had the paraphrase been (wrongly) admitted, a 4th empty pass would be needed.
  assert.equal(result1.state.phases.identify.passesByDimension.security, 3,
    "dry streak must advance across the suppressed paraphrase (3 passes, not 4)");

  const findings1 = artifacts.readFindings(dotdir);
  assert.equal(findings1.length, 1, "only the original is admitted and verified");
  assert.equal(findings1[0].title, "unvalidated add inputs");
  const id1 = findings1[0].id;

  // Suppression is declared, never silent (adversarial review finding): the
  // paraphrase's loss must be visible in both the phase summary and the D2
  // coverage manifest, not just absent from findings/.
  // Anchored to security's own semicolon-delimited segment ([^;]*) so this
  // cannot leak into a later dimension's "1 suppressed" text — every OTHER
  // dimension legitimately shows 0 suppressed here, and an unanchored ".*"
  // would match across the boundary and pass even if security's own count
  // were wrong (verified empirically: a mutated suppressed-counter default
  // of 1 instead of 0 makes every zero-suppression dimension ALSO read
  // "1 suppressed", and an unanchored regex can't tell them apart).
  assert.match(result1.summary, /security: \d+ verified \/ \d+ killed \/ 1 suppressed\b[^;]*/, "the phase summary reports the suppression count for security specifically");
  assert.doesNotMatch(result1.summary, /security: \d+ verified \/ \d+ killed \/ [02-9]\d* suppressed/, "security's suppression count is exactly 1, not 0 or 2+");
  const manifest = fs.readFileSync(path.join(dotdir, artifacts.LAYOUT.comprehension.coverageManifest), "utf8");
  assert.match(manifest, /### security[\s\S]*?Semantic suppressions: 1/, "the coverage manifest records the suppression under security's section");

  // Re-run: the paraphrase is proposed against the now-VERIFIED prior finding
  // (seeded via readFindings). It must be caught semantically too — no second
  // finding, stable id.
  const fake2 = writeFakeLLM(t, {
    script: {
      "finder:security": [{ candidates: [paraphrase] }, { candidates: [] }],
      "dedupe:security": { duplicateOf: 0 },
    },
  });
  const result2 = await identify.run(makeCtx({ root, dotdir, state: result1.state, fakeLLMFile: fake2 }));
  assert.equal(result2.gate.passed, true);

  const findings2 = artifacts.readFindings(dotdir);
  assert.equal(findings2.length, 1, "the paraphrase must not create a second finding on re-run");
  assert.equal(findings2[0].id, id1, "the finding id is stable across the semantic-dedupe re-run");
  assert.equal(result2.state.phases.identify.verified, 0, "nothing new verified on the paraphrase re-run");
});

// ---------------------------------------------------------------------------
// AC2 — a genuinely distinct claim in the same dimension+file (semantic check
// returns duplicateOf:null) is admitted normally.
// ---------------------------------------------------------------------------
test("AC2: a distinct claim in the same dimension+file (duplicateOf:null) is admitted", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  const state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);

  const first = cand({ title: "unvalidated add inputs", claim: "the add function never validates its numeric inputs" });
  const distinct = cand({ title: "no overflow guard", claim: "add can silently overflow for large integers" });

  const fake = writeFakeLLM(t, {
    script: {
      "finder:security": [
        { candidates: [first] },    // admitted (no prior)
        { candidates: [distinct] }, // hash-survivor; dedupe returns null → admitted
        { candidates: [] },
      ],
      "dedupe:security": { duplicateOf: null },
    },
  });
  const result = await identify.run(makeCtx({ root, dotdir, state, fakeLLMFile: fake }));
  assert.equal(result.gate.passed, true);

  const findings = artifacts.readFindings(dotdir);
  assert.equal(findings.length, 2, "the distinct claim is admitted alongside the first");
  const titles = findings.map((f) => f.title).sort();
  assert.deepEqual(titles, ["no overflow guard", "unvalidated add inputs"]);
});

// ---------------------------------------------------------------------------
// AC3 — semantic-check failure (unparseable JSON, or out-of-range index) fails
// OPEN: the candidate is admitted and ctx.log.warn is called.
// ---------------------------------------------------------------------------
test("AC3a: unparseable semantic response fails open (candidate admitted, warn logged)", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  const state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);
  const warnings = [];

  const first = cand({ title: "first security issue", claim: "the first genuine security problem" });
  const second = cand({ title: "second security issue", claim: "a genuinely different second problem" });

  const fake = writeFakeLLM(t, {
    script: {
      "finder:security": [{ candidates: [first] }, { candidates: [second] }, { candidates: [] }],
      "dedupe:security": "this is not valid json at all", // unparseable → callJson throws after retry
    },
  });
  const result = await identify.run(makeCtx({ root, dotdir, state, fakeLLMFile: fake, warnings }));
  assert.equal(result.gate.passed, true);

  const findings = artifacts.readFindings(dotdir);
  assert.equal(findings.length, 2, "fail-open admits the second candidate despite the broken check");
  assert.ok(warnings.some((w) => /fail open/i.test(w) && /dedup/i.test(w)),
    `a fail-open dedupe warning must be logged; got: ${JSON.stringify(warnings)}`);
});

test("AC3b: an out-of-range duplicateOf index fails open (candidate admitted, warn logged)", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  const state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);
  const warnings = [];

  const first = cand({ title: "first security issue", claim: "the first genuine security problem" });
  const second = cand({ title: "second security issue", claim: "a genuinely different second problem" });

  const fake = writeFakeLLM(t, {
    script: {
      "finder:security": [{ candidates: [first] }, { candidates: [second] }, { candidates: [] }],
      "dedupe:security": { duplicateOf: 99 }, // valid JSON, but 99 is not an index into the 1-entry list
    },
  });
  const result = await identify.run(makeCtx({ root, dotdir, state, fakeLLMFile: fake, warnings }));
  assert.equal(result.gate.passed, true);

  const findings = artifacts.readFindings(dotdir);
  assert.equal(findings.length, 2, "an out-of-range index fails open and admits the candidate");
  assert.ok(warnings.some((w) => /fail open/i.test(w) && /dedup/i.test(w)),
    `a fail-open dedupe warning must be logged; got: ${JSON.stringify(warnings)}`);
});

// ---------------------------------------------------------------------------
// AC4 — the semantic check runs at tier "cheap", is issued ONLY for
// hash-survivors, and compares ONLY against prior entries sharing the SAME
// dimension AND SAME file (including prior verified findings, never entries
// from a different dimension or file).
// ---------------------------------------------------------------------------
test("AC4: semantic check is cheap-tier, hash-survivors only, same dimension+file only", async (t) => {
  const { root, dotdir, headSha, head7 } = makeRepo(t);
  const now = new Date().toISOString();
  const state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);
  const logFile = newLogFile(t);

  // Stage three prior VERIFIED findings (seed the comparison list via
  // readFindings): one in the SAME cell (security/util.js), one in the same
  // dimension but a DIFFERENT file (security/other.js), and one in the SAME
  // file but a DIFFERENT dimension (correctness/util.js). Only the first may
  // appear in the security/util.js comparison list.
  const mkPrior = (id, dimension, title, claim, file) => artifacts.writeFinding(dotdir, {
    id, dimension, title, claim, severity: "high", confidence: 0.9,
    evidence: [{ file, line: 1, sha: head7 }],
    reproduction: { method: "reread", record: "prior", exitCode: null },
    status: "verified", foundAt: now, headSha, stale: false,
  });
  mkPrior("F-SEC-9001", "security", "same-cell-prior", "prior-security-util-claim", "src/util.js");
  mkPrior("F-SEC-9002", "security", "other-file-prior", "prior-security-other-claim", "src/other.js");
  mkPrior("F-CORR-9001", "correctness", "other-dim-prior", "prior-correctness-util-claim", "src/util.js");

  // Security finder proposes two candidates in one pass:
  //  - a HASH DUPLICATE of the same-cell prior (identical normalized claim) →
  //    caught by the free hash filter → must NOT trigger a semantic call.
  //  - a HASH SURVIVOR (distinct claim) → must trigger exactly one dedupe call.
  const hashDup = cand({ title: "hash dup", claim: "prior-security-util-claim", file: "src/util.js" });
  const survivor = cand({ title: "survivor", claim: "a brand new distinct security claim", file: "src/util.js" });

  const fake = writeFakeLLM(t, {
    script: {
      "finder:security": [{ candidates: [hashDup, survivor] }, { candidates: [] }],
      "dedupe:security": { duplicateOf: null },
    },
    logFile,
  });
  const result = await identify.run(makeCtx({ root, dotdir, state, fakeLLMFile: fake }));
  assert.equal(result.gate.passed, true);

  const dedupeCalls = readCalls(logFile).filter((c) => c.label === "dedupe:security");
  assert.equal(dedupeCalls.length, 1, "exactly one dedupe call — only the hash-survivor, never the hash-dup");

  const [call] = dedupeCalls;
  assert.equal(call.tier, "cheap", "the semantic check must run at the cheap tier");

  // The comparison list must contain the same-cell prior and NOTHING from a
  // different file or dimension.
  assert.match(call.prompt, /same-cell-prior|prior-security-util-claim/,
    "the same dimension+file prior must be offered for comparison");
  assert.doesNotMatch(call.prompt, /other-file-prior|prior-security-other-claim/,
    "a prior in a different file must NOT be in the comparison list");
  assert.doesNotMatch(call.prompt, /other-dim-prior|prior-correctness-util-claim/,
    "a prior in a different dimension must NOT be in the comparison list");
});

// ---------------------------------------------------------------------------
// H6 — the semantic-dedupe judge and finder prior-list carry file:line, so two
// distinct same-class defects in one file (identical wording, different lines)
// are not conflated. Verifies the PLUMBING: the dedupe prompt must render the
// location of every prior entry AND of the new candidate (absent before H6).
// ---------------------------------------------------------------------------
test("H6: dedupe prompt and finder prior-list include file:line for prior and candidate", async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const now = new Date().toISOString();
  const state = comprehendPassedState({ headSha, now });
  writeComprehensionInputs(dotdir, headSha, now);

  // Same file, DIFFERENT lines, DIFFERENT wording (so the hash filter passes
  // both through to the semantic judge — the hash keys off normalized claim,
  // not line). The judge (scripted null) treats them as distinct.
  const first = cand({ title: "swallowed error near top", claim: "an error is caught and dropped without logging", file: "src/util.js", line: 1 });
  const second = cand({ title: "swallowed error lower down", claim: "a second catch block discards its error silently", file: "src/util.js", line: 2 });

  const logFile = newLogFile(t);
  const fake = writeFakeLLM(t, {
    script: {
      "finder:security": [
        { candidates: [first] },  // pass 1: admitted (no prior → no dedupe call)
        { candidates: [second] }, // pass 2: hash-survivor → semantic judge runs
        { candidates: [] },       // pass 3: dry
      ],
      "dedupe:security": { duplicateOf: null }, // judge: distinct location → not a duplicate
    },
    logFile,
  });
  const result = await identify.run(makeCtx({ root, dotdir, state, fakeLLMFile: fake }));
  assert.equal(result.gate.passed, true);

  // Both distinct-location defects are admitted and verified.
  const findings = artifacts.readFindings(dotdir);
  assert.equal(findings.length, 2, "two distinct-location same-class defects are both admitted");

  // The dedupe prompt for the second candidate must render BOTH locations —
  // the prior entry's file:line AND the new candidate's file:line. Before H6
  // neither appeared, so the judge had no location signal.
  const dedupeCalls = readCalls(logFile).filter((c) => c.label === "dedupe:security");
  assert.equal(dedupeCalls.length, 1, "exactly one semantic-dedupe call (for the hash-survivor)");
  const p = dedupeCalls[0].prompt;
  assert.match(p, /src\/util\.js:1/, "the prior entry's file:line is in the dedupe prompt");
  assert.match(p, /src\/util\.js:2/, "the new candidate's file:line is in the dedupe prompt");

  // The pass-2 finder prompt lists the prior conclusion WITH its line, not bare file.
  const finderCalls = readCalls(logFile).filter((c) => c.label === "finder:security");
  const withPrior = finderCalls.find((c) => /swallowed error near top/.test(c.prompt));
  assert.ok(withPrior, "a finder pass saw the first finding as a prior conclusion");
  assert.match(withPrior.prompt, /src\/util\.js:1/, "the finder prior-conclusions list carries the line, not just the file");
});
