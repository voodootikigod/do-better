import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpError } from "../src/utils.js";
import {
  PHASES,
  STATE_VERSION,
  addSpend,
  beginRun,
  defaultState,
  finishRun,
  loadState,
  nextFindingId,
  nextIncompletePhase,
  pinSha,
  recordPhase,
  recordRoadmapHash,
  remainingBudgetUSD,
  saveState,
  setGate,
} from "../src/state.js";

const NOW = "2026-06-12T00:00:00.000Z";
const SHA = "a".repeat(40);

function fresh() {
  return defaultState({ headSha: SHA, now: NOW });
}

function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") deepFreeze(v);
  }
  return Object.freeze(obj);
}

// --- schema -------------------------------------------------------------------

test("defaultState matches the §3 schema exactly (golden keys)", () => {
  const s = fresh();
  assert.deepEqual(Object.keys(s).sort(), [
    "adlc",
    "budget",
    "counters",
    "createdAt",
    "gates",
    "phases",
    "pins",
    "roadmapHistory",
    "runs",
    "target",
    "tool",
    "version",
  ]);
  assert.equal(s.version, STATE_VERSION);
  assert.deepEqual(s.tool, { name: "do-better", version: "0.1.0" });
  assert.deepEqual(s.target, { root: ".", headSha: SHA });
  assert.deepEqual(Object.keys(s.pins), PHASES);
  assert.deepEqual(Object.keys(s.phases), PHASES);

  for (const phase of PHASES) {
    const p = s.phases[phase];
    assert.equal(p.status, "pending");
    assert.equal(p.completedAt, null);
    assert.equal(p.sha, null);
    assert.deepEqual(p.spend, { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 });
  }
  assert.equal(s.phases.scan.facts, null);
  assert.equal(s.phases.comprehend.divergence, null);
  assert.equal(s.phases.comprehend.readings, null);
  assert.deepEqual(s.phases.identify.passesByDimension, {});
  assert.equal(s.phases.identify.killed, 0);
  assert.equal(s.phases.identify.verified, 0);
  assert.equal(s.phases.roadmap.ticketCount, 0);
  assert.equal(s.phases.roadmap.declinedCount, 0);
  assert.equal(s.phases.rail.railsAuthored, 0);
  assert.equal(s.phases.refresh.changedFiles, 0);

  assert.deepEqual(Object.keys(s.gates), ["charter", "comprehend", "identify", "roadmap", "rail"]);
  assert.deepEqual(s.gates.charter, { approved: false, approvedAt: null, charterSha256: null });
  assert.deepEqual(s.gates.comprehend, { passed: false, divergence: null, threshold: 0.25, degraded: null });
  assert.deepEqual(s.gates.identify, { passed: false, dryPassesByDimension: {}, unverified: 0 });
  assert.deepEqual(s.gates.roadmap, {
    approved: false,
    approvedAt: null,
    coldstartClean: false,
    coldstartDegraded: null,
    roadmapSha256: null,
  });
  assert.deepEqual(s.gates.rail, {
    passed: false,
    railsGreen: false,
    hollowAudited: false,
    hollowSurvivors: 0,
    preflight: null,
  });

  assert.deepEqual(s.budget, { limitUSD: null, spentUSD: 0 });
  assert.deepEqual(s.runs, []);
  assert.deepEqual(s.roadmapHistory, []);
  assert.deepEqual(Object.keys(s.counters.findings), [
    "correctness",
    "security",
    "maintainability",
    "performance",
    "operability",
    "test-quality",
    "dependency-health",
    "dx",
  ]);
  assert.equal(s.counters.tickets, 0);
  assert.deepEqual(s.adlc.available, {
    parallax: false,
    coldstart: false,
    "hollow-test": false,
    "behavior-diff": false,
    preflight: false,
    "skill-mining": false,
  });
});

// --- spend --------------------------------------------------------------------

test("addSpend keeps the invariant: sum of phase costUSD === budget.spentUSD", () => {
  let s = fresh();
  s = addSpend(s, "scan", { calls: 2, tokensIn: 100, tokensOut: 50, costUSD: 0.5 });
  s = addSpend(s, "charter", { calls: 1, tokensIn: 10, tokensOut: 5, costUSD: 0.25 });
  s = addSpend(s, "scan", { calls: 1, tokensIn: 1, tokensOut: 1, costUSD: 0.125 });
  assert.equal(s.phases.scan.spend.calls, 3);
  assert.equal(s.phases.scan.spend.costUSD, 0.625);
  assert.equal(s.phases.charter.spend.costUSD, 0.25);
  const sum = Object.values(s.phases).reduce((acc, p) => acc + p.spend.costUSD, 0);
  assert.equal(sum, s.budget.spentUSD);
  assert.equal(s.budget.spentUSD, 0.875);
});

test("remainingBudgetUSD: null when unlimited, difference otherwise", () => {
  let s = fresh();
  assert.equal(remainingBudgetUSD(s), null);
  s = structuredClone(s);
  s.budget.limitUSD = 10;
  s = addSpend(s, "scan", { costUSD: 3 });
  assert.equal(remainingBudgetUSD(s), 7);
});

// --- immutability ------------------------------------------------------------

test("all state functions are pure (frozen input never mutated)", () => {
  const s = deepFreeze(fresh());
  assert.doesNotThrow(() => addSpend(s, "scan", { calls: 1, costUSD: 1 }));
  assert.doesNotThrow(() => recordPhase(s, "scan", { status: "done", sha: SHA, now: NOW }));
  assert.doesNotThrow(() => setGate(s, "charter", { approved: true }));
  assert.doesNotThrow(() => pinSha(s, "scan", SHA));
  assert.doesNotThrow(() => beginRun(s, { command: "scan", now: NOW }));
  assert.doesNotThrow(() => nextFindingId(s, "security"));
  assert.doesNotThrow(() => recordRoadmapHash(s, { sha256: "x", headSha: SHA, now: NOW }));
  // and the original is untouched
  assert.equal(s.budget.spentUSD, 0);
  assert.equal(s.phases.scan.status, "pending");
});

// --- runs ----------------------------------------------------------------------

test("beginRun/finishRun: history, ok flag, spend delta", () => {
  let { state: s, runId } = beginRun(fresh(), {
    command: "run",
    provider: "anthropic",
    headSha: SHA,
    now: NOW,
  });
  assert.equal(s.runs.length, 1);
  assert.equal(runId, "run-2026-06-12T00-00-00");
  assert.equal(s.runs[0].command, "run");
  assert.equal(s.runs[0].provider, "anthropic");
  assert.equal(s.runs[0].finishedAt, null);
  assert.equal(s.runs[0].ok, null);

  s = addSpend(s, "scan", { costUSD: 0.5 });
  s = finishRun(s, runId, { now: "2026-06-12T01:00:00.000Z", ok: true });
  const run = s.runs[0];
  assert.equal(run.ok, true);
  assert.equal(run.finishedAt, "2026-06-12T01:00:00.000Z");
  assert.equal(run.spendUSD, 0.5);
  assert.throws(() => finishRun(s, "run-nope", { ok: true }), OpError);
});

test("runs are capped at 50 (oldest dropped) and ids deduped", () => {
  let s = fresh();
  let firstId = null;
  for (let i = 0; i < 55; i++) {
    const now = new Date(Date.UTC(2026, 5, 12, 0, 0, i)).toISOString();
    const r = beginRun(s, { command: "scan", now });
    s = r.state;
    if (i === 0) firstId = r.runId;
  }
  assert.equal(s.runs.length, 50);
  assert.equal(new Set(s.runs.map((r) => r.id)).size, 50);
  assert.ok(!s.runs.some((r) => r.id === firstId));
});

// --- phases / gates / pins ------------------------------------------------------

test("recordPhase stamps status, sha and headSha; validates input", () => {
  let s = fresh();
  s = recordPhase(s, "scan", { status: "done", sha: "b".repeat(40), now: NOW, facts: { fileCount: 7 } });
  assert.equal(s.phases.scan.status, "done");
  assert.equal(s.phases.scan.completedAt, NOW);
  assert.equal(s.phases.scan.sha, "b".repeat(40));
  assert.equal(s.target.headSha, "b".repeat(40));
  assert.deepEqual(s.phases.scan.facts, { fileCount: 7 });
  assert.throws(() => recordPhase(s, "nope", { status: "done" }), OpError);
  assert.throws(() => recordPhase(s, "scan", { status: "great" }), OpError);
});

test("setGate merges patches and rejects unknown gates", () => {
  let s = fresh();
  s = setGate(s, "comprehend", { passed: true, divergence: 0.1 });
  assert.equal(s.gates.comprehend.passed, true);
  assert.equal(s.gates.comprehend.divergence, 0.1);
  assert.equal(s.gates.comprehend.threshold, 0.25); // untouched
  assert.throws(() => setGate(s, "nope", {}), OpError);
});

test("pinSha records per-phase pins", () => {
  const s = pinSha(fresh(), "comprehend", SHA);
  assert.equal(s.pins.comprehend, SHA);
  assert.equal(s.pins.scan, null);
});

// --- finding ids ---------------------------------------------------------------

test("nextFindingId formats and increments per dimension", () => {
  let s = fresh();
  let r = nextFindingId(s, "security");
  assert.equal(r.id, "F-SECU-0001");
  r = nextFindingId(r.state, "security");
  assert.equal(r.id, "F-SECU-0002");
  assert.equal(r.state.counters.findings.security, 2);
  assert.equal(nextFindingId(s, "dx").id, "F-DX-0001");
  assert.equal(nextFindingId(s, "test-quality").id, "F-TEST-0001");
  // unknown (charter extra) dimensions get their own counter
  assert.equal(nextFindingId(s, "compliance").id, "F-COMP-0001");
  assert.throws(() => nextFindingId(s, ""), OpError);
});

// --- roadmap history -------------------------------------------------------------

test("recordRoadmapHash appends and dedupes consecutive", () => {
  let s = fresh();
  s = recordRoadmapHash(s, { sha256: "h1", headSha: SHA, now: NOW });
  s = recordRoadmapHash(s, { sha256: "h1", headSha: SHA, now: NOW });
  assert.equal(s.roadmapHistory.length, 1);
  s = recordRoadmapHash(s, { sha256: "h2", headSha: SHA, now: NOW });
  assert.equal(s.roadmapHistory.length, 2);
  assert.deepEqual(s.roadmapHistory[1], { sha256: "h2", headSha: SHA, generatedAt: NOW });
});

// --- resume pointer --------------------------------------------------------------

test("nextIncompletePhase truth table", () => {
  let s = fresh();
  assert.equal(nextIncompletePhase(s), "scan");

  s = recordPhase(s, "scan", { status: "done", sha: SHA, now: NOW });
  assert.equal(nextIncompletePhase(s), "charter");

  // charter drafted (status done) but NOT approved → still charter
  s = recordPhase(s, "charter", { status: "done", sha: SHA, now: NOW });
  assert.equal(nextIncompletePhase(s), "charter");

  // charter complete ⇔ gates.charter.approved
  s = setGate(s, "charter", { approved: true, approvedAt: NOW });
  assert.equal(nextIncompletePhase(s), "comprehend");

  // comprehend done but gate not passed → still comprehend
  s = recordPhase(s, "comprehend", { status: "done", sha: SHA, now: NOW });
  assert.equal(nextIncompletePhase(s), "comprehend");
  s = setGate(s, "comprehend", { passed: true });
  assert.equal(nextIncompletePhase(s), "identify");

  s = recordPhase(s, "identify", { status: "done", sha: SHA, now: NOW });
  s = setGate(s, "identify", { passed: true });
  assert.equal(nextIncompletePhase(s), "roadmap");

  // roadmap requires approved AND coldstartClean
  s = recordPhase(s, "roadmap", { status: "done", sha: SHA, now: NOW });
  s = setGate(s, "roadmap", { approved: true });
  assert.equal(nextIncompletePhase(s), "roadmap");
  s = setGate(s, "roadmap", { coldstartClean: true });
  assert.equal(nextIncompletePhase(s), "rail");

  s = recordPhase(s, "rail", { status: "done", sha: SHA, now: NOW });
  assert.equal(nextIncompletePhase(s), "rail");
  s = setGate(s, "rail", { passed: true });
  assert.equal(nextIncompletePhase(s), null);
});

// --- persistence -----------------------------------------------------------------

test("saveState/loadState round-trip", (t) => {
  const dotdir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-state-"));
  t.after(() => fs.rmSync(dotdir, { recursive: true, force: true }));
  const s = addSpend(fresh(), "scan", { calls: 1, costUSD: 0.1 });
  saveState(dotdir, s);
  const raw = fs.readFileSync(path.join(dotdir, "state.json"), "utf8");
  assert.ok(raw.endsWith("\n"));
  const { state: loaded, existed } = loadState(dotdir);
  assert.equal(existed, true);
  assert.deepEqual(loaded, s);
});

test("loadState: missing → {state:null, existed:false}", (t) => {
  const dotdir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-state-"));
  t.after(() => fs.rmSync(dotdir, { recursive: true, force: true }));
  assert.deepEqual(loadState(dotdir), { state: null, existed: false });
});

test("loadState rejects corrupt JSON and wrong versions with remediation", (t) => {
  const dotdir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-state-"));
  t.after(() => fs.rmSync(dotdir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dotdir, "state.json"), "{nope");
  assert.throws(() => loadState(dotdir), /delete .dobetter\/state.json/i);
  fs.writeFileSync(path.join(dotdir, "state.json"), JSON.stringify({ version: 99 }));
  assert.throws(() => loadState(dotdir), /version 99/);
});
