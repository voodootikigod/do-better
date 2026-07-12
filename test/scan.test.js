// test/scan.test.js — D-1 scan: deterministic fact collection, offline
// structure-only codemap, LLM codemap path (cheap tier), non-git rejection.
// No network: every LLM is a local in-memory fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PHASE_ID, collectRepoFacts, run } from "../src/scan.js";
import { OfflineError, OpError, makeExec } from "../src/utils.js";
import { defaultState } from "../src/state.js";
import { LAYOUT, readArtifact } from "../src/artifacts.js";

const NOW = "2026-06-12T00:00:00.000Z";

// Self-contained fixture repo content (equivalent in shape to fixtures/tiny-repo,
// but inlined so this package's tests have deterministic exact counts).
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
  "src/server.js": [
    'import http from "node:http";',
    "// TODO: handle errors",
    "export function createServer() {",
    "  return http.createServer((req, res) => {",
    '    if (req.url === "/health") { res.end("ok"); return; }',
    "    res.statusCode = 404;",
    '    res.end("not found");',
    "  });",
    "}",
    "",
  ].join("\n"),
  "src/util.js": ["// FIXME: rename this module", "export function add(a, b) {", "  return a + b;", "}", ""].join(
    "\n"
  ),
  "test/server.test.js": [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'test("placeholder", () => { assert.equal(1, 1); });',
    "",
  ].join("\n"),
  "bin/tool.js": ["#!/usr/bin/env node", 'console.log("tool");', ""].join("\n"),
  ".github/workflows/ci.yml": ["name: ci", "on: push", ""].join("\n"),
  "README.md": ["# tiny", "", "A tiny fixture repo for do-better tests.", ""].join("\n"),
};

function gitIn(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function makeRepo(files = TINY_REPO) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-scan-"));
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

// Scripted fake LLM: routes on label; records every call with its tier.
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
    flags: { command: "scan", target: root, offline: llm.offline === true },
    log: stubLog(),
    now: () => NOW,
    exec: makeExec(),
    ask,
  };
}

function expectedLoc(content) {
  return (content.match(/\n/g) ?? []).length;
}

test("collectRepoFacts gathers deterministic facts from a fixture repo", () => {
  const { root, headSha } = makeRepo();
  const facts = collectRepoFacts(root, makeExec());

  assert.equal(facts.headSha, headSha);
  assert.match(facts.headSha, /^[0-9a-f]{40}$/);
  assert.equal(facts.fileCount, 7);
  const totalLoc = Object.values(TINY_REPO).reduce((sum, c) => sum + expectedLoc(c), 0);
  assert.equal(facts.locTotal, totalLoc);

  // incantations: package.json scripts + workflow file
  assert.equal(facts.incantations.scripts.test, "node --test");
  assert.equal(facts.incantations.scripts.start, "node src/server.js");
  assert.deepEqual(facts.incantations.ci, [".github/workflows/ci.yml"]);
  assert.deepEqual(facts.incantations.docker, []);

  // markers: one TODO + one FIXME line
  assert.equal(facts.todoCount, 2);

  assert.deepEqual(facts.testDirs, ["test"]);
  assert.deepEqual(facts.manifests, ["package.json"]);
  assert.deepEqual(facts.depCounts, { prod: 1, dev: 1 });
  assert.equal(facts.extHistogram.js, 4);
  assert.ok(facts.readmeFirstKB.startsWith("# tiny"));

  // largestFiles sorted by LOC descending, top entry is the biggest source file
  assert.equal(facts.largestFiles[0].file, "package.json");
  assert.equal(facts.largestFiles[1].file, "src/server.js");
  const locs = facts.largestFiles.map((f) => f.loc);
  assert.deepEqual(locs, [...locs].sort((a, b) => b - a));

  // topDirs aggregates per top-level directory
  const srcDir = facts.topDirs.find((d) => d.dir === "src");
  assert.equal(srcDir.files, 2);
  assert.equal(srcDir.loc, expectedLoc(TINY_REPO["src/server.js"]) + expectedLoc(TINY_REPO["src/util.js"]));
});

test("collectRepoFacts on a minimal repo yields empty incantations/manifests/testDirs", () => {
  const { root } = makeRepo({ "main.py": "print('hi')\n" });
  const facts = collectRepoFacts(root, makeExec());
  assert.deepEqual(facts.incantations.scripts, {});
  assert.deepEqual(facts.manifests, []);
  assert.deepEqual(facts.testDirs, []);
  assert.deepEqual(facts.depCounts, { prod: 0, dev: 0 });
  assert.equal(facts.todoCount, 0);
  assert.equal(facts.readmeFirstKB, "");
});

test("offline run() writes a structure-only codemap draft and records facts + pin", async () => {
  const { root, headSha } = makeRepo();
  const ctx = makeCtx(root, headSha);
  const result = await run(ctx);

  // artifact: codemap draft with required frontmatter
  const artifact = readArtifact(ctx.dotdir, LAYOUT.comprehension.codemap);
  assert.ok(artifact, "codemap artifact must exist");
  assert.equal(artifact.meta.generatedBy, "scan");
  assert.equal(artifact.meta.draft, true);
  assert.equal(artifact.meta.headSha, headSha);
  assert.match(artifact.body, /\(structure-only\)/);
  assert.match(artifact.body, /src/);

  // state: phase done, facts recorded, SHA pinned; input state not mutated
  assert.equal(result.gate, null);
  assert.equal(result.state.phases.scan.status, "done");
  assert.equal(result.state.phases.scan.sha, headSha);
  assert.equal(result.state.phases.scan.facts.fileCount, 7);
  assert.equal(result.state.pins.scan, headSha);
  assert.equal(result.state.budget.spentUSD, 0); // offline = zero spend
  assert.equal(ctx.state.phases.scan.status, "pending", "input state must not be mutated");
  assert.match(result.summary, /7 files/);
  assert.match(result.summary, /codemap/i);
  assert.equal(PHASE_ID, "scan");
});

test("LLM run() uses the cheap tier with label 'codemap' and folds spend into state", async () => {
  const { root, headSha } = makeRepo();
  const fakeCodemap = "# Codemap (draft)\n\n- `src/` — HTTP server and helpers\n";
  const { llm, calls } = makeScriptedLLM({ codemap: fakeCodemap });
  const ctx = makeCtx(root, headSha, { llm });
  const result = await run(ctx);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, "codemap");
  assert.equal(calls[0].tier, "cheap"); // §6 tier discipline: D-1 is cheap-only
  assert.match(calls[0].prompt, /Repository facts/);

  const artifact = readArtifact(ctx.dotdir, LAYOUT.comprehension.codemap);
  assert.equal(artifact.body.trim(), fakeCodemap.trim());
  assert.equal(result.state.phases.scan.spend.calls, 1);
  assert.ok(result.state.budget.spentUSD > 0, "spend must reach budget.spentUSD");
});

test("run() rejects a non-git directory with an OpError naming the requirement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-nogit-"));
  fs.writeFileSync(path.join(root, "file.txt"), "hello\n");
  const ctx = makeCtx(root, "0".repeat(40));
  await assert.rejects(
    () => run(ctx),
    (err) => {
      assert.ok(err instanceof OpError);
      assert.match(err.message, /requires a git repository/);
      return true;
    }
  );
});

test("LLM failure persists accumulated spend on err.state (resumability)", async () => {
  const { root, headSha } = makeRepo();
  const { llm } = makeScriptedLLM({
    codemap: () => {
      throw new OpError("provider exploded");
    },
  });
  const ctx = makeCtx(root, headSha, { llm });
  await assert.rejects(
    () => run(ctx),
    (err) => {
      assert.match(err.message, /provider exploded/);
      assert.ok(err.state, "err.state must carry the partial state for the CLI to save");
      assert.equal(err.state.phases.scan.spend.calls, 1);
      return true;
    }
  );
});

test("H11: spend from a paid codemap call survives on err.state when writeArtifact throws", async () => {
  const { root, headSha } = makeRepo();
  const dotdir = path.join(root, ".dobetter");
  // Force writeArtifact to fail AFTER the paid codemap call: pre-create a
  // DIRECTORY where the codemap file must be written, so the atomic file write
  // throws (EISDIR / rename-onto-dir).
  const codemapPath = path.join(dotdir, LAYOUT.comprehension.codemap);
  fs.mkdirSync(codemapPath, { recursive: true });

  const { llm } = makeScriptedLLM({ codemap: "# Codemap\n\nsrc/server.js — http server\n" });
  const ctx = makeCtx(root, headSha, { llm });

  await assert.rejects(
    run(ctx),
    (err) => {
      // The write failed, but the codemap call's cost must not vanish: the CLI
      // saves err.state, so it must carry the accumulated spend (H11).
      assert.ok(err.state, "err.state is attached so the CLI can persist spend");
      assert.ok(
        err.state.budget.spentUSD > 0,
        `spend must survive the write failure, got ${err.state.budget.spentUSD}`,
      );
      return true;
    },
  );
});
