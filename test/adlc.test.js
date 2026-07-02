// test/adlc.test.js — locate precedence, exit-code interpretation, degrade
// table. NO NETWORK: fake adlc layouts are built in tmpdirs; "npx" paths are
// exercised with stub exec functions, never a real npx spawn.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ADLC_TOOLS,
  locateAdlc,
  runAdlcTool,
  runParallax,
  runColdstart,
  runHollowTest,
  runBehaviorDiff,
  runPreflight,
  runSkillMining,
} from "../src/adlc.js";
import { OpError } from "../src/utils.js";

// ── fixture helpers (inline per blueprint §8 — fixtures live in tmpdirs) ────

// Fake tool bin: FAKE_ECHO_ARGS=1 → print {"argv":[...]}; else print
// FAKE_STDOUT (default "{}"); FAKE_STDERR to stderr; exit FAKE_EXIT (default 0).
const FAKE_BIN = `const echoArgs = process.env.FAKE_ECHO_ARGS === "1";
if (echoArgs) {
  console.log(JSON.stringify({ argv: process.argv.slice(2) }));
} else if (process.env.FAKE_STDOUT !== undefined) {
  console.log(process.env.FAKE_STDOUT);
}
if (process.env.FAKE_STDERR) console.error(process.env.FAKE_STDERR);
process.exit(Number(process.env.FAKE_EXIT ?? "0"));
`;

function tmpdir(prefix = "dobetter-adlc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeAdlcDir(tools) {
  const dir = tmpdir();
  for (const name of tools) {
    const binDir = path.join(dir, "packages", name, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, `${name}.mjs`), FAKE_BIN);
  }
  return dir;
}

function makeSkillMiningDir() {
  const dir = tmpdir("dobetter-sm-");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "cli.js"), FAKE_BIN);
  return dir;
}

// exec wrapper that controls the fake bins via env (Ctx.exec shape).
function execWithEnv(extraEnv = {}) {
  return (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      shell: false,
      cwd: opts.cwd,
      timeout: opts.timeout,
      env: { ...process.env, ...extraEnv },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
  };
}

// Isolated roots so sibling probes never find a real ../aidlc checkout.
function isolatedRoots() {
  const base = tmpdir("dobetter-roots-");
  const packageRoot = path.join(base, "pkg");
  const targetRoot = path.join(base, "target");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.mkdirSync(targetRoot, { recursive: true });
  return { base, packageRoot, targetRoot };
}

function locateDir(adlcDir, env = {}) {
  const { packageRoot, targetRoot } = isolatedRoots();
  return locateAdlc({
    env: { DOBETTER_ADLC_DIR: adlcDir, DOBETTER_NO_NPX: "1", ...env },
    packageRoot,
    targetRoot,
  });
}

// ── locateAdlc ───────────────────────────────────────────────────────────────

test("env DOBETTER_ADLC_DIR beats sibling checkouts", () => {
  const envDir = makeAdlcDir(["parallax"]);
  const { base, packageRoot, targetRoot } = isolatedRoots();
  // sibling of packageRoot has a different tool set — must NOT win
  fs.cpSync(makeAdlcDir(["coldstart"]), path.join(base, "aidlc"), { recursive: true });

  const loc = locateAdlc({ env: { DOBETTER_ADLC_DIR: envDir, DOBETTER_NO_NPX: "1" }, packageRoot, targetRoot });
  assert.equal(loc.mode, "dir");
  assert.equal(loc.dir, envDir);
  assert.equal(loc.available.parallax, true);
  assert.equal(loc.available.coldstart, false);
});

test("sibling of packageRoot is found when no env dir is set", () => {
  const { base, packageRoot, targetRoot } = isolatedRoots();
  const sibling = path.join(base, "aidlc");
  fs.cpSync(makeAdlcDir(["coldstart", "preflight"]), sibling, { recursive: true });

  const loc = locateAdlc({ env: { DOBETTER_NO_NPX: "1" }, packageRoot, targetRoot });
  assert.equal(loc.mode, "dir");
  assert.equal(loc.dir, sibling);
  assert.deepEqual(
    ADLC_TOOLS.filter((t) => loc.available[t]).sort(),
    ["coldstart", "preflight"]
  );
});

test("sibling of targetRoot is probed after packageRoot sibling", () => {
  const outer = tmpdir("dobetter-outer-");
  const packageRoot = path.join(outer, "pkgside", "pkg");
  fs.mkdirSync(packageRoot, { recursive: true });
  const targetRoot = path.join(outer, "target");
  fs.mkdirSync(targetRoot, { recursive: true });
  const sibling = path.join(outer, "aidlc");
  fs.cpSync(makeAdlcDir(["behavior-diff"]), sibling, { recursive: true });

  const loc = locateAdlc({ env: { DOBETTER_NO_NPX: "1" }, packageRoot, targetRoot });
  assert.equal(loc.mode, "dir");
  assert.equal(loc.dir, sibling);
  assert.equal(loc.available["behavior-diff"], true);
});

test("mixed availability: fixture shipping only parallax+coldstart", () => {
  const loc = locateDir(makeAdlcDir(["parallax", "coldstart"]));
  assert.deepEqual(
    Object.fromEntries(ADLC_TOOLS.map((t) => [t, loc.available[t]])),
    { parallax: true, coldstart: true, "hollow-test": false, "behavior-diff": false, preflight: false }
  );
});

test("no dirs anywhere → mode npx with all tools optimistically available", () => {
  const { packageRoot, targetRoot } = isolatedRoots();
  const loc = locateAdlc({ env: {}, packageRoot, targetRoot });
  assert.equal(loc.mode, "npx");
  assert.equal(loc.dir, null);
  for (const t of ADLC_TOOLS) assert.equal(loc.available[t], true, t);
  assert.equal(loc.available["skill-mining"], true);
  assert.equal(loc.skillMining.mode, "npx");
});

test("DOBETTER_NO_NPX disables the npx fallback → mode absent, all unavailable", () => {
  const { packageRoot, targetRoot } = isolatedRoots();
  const loc = locateAdlc({ env: { DOBETTER_NO_NPX: "1" }, packageRoot, targetRoot });
  assert.equal(loc.mode, "absent");
  assert.equal(loc.dir, null);
  for (const t of [...ADLC_TOOLS, "skill-mining"]) assert.equal(loc.available[t], false, t);
});

test("invalid env dir warns and continues the probe (empty tmpdir → absent)", () => {
  const loc = locateDir(tmpdir("dobetter-empty-"));
  assert.equal(loc.mode, "absent");
});

test("skill-mining is located separately via DOBETTER_SKILL_MINING_DIR", () => {
  const smDir = makeSkillMiningDir();
  const { packageRoot, targetRoot } = isolatedRoots();
  const loc = locateAdlc({
    env: { DOBETTER_NO_NPX: "1", DOBETTER_SKILL_MINING_DIR: smDir },
    packageRoot,
    targetRoot,
  });
  assert.equal(loc.mode, "absent"); // adlc itself absent
  assert.equal(loc.available["skill-mining"], true);
  assert.deepEqual(loc.skillMining, { mode: "dir", dir: smDir });
});

// ── runAdlcTool ──────────────────────────────────────────────────────────────

test("exit-code interpretation: 0 pass / 1 could-not-run / 2 gate failed", () => {
  const loc = locateDir(makeAdlcDir(["parallax"]));
  const cases = [
    { exit: "0", ok: true, gateFailed: false, opError: false },
    { exit: "1", ok: false, gateFailed: false, opError: true },
    { exit: "2", ok: false, gateFailed: true, opError: false },
  ];
  for (const c of cases) {
    const r = runAdlcTool(loc, "parallax", ["--json"], {
      exec: execWithEnv({ FAKE_EXIT: c.exit, FAKE_STDOUT: '{"x":1}' }),
    });
    assert.equal(r.skipped, false);
    assert.equal(r.ok, c.ok, `exit ${c.exit} ok`);
    assert.equal(r.gateFailed, c.gateFailed, `exit ${c.exit} gateFailed`);
    assert.equal(r.opError, c.opError, `exit ${c.exit} opError`);
    assert.equal(r.exitCode, Number(c.exit));
    assert.deepEqual(r.json, { x: 1 });
  }
});

test("garbage stdout with --json → json:null + opError:true even on exit 0", () => {
  const loc = locateDir(makeAdlcDir(["preflight"]));
  const r = runAdlcTool(loc, "preflight", ["--json"], {
    exec: execWithEnv({ FAKE_EXIT: "0", FAKE_STDOUT: "definitely not json" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.json, null);
  assert.equal(r.opError, true);
});

test("without --json no parse is attempted (json:null, no opError)", () => {
  const loc = locateDir(makeAdlcDir(["preflight"]));
  const r = runAdlcTool(loc, "preflight", [], {
    exec: execWithEnv({ FAKE_EXIT: "0", FAKE_STDOUT: "human readable report" }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.json, null);
  assert.equal(r.opError, false);
  assert.match(r.stdout, /human readable report/);
});

test("absent tool → { skipped:true, reason } — never throws for absence", () => {
  const loc = locateDir(makeAdlcDir(["parallax"]));
  const r = runAdlcTool(loc, "hollow-test", ["--json"], { exec: execWithEnv() });
  assert.deepEqual(r, { skipped: true, reason: "not installed" });
});

test("unknown tool name and malformed args are caller bugs → OpError", () => {
  const loc = locateDir(makeAdlcDir(["parallax"]));
  assert.throws(() => runAdlcTool(loc, "skill-rot", []), OpError);
  assert.throws(() => runAdlcTool(loc, "parallax", [42]), OpError);
});

test("dir-mode spawn shape: node <dir>/packages/<name>/bin/<name>.mjs …args", () => {
  const adlcDir = makeAdlcDir(["coldstart"]);
  const loc = locateDir(adlcDir);
  const calls = [];
  const stubExec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: "{}", stderr: "" };
  };
  runAdlcTool(loc, "coldstart", ["--all", "--json"], { exec: stubExec, cwd: "/some/repo" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, [
    path.join(adlcDir, "packages", "coldstart", "bin", "coldstart.mjs"),
    "--all",
    "--json",
  ]);
  assert.equal(calls[0].opts.cwd, "/some/repo");
  assert.equal(calls[0].opts.timeout, 600000);
});

test("npx mode spawns npx --yes @adlc/<name>; resolve failure flips availability", () => {
  const { packageRoot, targetRoot } = isolatedRoots();
  const loc = locateAdlc({ env: {}, packageRoot, targetRoot });
  assert.equal(loc.mode, "npx");

  const calls = [];
  const failingNpx = (cmd, args) => {
    calls.push({ cmd, args });
    return {
      status: 1,
      stdout: "",
      stderr: "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@adlc%2fparallax",
    };
  };
  const r = runAdlcTool(loc, "parallax", ["--json"], { exec: failingNpx });
  assert.equal(calls[0].cmd, "npx");
  assert.deepEqual(calls[0].args.slice(0, 2), ["--yes", "@adlc/parallax"]);
  assert.equal(r.skipped, true);
  assert.match(r.reason, /npx/);
  assert.equal(loc.available.parallax, false);
  // session flip: second attempt short-circuits to "not installed"
  const r2 = runAdlcTool(loc, "parallax", ["--json"], { exec: failingNpx });
  assert.deepEqual(r2, { skipped: true, reason: "not installed" });
  assert.equal(calls.length, 1);
});

// ── wrappers ─────────────────────────────────────────────────────────────────

test("runParallax builds the exact argv (--file form) and maps gate from exit 0", () => {
  const loc = locateDir(makeAdlcDir(["parallax"]));
  const r = runParallax(loc, { file: "packet.md", exec: execWithEnv({ FAKE_ECHO_ARGS: "1" }) });
  assert.equal(r.skipped, false);
  assert.equal(r.gate, true);
  assert.deepEqual(r.raw.argv, ["--file", "packet.md", "--n", "3", "--threshold", "0.25", "--json"]);
});

test("runParallax --request form with n/threshold overrides", () => {
  const loc = locateDir(makeAdlcDir(["parallax"]));
  const r = runParallax(loc, { request: "ambiguous?", n: 5, threshold: 0.4, exec: execWithEnv({ FAKE_ECHO_ARGS: "1" }) });
  assert.deepEqual(r.raw.argv, ["--request", "ambiguous?", "--n", "5", "--threshold", "0.4", "--json"]);
  assert.throws(() => runParallax(loc, {}), OpError);
});

test("runParallax maps score/agreements/divergences; exit 2 → gate false", () => {
  const loc = locateDir(makeAdlcDir(["parallax"]));
  const payload = JSON.stringify({
    score: 0.4,
    agreements: ["a"],
    divergences: [{ claim: "x" }],
    gate: false,
  });
  const r = runParallax(loc, { file: "p.md", exec: execWithEnv({ FAKE_EXIT: "2", FAKE_STDOUT: payload }) });
  assert.equal(r.gate, false);
  assert.equal(r.score, 0.4);
  assert.deepEqual(r.agreements, ["a"]);
  assert.equal(r.divergences.length, 1);
});

test("runParallax exit 1 (e.g. no API key) is treated as absent — degrade row", () => {
  const loc = locateDir(makeAdlcDir(["parallax"]));
  const r = runParallax(loc, {
    file: "p.md",
    exec: execWithEnv({ FAKE_EXIT: "1", FAKE_STDERR: "no API key configured" }),
  });
  assert.equal(r.skipped, true);
  assert.match(r.reason, /exit 1/);
  assert.match(r.reason, /no API key/);
});

test("runColdstart argv (--all and single-ticket forms) and results mapping", () => {
  const loc = locateDir(makeAdlcDir(["coldstart"]));
  const echo = execWithEnv({ FAKE_ECHO_ARGS: "1" });

  const all = runColdstart(loc, { ticketsPath: ".dobetter/backlog/tickets.json", exec: echo });
  assert.deepEqual(all.raw.argv, ["--all", "--tickets", ".dobetter/backlog/tickets.json", "--json"]);

  const one = runColdstart(loc, { ticketsPath: "t.json", all: false, ticketId: "T3", exec: echo });
  assert.deepEqual(one.raw.argv, ["T3", "--tickets", "t.json", "--json"]);

  const payload = JSON.stringify({
    ok: false,
    results: [{ id: "T1", pass: false, gaps: [{ what: "missing shape", why_blocking: "no contract" }] }],
  });
  const gapped = runColdstart(loc, {
    ticketsPath: "t.json",
    exec: execWithEnv({ FAKE_EXIT: "2", FAKE_STDOUT: payload }),
  });
  assert.equal(gapped.ok, false);
  assert.equal(gapped.results.length, 1);
  assert.equal(gapped.results[0].gaps[0].what, "missing shape");

  const noKey = runColdstart(loc, { ticketsPath: "t.json", exec: execWithEnv({ FAKE_EXIT: "1", FAKE_STDERR: "no key" }) });
  assert.equal(noKey.skipped, true);

  assert.throws(() => runColdstart(loc, {}), OpError);
  assert.throws(() => runColdstart(loc, { ticketsPath: "t.json", all: false }), OpError);
});

test("runHollowTest argv + summary/mutants mapping (incl. defaults)", () => {
  const loc = locateDir(makeAdlcDir(["hollow-test"]));
  const echo = runHollowTest(loc, {
    testCmd: "npm test",
    base: "abc1234",
    exec: execWithEnv({ FAKE_ECHO_ARGS: "1" }),
  });
  assert.deepEqual(echo.raw.argv, ["--test-cmd", "npm test", "--base", "abc1234", "--max", "20", "--json"]);

  const payload = JSON.stringify({
    summary: { total: 5, killed: 4, survived: 1 },
    mutants: [{ file: "a.js", line: 3, status: "survived" }],
  });
  const r = runHollowTest(loc, {
    testCmd: "npm test",
    base: "abc1234",
    max: 7,
    exec: execWithEnv({ FAKE_EXIT: "2", FAKE_STDOUT: payload }),
  });
  assert.equal(r.gateFailed, true);
  assert.deepEqual(r.summary, { total: 5, killed: 4, survived: 1 });
  assert.equal(r.mutants.length, 1);

  const sparse = runHollowTest(loc, {
    testCmd: "npm test",
    base: "abc1234",
    exec: execWithEnv({ FAKE_STDOUT: "{}" }),
  });
  assert.deepEqual(sparse.summary, { total: 0, killed: 0, survived: 0 });
  assert.deepEqual(sparse.mutants, []);

  assert.throws(() => runHollowTest(loc, { base: "x" }), OpError);
  assert.throws(() => runHollowTest(loc, { testCmd: "x" }), OpError);
});

test("runBehaviorDiff validates the verb and passes args through", () => {
  const loc = locateDir(makeAdlcDir(["behavior-diff"]));
  const r = runBehaviorDiff(loc, "capture", ["--config", "b.json", "--out", "snap.json", "--json"], {
    exec: execWithEnv({ FAKE_ECHO_ARGS: "1" }),
  });
  assert.deepEqual(r.json.argv, ["capture", "--config", "b.json", "--out", "snap.json", "--json"]);
  assert.equal(r.ok, true);
  assert.throws(() => runBehaviorDiff(loc, "diff", []), OpError);
});

test("runPreflight argv with/without testCmd and verdict mapping", () => {
  const loc = locateDir(makeAdlcDir(["preflight"]));
  const echo = execWithEnv({ FAKE_ECHO_ARGS: "1" });
  assert.deepEqual(runPreflight(loc, { exec: echo }).raw.argv, ["--json"]);
  assert.deepEqual(runPreflight(loc, { testCmd: "npm test", exec: echo }).raw.argv, [
    "--json",
    "--test-cmd",
    "npm test",
  ]);

  const payload = JSON.stringify({
    checks: [{ name: "git", status: "pass" }, { name: "tests", status: "fail" }],
    verdict: "fail",
    failedNames: ["tests"],
  });
  const r = runPreflight(loc, { exec: execWithEnv({ FAKE_EXIT: "2", FAKE_STDOUT: payload }) });
  assert.equal(r.gateFailed, true);
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.failedNames, ["tests"]);
  assert.equal(r.checks.length, 2);
});

test("runSkillMining dir mode spawns bin/cli.js mine <target> [--offline]", () => {
  const smDir = makeSkillMiningDir();
  const { packageRoot, targetRoot } = isolatedRoots();
  const loc = locateAdlc({
    env: { DOBETTER_NO_NPX: "1", DOBETTER_SKILL_MINING_DIR: smDir },
    packageRoot,
    targetRoot,
  });
  const calls = [];
  const stubExec = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: "mined 2 skills", stderr: "" };
  };
  const r = runSkillMining(loc, { targetDir: "/repo", offline: true, exec: stubExec });
  assert.equal(r.skipped, false);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, "mined 2 skills");
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, [path.join(smDir, "bin", "cli.js"), "mine", "/repo", "--offline"]);
});

test("runSkillMining is skipped when skill-mining is absent", () => {
  const { packageRoot, targetRoot } = isolatedRoots();
  const loc = locateAdlc({ env: { DOBETTER_NO_NPX: "1" }, packageRoot, targetRoot });
  assert.deepEqual(runSkillMining(loc, { targetDir: "/repo" }), { skipped: true, reason: "not installed" });
  assert.throws(() => runSkillMining(loc, {}), OpError);
});

test("graceful-degradation surface: every wrapper reports skipped for absent tools", () => {
  const { packageRoot, targetRoot } = isolatedRoots();
  const loc = locateAdlc({ env: { DOBETTER_NO_NPX: "1" }, packageRoot, targetRoot });
  const results = [
    runParallax(loc, { file: "p.md" }),
    runColdstart(loc, { ticketsPath: "t.json" }),
    runHollowTest(loc, { testCmd: "npm test", base: "abc" }),
    runBehaviorDiff(loc, "compare", ["a.json", "b.json", "--json"]),
    runPreflight(loc, {}),
    runSkillMining(loc, { targetDir: "/repo" }),
  ];
  for (const r of results) {
    assert.equal(r.skipped, true);
    assert.equal(typeof r.reason, "string");
  }
});
