// test/identify.test.js — D2 identify phase (blueprint §8 row "identify.test.js").
// No network ever: DOBETTER_FAKE_LLM seam or --offline in every phase-touching test.
// Skips gracefully while shared modules owned by WP-A/WP-B are not yet present.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const DEP_FILES = ["utils.js", "state.js", "artifacts.js", "llm.js", "adlc.js"];
const depsReady = DEP_FILES.every((f) => fs.existsSync(path.join(srcDir, f)));
const skip = depsReady
  ? false
  : "shared modules not present yet (WP-A: utils/state/artifacts, WP-B: llm/adlc) — these tests activate once they land";

let identify, utils, stateMod, artifacts, llmMod;
if (depsReady) {
  identify = await import("../src/identify.js");
  utils = await import("../src/utils.js");
  stateMod = await import("../src/state.js");
  artifacts = await import("../src/artifacts.js");
  llmMod = await import("../src/llm.js");
}

// --- inline helpers (blueprint: helpers live inline in test files, not src/) ---
const ALL_WEIGHTS = {
  correctness: 3, security: 5, maintainability: 3, performance: 1,
  operability: 1, "test-quality": 2, "dependency-health": 1, dx: 1,
};
const quietLog = {
  info() {}, success() {}, warn() {}, error() {}, phase() {}, gate() {},
  step() {}, substep() {}, errorTrace() {},
};

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function synthesizeTinyRepo(dir) {
  const files = {
    "package.json": JSON.stringify({
      name: "tiny", version: "1.0.0", type: "module",
      bin: { tool: "bin/tool.js" }, scripts: { test: "node --test" }, dependencies: {},
    }, null, 2) + "\n",
    "src/server.js": [
      "// tiny fixture server",
      'import http from "node:http";',
      "const routes = {};",
      'export const app = { get(p, h) { routes["GET " + p] = h; } };',
      'app.get("/health", () => ({ ok: true }));',
      "// TODO: add auth",
      "export function start() {",
      '  return http.createServer((req, res) => res.end("ok"));',
      "}",
      "",
    ].join("\n"),
    "src/util.js": "export function add(a, b) {\n  return a + b;\n}\n",
    "test/server.test.js": 'import { test } from "node:test";\ntest("noop", () => {});\n',
    "bin/tool.js": "#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join(\" \"));\n",
    "README.md": "# tiny\n",
    ".github/workflows/ci.yml": "name: ci\non: [push]\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-iden-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  synthesizeTinyRepo(root);
  sh(root, "git", ["init", "-q"]);
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  const headSha = sh(root, "git", ["rev-parse", "HEAD"]);
  return { root, dotdir: path.join(root, ".dobetter"), headSha };
}

function tinyFacts(headSha) {
  return {
    headSha, fileCount: 7, locTotal: 120, extHistogram: { ".js": 4 },
    topDirs: [{ dir: "src", files: 2, loc: 60 }],
    largestFiles: [{ file: "src/server.js", loc: 10 }, { file: "src/util.js", loc: 4 }],
    incantations: { scripts: { test: "node --test" }, ci: [".github/workflows/ci.yml"], docker: [] },
    manifests: ["package.json"], depCounts: { prod: 0, dev: 0 }, todoCount: 1,
    testDirs: ["test"], readmeFirstKB: "# tiny",
  };
}

function prepState({ headSha, comprehendPassed = true }) {
  const now = new Date().toISOString();
  let s = stateMod.defaultState({ headSha, now });
  s = stateMod.recordPhase(s, "scan", { status: "done", sha: headSha, now, facts: tinyFacts(headSha) });
  s = stateMod.setGate(s, "charter", { approved: true, approvedAt: now, charterSha256: "0".repeat(64) });
  if (comprehendPassed) {
    s = stateMod.setGate(s, "comprehend", { passed: true, divergence: 0.1 });
    s = stateMod.recordPhase(s, "comprehend", { status: "done", sha: headSha, now });
  }
  return s;
}

function writeComprehensionInputs(dotdir, headSha) {
  artifacts.ensureLayout(dotdir);
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.charter, {
    meta: { approved: true, headSha, generatedAt: new Date().toISOString(), intent: "stabilize", weights: ALL_WEIGHTS },
    body: "# Charter\n\nPain: stability.\n",
  });
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.comprehension.coverageManifest, {
    meta: { headSha, generatedAt: new Date().toISOString(), deepPct: 40, scanPct: 40, skipPct: 20 },
    body: [
      "# Coverage Manifest", "",
      "## Deep-read files", "- src/server.js", "- src/util.js", "",
      "## Scanned files", "- (none)", "",
      "## Skipped files", "- (none)", "",
      "## Degradations", "- (none)",
    ].join("\n") + "\n",
  });
}

function writeFakeLLM(t, script, { logFile = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-fake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-llm.mjs");
  fs.writeFileSync(file, [
    `const script = ${JSON.stringify(script)};`,
    `const logFile = ${JSON.stringify(logFile)};`,
    "const counts = {};",
    'import fs from "node:fs";',
    "export default async function fake({ prompt, system, tier, label, jsonMode }) {",
    "  if (logFile) fs.appendFileSync(logFile, label + '\\t' + tier + '\\n');",
    "  const entry = script[label];",
    "  if (entry === undefined) return jsonMode ? '{\"candidates\":[]}' : '(fake output)';",
    "  const list = Array.isArray(entry) ? entry : [entry];",
    "  const i = counts[label] ?? 0; counts[label] = i + 1;",
    "  const v = list[Math.min(i, list.length - 1)];",
    "  return typeof v === 'string' ? v : JSON.stringify(v);",
    "}",
  ].join("\n"));
  return file;
}

const ABSENT_ADLC = Object.freeze({
  mode: "absent", dir: null,
  available: {
    parallax: false, coldstart: false, "hollow-test": false,
    "behavior-diff": false, preflight: false, "skill-mining": false,
  },
});

function makeCtx(t, { root, dotdir, state, script = {}, offline = false, logFile = null }) {
  const flags = {
    command: "audit", target: root, provider: null, budget: null, offline,
    // NOTE: blueprint defaults these to null, but WP-B resolveModels validates
    // them unconditionally and assertSafeModelName(null) throws — pass explicit
    // valid overrides here (also documents the tier-override path).
    modelCheap: "claude-haiku-4-5", modelMid: "claude-sonnet-4-6", modelFrontier: "claude-opus-4-8",
    n: null, threshold: null,
    approve: false, yes: false, json: false, help: false,
  };
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; delete env.GEMINI_API_KEY;
  delete env.DOBETTER_FAKE_LLM;
  if (!offline) env.DOBETTER_FAKE_LLM = writeFakeLLM(t, script, { logFile });
  const llm = llmMod.createLLM({ flags, state, env });
  return {
    root, dotdir, state, llm, adlc: ABSENT_ADLC, flags, log: quietLog,
    now: () => new Date().toISOString(), exec: utils.makeExec(), ask: null,
  };
}

const CAND_A = { title: "Hardcoded token", claim: "token literal committed to source", file: "src/server.js", line: 5, severity: "high", confidence: 0.9 };
const CAND_B = { title: "Missing input validation", claim: "route params used unvalidated", file: "src/server.js", line: 4, severity: "medium", confidence: 0.6 };

// ---------------------------------------------------------------------------
test("dedupeKey: stable across whitespace/case; distinct per dimension/file/claim", { skip }, () => {
  const a = identify.dedupeKey({ dimension: "security", file: "src/a.js", claim: "Eval  Used\nhere" });
  const b = identify.dedupeKey({ dimension: "security", file: "src/a.js", claim: "eval used here" });
  assert.equal(a, b, "normalized claim collapses whitespace and case");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, identify.dedupeKey({ dimension: "performance", file: "src/a.js", claim: "eval used here" }));
  assert.notEqual(a, identify.dedupeKey({ dimension: "security", file: "src/b.js", claim: "eval used here" }));
});

test("run requires the comprehend gate (OpError)", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  writeComprehensionInputs(dotdir, headSha);
  const state = prepState({ headSha, comprehendPassed: false });
  const ctx = makeCtx(t, { root, dotdir, state });
  await assert.rejects(
    () => identify.run(ctx),
    (err) => err instanceof utils.OpError && err.exitCode === 1 && /comprehen/i.test(err.message),
  );
});

test("loop-until-dry: [2 new, 1 dup, 0 new] → dry at K=2, passes recorded; command repro survives", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  writeComprehensionInputs(dotdir, headSha);
  const state = prepState({ headSha });
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-log-")), "calls.tsv");
  t.after(() => fs.rmSync(path.dirname(logFile), { recursive: true, force: true }));
  const script = {
    "finder:security": [
      { candidates: [CAND_A, CAND_B] },
      { candidates: [CAND_A] }, // duplicate → 0 new → dry streak 1
      { candidates: [] },       // 0 new → dry streak 2 → stop
    ],
    "repro-cmd": { reproCmd: 'node -e "process.exit(0)"' },
  };
  const ctx = makeCtx(t, { root, dotdir, state, script, logFile });
  const res = await identify.run(ctx);

  assert.equal(res.state.phases.identify.passesByDimension.security, 3, "security needed 3 passes");
  assert.equal(res.state.phases.identify.passesByDimension.correctness, 2, "quiet dimensions dry in exactly K=2 passes");
  assert.equal(res.state.phases.identify.verified, 2);
  assert.equal(res.state.phases.identify.killed, 0);
  assert.equal(res.state.gates.identify.passed, true);
  assert.equal(res.state.gates.identify.unverified, 0);
  assert.equal(res.state.pins.identify, headSha);

  const findings = artifacts.readFindings(dotdir);
  assert.equal(findings.length, 2, "one file per verified finding");
  for (const f of findings) {
    assert.equal(f.status, "verified");
    assert.equal(f.dimension, "security");
    assert.match(f.id, /^F-[A-Z]{2,8}-\d{4}$/);
    assert.equal(f.reproduction.method, "command");
    assert.equal(f.reproduction.exitCode, 0);
    assert.ok(Array.isArray(f.evidence) && f.evidence.length >= 1, "≥1 verified citation");
  }
  const nums = findings.map((f) => Number(f.id.slice(-4))).sort((a, b) => a - b);
  assert.deepEqual(nums, [1, 2], "finding IDs sequential");

  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => l.split("\t"));
  const finderTiers = calls.filter(([label]) => label.startsWith("finder:")).map(([, tier]) => tier);
  assert.ok(finderTiers.length > 0 && finderTiers.every((tr) => tr === "mid"), "finders run at mid tier (spec §6)");
});

test("MAX_PASSES cap without dry → GateError exit 2, state attached", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  writeComprehensionInputs(dotdir, headSha);
  const state = prepState({ headSha });
  const endless = [];
  for (let i = 0; i < identify.MAX_PASSES + 1; i++) {
    endless.push({ candidates: [{ title: `Novel issue ${i}`, claim: `distinct claim number ${i}`, file: "src/server.js", line: 5, severity: "low", confidence: 0.4 }] });
  }
  const script = {
    "finder:security": endless,
    "repro-cmd": { reproCmd: null },
    "verdict": { verdict: "KILL", reason: "does not hold" },
  };
  const ctx = makeCtx(t, { root, dotdir, state, script });
  await assert.rejects(
    () => identify.run(ctx),
    (err) => {
      assert.ok(err instanceof utils.GateError);
      assert.equal(err.exitCode, 2);
      assert.equal(err.gate, "identify");
      assert.ok(err.state, "partial state attached");
      assert.equal(err.state.gates.identify.passed, false);
      assert.equal(err.state.phases.identify.passesByDimension.security, identify.MAX_PASSES);
      assert.match(err.detail, /not dry/i);
      return true;
    },
  );
});

test("invalid candidates (bad path, bad severity) are dropped — fail closed, dry, no findings", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  writeComprehensionInputs(dotdir, headSha);
  const state = prepState({ headSha });
  const script = {
    "finder:security": [
      { candidates: [
        { title: "escape attempt", claim: "x", file: "../etc/passwd", line: 1, severity: "high" },
        { title: "abs path", claim: "y", file: "/etc/shadow", line: 1, severity: "high" },
        { title: "bad severity", claim: "z", file: "src/server.js", line: 2, severity: "banana" },
        { title: "bad line", claim: "w", file: "src/server.js", line: 0, severity: "low" },
      ] },
      { candidates: [] },
    ],
  };
  const ctx = makeCtx(t, { root, dotdir, state, script });
  const res = await identify.run(ctx);
  assert.equal(res.state.phases.identify.passesByDimension.security, 2, "all-invalid pass counts as dry");
  assert.equal(res.state.phases.identify.verified, 0);
  assert.equal(artifacts.readFindings(dotdir).length, 0, "nothing written");
  assert.equal(res.state.gates.identify.passed, true);
});

test("reread KILL verdict → candidate killed, never written; verdict runs at frontier tier", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  writeComprehensionInputs(dotdir, headSha);
  const state = prepState({ headSha });
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-log-")), "calls.tsv");
  t.after(() => fs.rmSync(path.dirname(logFile), { recursive: true, force: true }));
  const script = {
    "finder:maintainability": [
      { candidates: [{ title: "Tangled module", claim: "module has tangled responsibilities", file: "src/server.js", line: 4, severity: "medium", confidence: 0.5 }] },
      { candidates: [] },
    ],
    "repro-cmd": { reproCmd: null },
    "verdict": { verdict: "KILL", reason: "the cited code does not support the claim" },
  };
  const ctx = makeCtx(t, { root, dotdir, state, script, logFile });
  const res = await identify.run(ctx);
  assert.equal(res.state.phases.identify.killed, 1);
  assert.equal(res.state.phases.identify.verified, 0);
  assert.equal(artifacts.readFindings(dotdir).length, 0, "unverified findings never reach output (D8)");
  assert.equal(res.state.gates.identify.passed, true, "killing candidates does not fail the gate");
  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n").map((l) => l.split("\t"));
  const verdictTiers = calls.filter(([label]) => label === "verdict").map(([, tier]) => tier);
  assert.ok(verdictTiers.length > 0 && verdictTiers.every((tr) => tr === "frontier"), "verdicts run at frontier tier (spec §6)");
});

test("unparseable verdict → killed (fail closed)", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  writeComprehensionInputs(dotdir, headSha);
  const state = prepState({ headSha });
  const script = {
    "finder:correctness": [
      { candidates: [{ title: "Suspicious branch", claim: "branch can never execute", file: "src/util.js", line: 2, severity: "medium", confidence: 0.5 }] },
      { candidates: [] },
    ],
    "repro-cmd": { reproCmd: null },
    "verdict": ["this is not json at all", "still { not json"],
  };
  const ctx = makeCtx(t, { root, dotdir, state, script });
  const res = await identify.run(ctx);
  assert.equal(res.state.phases.identify.killed, 1, "unparseable verdict kills the candidate");
  assert.equal(res.state.phases.identify.verified, 0);
  assert.equal(artifacts.readFindings(dotdir).length, 0);
  assert.equal(res.state.gates.identify.passed, true);
});

test("citation that does not verify → killed before any LLM verdict", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  writeComprehensionInputs(dotdir, headSha);
  const state = prepState({ headSha });
  const script = {
    "finder:security": [
      { candidates: [{ title: "Phantom file", claim: "issue in a file that does not exist", file: "src/missing.js", line: 3, severity: "high", confidence: 0.9 }] },
      { candidates: [] },
    ],
  };
  const ctx = makeCtx(t, { root, dotdir, state, script });
  const res = await identify.run(ctx);
  assert.equal(res.state.phases.identify.killed, 1);
  assert.equal(artifacts.readFindings(dotdir).length, 0);
});

test("idempotent re-run (D6): existing findings seed the dedupe set — no duplicate findings or IDs", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  writeComprehensionInputs(dotdir, headSha);
  const first = await identify.run(makeCtx(t, { root, dotdir, state: prepState({ headSha }), offline: true }));
  const afterFirst = artifacts.readFindings(dotdir);
  assert.ok(afterFirst.length >= 1, "first audit produced verified findings");

  const second = await identify.run(makeCtx(t, { root, dotdir, state: first.state, offline: true }));
  const afterSecond = artifacts.readFindings(dotdir);
  assert.equal(afterSecond.length, afterFirst.length, "re-running audit must not duplicate findings");
  assert.deepEqual(
    afterSecond.map((f) => f.id).sort(),
    afterFirst.map((f) => f.id).sort(),
    "no new finding IDs allocated for identical claims",
  );
  assert.equal(second.state.phases.identify.verified, 0, "unchanged repo → nothing new verified");
  assert.equal(second.state.gates.identify.passed, true);
});

test("verified findings persist a machine-re-runnable reproduction (cmd argv / check spec)", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  writeComprehensionInputs(dotdir, headSha);
  const state = prepState({ headSha });
  const script = {
    "finder:security": [{ candidates: [CAND_A] }, { candidates: [] }],
    "repro-cmd": { reproCmd: 'node -e "process.exit(0)"' },
  };
  const res = await identify.run(makeCtx(t, { root, dotdir, state, script }));
  assert.equal(res.state.phases.identify.verified, 1);
  const [f] = artifacts.readFindings(dotdir);
  assert.deepEqual(f.reproduction.cmd, ["node", "-e", "process.exit(0)"], "argv persisted for refresh re-runs");
  assert.equal(f.claim, CAND_A.claim, "claim persisted for re-run dedupe");
});

test("offline: deterministic static pass per dimension; static repro survives, false claims killed", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  writeComprehensionInputs(dotdir, headSha);
  const state = prepState({ headSha });
  const ctx = makeCtx(t, { root, dotdir, state, offline: true });
  const res = await identify.run(ctx);
  assert.equal(res.state.gates.identify.passed, true, "offline runs dry by construction");
  for (const passes of Object.values(res.state.phases.identify.passesByDimension)) {
    assert.equal(passes, 1, "exactly one deterministic pass per dimension");
  }
  const findings = artifacts.readFindings(dotdir);
  const todo = findings.find((f) => f.dimension === "maintainability");
  assert.ok(todo, "TODO marker in fixture surfaces as a verified static finding");
  assert.equal(todo.reproduction.method, "static");
  assert.equal(todo.reproduction.check?.type, "regex", "re-runnable check spec persisted (D6/D9)");
  assert.equal(todo.reproduction.check?.file, "src/server.js");
  assert.ok(res.state.phases.identify.killed >= 1, "no-tests claim killed: fixture has a test dir (reproduce-or-kill applies offline too)");
  assert.match(res.summary, /DEGRADED/i, "offline degradation declared, never silent");
});
