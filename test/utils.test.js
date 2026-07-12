import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BudgetError,
  COMMANDS,
  GateError,
  OfflineError,
  OpError,
  TAXONOMY,
  assertSafeModelName,
  git,
  isSafeRelPath,
  makeExec,
  mapLimit,
  nowIso,
  parseArgs,
  readJsonSafe,
  readPackageFile,
  sha256Hex,
  truncate,
  writeFileAtomic,
} from "../src/utils.js";

// --- parseArgs ---------------------------------------------------------------

test("parseArgs defaults", () => {
  const f = parseArgs([]);
  assert.deepEqual(f, {
    command: null,
    target: ".",
    provider: null,
    budget: null,
    offline: false,
    modelCheap: null,
    modelMid: null,
    modelFrontier: null,
    n: null,
    threshold: null,
    approve: false,
    yes: false,
    json: false,
    help: false,
  });
});

test("parseArgs supports --flag value and --flag=value", () => {
  const a = parseArgs(["scan", "--provider", "gemini", "--budget", "2.5"]);
  assert.equal(a.command, "scan");
  assert.equal(a.provider, "gemini");
  assert.equal(a.budget, 2.5);

  const b = parseArgs(["scan", "--provider=openai", "--budget=10", "--threshold=0.3", "--n=5"]);
  assert.equal(b.provider, "openai");
  assert.equal(b.budget, 10);
  assert.equal(b.threshold, 0.3);
  assert.equal(b.n, 5);
});

test("parseArgs boolean flags and model overrides", () => {
  const f = parseArgs([
    "audit",
    "--offline",
    "--approve",
    "--yes",
    "--json",
    "--model-cheap",
    "m1",
    "--model-mid=m2",
    "--model-frontier",
    "m3",
  ]);
  assert.equal(f.offline, true);
  assert.equal(f.approve, true);
  assert.equal(f.yes, true);
  assert.equal(f.json, true);
  assert.equal(f.modelCheap, "m1");
  assert.equal(f.modelMid, "m2");
  assert.equal(f.modelFrontier, "m3");
});

test("parseArgs positionals: command iff in COMMANDS, second positional is target", () => {
  const a = parseArgs(["charter", "../some-repo"]);
  assert.equal(a.command, "charter");
  assert.equal(a.target, "../some-repo");

  const b = parseArgs(["not-a-command"]);
  assert.equal(b.command, null);
  assert.equal(b.target, "not-a-command");
});

test("parseArgs warns on unknown flags but never dies", () => {
  const f = parseArgs(["scan", "--frobnicate", "--what=ever"]);
  assert.equal(f.command, "scan");
});

test("parseArgs -h and --help set help", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("parseArgs rejects invalid --budget", () => {
  assert.throws(() => parseArgs(["scan", "--budget", "abc"]), OpError);
  assert.throws(() => parseArgs(["scan", "--budget", "-5"]), /Invalid --budget/);
  assert.throws(() => parseArgs(["scan", "--budget=0"]), /Invalid --budget/);
  assert.throws(() => parseArgs(["scan", "--budget"]), /Missing value/);
});

test("parseArgs rejects invalid --n and --threshold", () => {
  assert.throws(() => parseArgs(["audit", "--n", "0"]), /Invalid --n/);
  assert.throws(() => parseArgs(["audit", "--n", "2.5"]), /Invalid --n/);
  assert.throws(() => parseArgs(["audit", "--threshold", "x"]), /Invalid --threshold/);
});

test("COMMANDS matches the CLI surface", () => {
  assert.deepEqual(
    [...COMMANDS].sort(),
    ["audit", "charter", "rail", "refresh", "roadmap", "run", "scan"],
  );
});

test("TAXONOMY is the 8-dimension floor in canonical order", () => {
  assert.deepEqual(
    TAXONOMY.map((d) => d.id),
    [
      "correctness",
      "security",
      "maintainability",
      "performance",
      "operability",
      "test-quality",
      "dependency-health",
      "dx",
    ],
  );
});

// --- guards -------------------------------------------------------------------

test("assertSafeModelName rejects shell metacharacters", () => {
  assert.throws(() => assertSafeModelName("x; rm -rf /", "--model-mid"), OpError);
  assert.throws(() => assertSafeModelName("$(cmd)", "--model-cheap"), OpError);
  assert.throws(() => assertSafeModelName("", "--model-mid"), OpError);
  assert.doesNotThrow(() => assertSafeModelName("claude-sonnet-4-6", "--model-mid"));
  assert.doesNotThrow(() => assertSafeModelName("models/gemini-2.5:pro", "--model-mid"));
});

test("isSafeRelPath rejects traversal, absolute paths and NUL", () => {
  assert.equal(isSafeRelPath("../etc/passwd"), false);
  assert.equal(isSafeRelPath("src/../../x"), false);
  assert.equal(isSafeRelPath("/abs/path"), false);
  assert.equal(isSafeRelPath("a\0b"), false);
  assert.equal(isSafeRelPath(""), false);
  assert.equal(isSafeRelPath(42), false);
  assert.equal(isSafeRelPath("src/server.js"), true);
  assert.equal(isSafeRelPath("deep/nested/file.test.js"), true);
});

// --- crypto / misc --------------------------------------------------------------

test("sha256Hex known vector", () => {
  assert.equal(
    sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("nowIso returns an ISO timestamp", () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("truncate caps length with ellipsis", () => {
  assert.equal(truncate("hello", 10), "hello");
  const t = truncate("hello world", 6);
  assert.equal(t.length, 6);
  assert.ok(t.endsWith("…"));
});

// --- error classes ----------------------------------------------------------

test("error classes carry exit codes", () => {
  const op = new OpError("nope");
  assert.equal(op.exitCode, 1);
  const budget = new BudgetError("over");
  assert.equal(budget.exitCode, 1);
  assert.ok(budget instanceof OpError);
  const offline = new OfflineError("offline");
  assert.equal(offline.exitCode, 1);
  assert.ok(offline instanceof OpError);
  const gate = new GateError("comprehend", "divergence 0.5 ≥ 0.25");
  assert.equal(gate.exitCode, 2);
  assert.equal(gate.gate, "comprehend");
  assert.equal(gate.detail, "divergence 0.5 ≥ 0.25");
  assert.match(gate.message, /comprehend/);
});

// --- exec / git -----------------------------------------------------------------

test("makeExec returns status/stdout/stderr and never throws", () => {
  const exec = makeExec();
  const ok = exec(process.execPath, ["-e", "console.log('hi')"]);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), "hi");
  const bad = exec("definitely-not-a-real-binary-xyz", []);
  assert.notEqual(bad.status, 0);
});

test("git throws OpError on failure (bad cwd)", () => {
  assert.throws(() => git("/definitely/not/a/dir/xyz", ["status"]), OpError);
});

// --- files ----------------------------------------------------------------------

test("readJsonSafe: null on missing, OpError on garbage, object on valid", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-utils-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readJsonSafe(path.join(dir, "missing.json")), null);
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{nope");
  assert.throws(() => readJsonSafe(bad), OpError);
  const good = path.join(dir, "good.json");
  fs.writeFileSync(good, '{"a": 1}');
  assert.deepEqual(readJsonSafe(good), { a: 1 });
});

test("writeFileAtomic creates parent dirs and writes content", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-utils-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, "deep", "nested", "file.txt");
  writeFileAtomic(p, "content");
  assert.equal(fs.readFileSync(p, "utf8"), "content");
  writeFileAtomic(p, "replaced");
  assert.equal(fs.readFileSync(p, "utf8"), "replaced");
});

test("readPackageFile resolves relative to the do-better package root", () => {
  const pkg = readPackageFile("package.json");
  assert.match(pkg, /"name": "do-better"/);
  assert.throws(() => readPackageFile("no/such/file.md"), OpError);
});

// --- mapLimit (H8 bounded concurrency) ---------------------------------------

test("mapLimit preserves INPUT order regardless of completion order", async () => {
  // Later items resolve sooner; results must still match input order.
  const out = await mapLimit([30, 10, 20], 3, (ms, i) =>
    new Promise((r) => setTimeout(() => r(`${i}:${ms}`), ms)));
  assert.deepEqual(out, ["0:30", "1:10", "2:20"]);
});

test("mapLimit never exceeds the concurrency limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const fn = async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return null;
  };
  await mapLimit([1, 2, 3, 4, 5, 6, 7], 2, fn);
  assert.ok(peak <= 2, `peak concurrency ${peak} must not exceed 2`);
  assert.ok(peak >= 1);
});

test("mapLimit propagates the first rejection after in-flight tasks settle", async () => {
  const settled = [];
  await assert.rejects(
    mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom-2");
      await new Promise((r) => setTimeout(r, 3));
      settled.push(n);
      return n;
    }),
    (err) => err instanceof Error && /boom-2/.test(err.message),
  );
});

test("mapLimit handles empty input and clamps limit to >= 1", async () => {
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  assert.deepEqual(await mapLimit([5, 6], 0, async (n) => n * 2), [10, 12]);
});
