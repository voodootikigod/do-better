// test/comprehend.test.js — D1 comprehend phase (blueprint §8 row "comprehend.test.js").
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

let comprehend, utils, stateMod, artifacts, llmMod;
if (depsReady) {
  comprehend = await import("../src/comprehend.js");
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
const SERVER_GET_LINE = 5; // app.get("/health", ...) line in the synthesized fixture below
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-comp-"));
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

function prepState({ headSha, charterApproved = true }) {
  const now = new Date().toISOString();
  let s = stateMod.defaultState({ headSha, now });
  s = stateMod.recordPhase(s, "scan", { status: "done", sha: headSha, now, facts: tinyFacts(headSha) });
  s = stateMod.pinSha(s, "scan", headSha);
  if (charterApproved) {
    s = stateMod.setGate(s, "charter", { approved: true, approvedAt: now, charterSha256: "0".repeat(64) });
  }
  return s;
}

function writeCharter(dotdir, headSha) {
  artifacts.ensureLayout(dotdir);
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.charter, {
    meta: { approved: true, headSha, generatedAt: new Date().toISOString(), intent: "stabilize", weights: ALL_WEIGHTS },
    body: "# Charter\n\nPain: stability. Intent: stabilize over the next 12 months.\n",
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
    "  if (entry === undefined) return jsonMode ? '{\"candidates\":[],\"behaviors\":[]}' : '(fake reader output, no citations)';",
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

function makeFakeAdlcDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-adlc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "packages", "parallax", "bin", "parallax.mjs");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, [
    "#!/usr/bin/env node",
    "const out = process.env.FAKE_STDOUT ?? JSON.stringify({ score: 0.1, threshold: 0.25, agreements: ['a'], divergences: [] });",
    "console.log(out);",
    "process.exit(Number(process.env.FAKE_EXIT ?? 0));",
  ].join("\n"));
  return {
    mode: "dir", dir,
    available: { ...ABSENT_ADLC.available, parallax: true },
  };
}

function makeCtx(t, { root, dotdir, state, script = {}, offline = false, adlc = ABSENT_ADLC, flagsExtra = {}, logFile = null }) {
  const flags = {
    command: "audit", target: root, provider: null, budget: null, offline,
    // NOTE: blueprint defaults these to null, but WP-B resolveModels validates
    // them unconditionally and assertSafeModelName(null) throws — pass explicit
    // valid overrides here (also documents the tier-override path).
    modelCheap: "claude-haiku-4-5", modelMid: "claude-sonnet-4-6", modelFrontier: "claude-opus-4-8",
    n: null, threshold: null,
    approve: false, yes: false, json: false, help: false, ...flagsExtra,
  };
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; delete env.GEMINI_API_KEY;
  delete env.DOBETTER_FAKE_LLM;
  if (!offline) env.DOBETTER_FAKE_LLM = writeFakeLLM(t, script, { logFile });
  const llm = llmMod.createLLM({ flags, state, env });
  return {
    root, dotdir, state, llm, adlc, flags, log: quietLog,
    now: () => new Date().toISOString(), exec: utils.makeExec(), ask: null,
  };
}

function readerScript(head7) {
  return {
    "reader:behavior-inventory": {
      behaviors: [{ kind: "route", surface: "GET /health", file: "src/server.js", line: SERVER_GET_LINE, summary: "health endpoint" }],
    },
    "reader:codemap": `# Codemap\n- src/ — core server (src/server.js:${SERVER_GET_LINE}@${head7})`,
    "reader:architecture": `Layered design with a tiny route table (src/server.js:${SERVER_GET_LINE}@${head7})\nGhost claim about phantom module (src/missing.js:1@${head7})`,
    "reader:dependencies": "## Risk flags\n\n- none observed",
    "reader:rails-map": `# Rails Map\n- GET /health: covered by test/server.test.js (src/server.js:${SERVER_GET_LINE}@${head7})`,
    "reader:glossary": `# Glossary\n- health: liveness signal (src/server.js:${SERVER_GET_LINE}@${head7})`,
  };
}

// ---------------------------------------------------------------------------
test("buildCoveragePlan: caps deep-read set and declares percentages", { skip }, () => {
  const files = [
    { file: "src/server.js", loc: 40, bytes: 1600 },
    { file: "src/util.js", loc: 40, bytes: 1600 },
  ];
  for (let i = 0; i < 48; i++) files.push({ file: `lib/mod${String(i).padStart(2, "0")}.js`, loc: 30, bytes: 1200 });
  const plan = comprehend.buildCoveragePlan({ files }, { weights: ALL_WEIGHTS });
  assert.ok(plan.deepRead.length <= 40, "deep-read capped at 40 files");
  assert.equal(plan.deepRead.length + plan.scan.length + plan.skipped.length, 50);
  const pctSum = plan.deepPct + plan.scanPct + plan.skipPct;
  assert.ok(pctSum >= 98 && pctSum <= 102, `pcts ~100, got ${pctSum}`);
  assert.ok(typeof plan.rationale === "string" && plan.rationale.length > 0);
});

test("buildCoveragePlan: security weight 5 ranks src/server.js above src/util.js", { skip }, () => {
  const files = [
    { file: "src/util.js", loc: 40, bytes: 1600 },
    { file: "src/server.js", loc: 40, bytes: 1600 },
  ];
  const plan = comprehend.buildCoveragePlan({ files }, { weights: { ...ALL_WEIGHTS, security: 5 } });
  const iServer = plan.deepRead.indexOf("src/server.js");
  const iUtil = plan.deepRead.indexOf("src/util.js");
  assert.ok(iServer !== -1, "server.js deep-read");
  assert.ok(iUtil === -1 || iServer < iUtil, "security-relevant file ranked first");
});

test("run requires the charter gate (OpError, exit code 1)", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const state = prepState({ headSha, charterApproved: false });
  const ctx = makeCtx(t, { root, dotdir, state });
  await assert.rejects(
    () => comprehend.run(ctx),
    (err) => err instanceof utils.OpError && err.exitCode === 1 && /charter/i.test(err.message),
  );
});

test("citation gate drops bogus citations; all 7 artifacts written; parallax pass", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const head7 = headSha.slice(0, 7);
  writeCharter(dotdir, headSha);
  const state = prepState({ headSha });
  const adlc = makeFakeAdlcDir(t);
  delete process.env.FAKE_EXIT; delete process.env.FAKE_STDOUT;
  const ctx = makeCtx(t, { root, dotdir, state, script: readerScript(head7), adlc, flagsExtra: { n: 3, threshold: 0.25 } });
  const res = await comprehend.run(ctx);

  for (const rel of Object.values(artifacts.LAYOUT.comprehension)) {
    assert.ok(fs.existsSync(path.join(dotdir, rel)), `artifact exists: ${rel}`);
  }
  const arch = artifacts.readArtifact(dotdir, artifacts.LAYOUT.comprehension.architecture);
  assert.ok(arch.body.includes("Layered design"), "verified claim kept");
  assert.ok(!arch.body.includes("Ghost claim"), "claim with only failing citations removed");
  assert.ok(arch.body.includes(`src/server.js:${SERVER_GET_LINE}@${head7}`), "citation re-pinned to HEAD sha");
  const inv = artifacts.readArtifact(dotdir, artifacts.LAYOUT.comprehension.behaviorInventory);
  assert.ok(inv.body.includes("GET /health"), "behavior inventory keeps cited behavior");
  assert.equal(inv.meta.readings, 3, "readings recorded in frontmatter");

  assert.equal(res.state.gates.comprehend.passed, true);
  assert.equal(res.state.gates.comprehend.divergence, 0.1);
  assert.equal(res.state.gates.comprehend.degraded, null);
  assert.equal(res.state.phases.comprehend.status, "done");
  assert.equal(res.state.pins.comprehend, headSha);
  assert.ok(res.gate.passed && !res.gate.human);
});

test("divergence gate failure: parallax exit 2 → GateError with state attached", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const head7 = headSha.slice(0, 7);
  writeCharter(dotdir, headSha);
  const state = prepState({ headSha });
  const adlc = makeFakeAdlcDir(t);
  process.env.FAKE_EXIT = "2";
  process.env.FAKE_STDOUT = JSON.stringify({ score: 0.4, threshold: 0.25, agreements: [], divergences: ["reading A says queue is async", "reading B says queue is sync"] });
  t.after(() => { delete process.env.FAKE_EXIT; delete process.env.FAKE_STDOUT; });
  const ctx = makeCtx(t, { root, dotdir, state, script: readerScript(head7), adlc });
  await assert.rejects(
    () => comprehend.run(ctx),
    (err) => {
      assert.ok(err instanceof utils.GateError, "GateError thrown");
      assert.equal(err.exitCode, 2);
      assert.equal(err.gate, "comprehend");
      assert.ok(err.state, "partial state attached for the CLI to persist");
      assert.equal(err.state.gates.comprehend.passed, false);
      assert.equal(err.state.gates.comprehend.divergence, 0.4);
      return true;
    },
  );
  const arch = artifacts.readArtifact(dotdir, artifacts.LAYOUT.comprehension.architecture);
  assert.ok(arch.body.includes("## Open questions"), "divergences seeded as open questions");
  assert.ok(arch.body.includes("queue is async"));
});

test("parallax absent: degraded single-reading declared in coverage manifest, gate passes", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const head7 = headSha.slice(0, 7);
  writeCharter(dotdir, headSha);
  const state = prepState({ headSha });
  const ctx = makeCtx(t, { root, dotdir, state, script: readerScript(head7), adlc: ABSENT_ADLC });
  const res = await comprehend.run(ctx);
  assert.equal(res.state.gates.comprehend.passed, true);
  assert.equal(res.state.gates.comprehend.degraded, "single-reading");
  assert.equal(res.state.phases.comprehend.readings, 1);
  const manifest = artifacts.readArtifact(dotdir, artifacts.LAYOUT.comprehension.coverageManifest);
  assert.ok(manifest.body.includes("single-reading"), "degradation declared, never silent");
  assert.ok(manifest.body.includes("mined skills: skipped"), "skill-mining absence declared");
  assert.ok(/human skim/i.test(res.summary), "human skim instruction surfaced");
});

test("offline: structure-only behavior inventory finds app.get(\"/health\")", { skip }, async (t) => {
  const { root, dotdir, headSha } = makeRepo(t);
  const head7 = headSha.slice(0, 7);
  writeCharter(dotdir, headSha);
  const state = prepState({ headSha });
  const ctx = makeCtx(t, { root, dotdir, state, offline: true });
  const res = await comprehend.run(ctx);
  const inv = artifacts.readArtifact(dotdir, artifacts.LAYOUT.comprehension.behaviorInventory);
  assert.ok(inv.body.includes("GET /health"), "route grep found the health endpoint");
  assert.ok(inv.body.includes(`src/server.js:${SERVER_GET_LINE}@${head7}`), "citation pinned to HEAD");
  assert.ok(inv.body.includes("[cli]"), "bin entry surfaced as CLI behavior");
  assert.equal(res.state.gates.comprehend.passed, true);
  assert.equal(res.state.gates.comprehend.degraded, "single-reading");
  const manifest = artifacts.readArtifact(dotdir, artifacts.LAYOUT.comprehension.coverageManifest);
  assert.ok(/offline/.test(manifest.body), "offline degradation declared");
});
