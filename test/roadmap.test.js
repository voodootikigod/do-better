import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { OpError, GateError } from "../src/utils.js";
import { defaultState, setGate } from "../src/state.js";
import { LAYOUT, writeArtifact, readArtifact, writeFinding, readTickets, validateTicket } from "../src/artifacts.js";
import {
  PHASE_ID, run, approve, scoreItem, applyCharterWeight, sequence,
  shellSplit, rerunReproduction, markRoadmapResolved,
} from "../src/roadmap.js";

// ---------- inline fixture helpers (per blueprint §8: helpers live inline) ----------

function realExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function makeRepo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-roadmap-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const g = (args) => realExec("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
  g(["init", "-q"]);
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  return root;
}

const headOf = (root) => realExec("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

function makeFakeLLM(script = {}) {
  const calls = [];
  const llm = {
    offline: false,
    provider: "fake",
    models: { cheap: "c", mid: "m", frontier: "f" },
    calls,
    async call(prompt, opts = {}) {
      const label = opts.label ?? "LLM";
      calls.push({ label, tier: opts.tier, jsonMode: Boolean(opts.jsonMode), prompt });
      const entry = script[label];
      let resp = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
      if (resp === undefined) resp = opts.jsonMode ? "{}" : "";
      return typeof resp === "string" ? resp : JSON.stringify(resp);
    },
    async callJson(prompt, opts = {}) {
      return JSON.parse(await llm.call(prompt, { ...opts, jsonMode: true }));
    },
    drainSpend() { return { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 }; },
    estimateTokens: (t) => Math.ceil(String(t ?? "").length / 4),
  };
  return llm;
}

// Routes adlc tool spawns (process.execPath .../packages/<name>/bin/<name>.mjs) to
// scripted results; everything else falls through to real spawnSync (git, node --test).
function makeCtxExec(adlcScript = {}) {
  return (cmd, args, opts) => {
    if (cmd === process.execPath && typeof args?.[0] === "string") {
      const m = args[0].match(/[\\/]packages[\\/]([^\\/]+)[\\/]bin[\\/]/);
      if (m && adlcScript[m[1]]) {
        const entry = adlcScript[m[1]];
        const resp = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
        const r = typeof resp === "function" ? resp(args) : resp;
        return {
          status: r.status ?? 0,
          stdout: typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout ?? {}),
          stderr: r.stderr ?? "",
        };
      }
    }
    return realExec(cmd, args, opts);
  };
}

// Real adlc.js verifies bin existence with existsSync before spawning, so the fake
// location must contain real placeholder files; spawns are intercepted by makeCtxExec.
function makeAdlcDir(available) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-fakeadlc-"));
  for (const [name, ok] of Object.entries(available)) {
    if (!ok || name === "skill-mining") continue;
    const bin = path.join(dir, "packages", name, "bin", `${name}.mjs`);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "// placeholder fake-adlc bin — spawns intercepted by the test exec\n");
  }
  return dir;
}

function makeCtx(root, { state, llm, adlcAvailable = {}, adlcScript = {}, flags = {} } = {}) {
  const dotdir = path.join(root, ".dobetter");
  fs.mkdirSync(dotdir, { recursive: true });
  return {
    root,
    dotdir,
    state,
    llm: llm ?? makeFakeLLM(),
    adlc: (() => {
      const available = {
        parallax: false, coldstart: false, "hollow-test": false,
        "behavior-diff": false, preflight: false, "skill-mining": false,
        ...adlcAvailable,
      };
      return { mode: "dir", dir: makeAdlcDir(available), available };
    })(),
    flags: { command: PHASE_ID, target: root, provider: null, budget: null, offline: false, approve: false, yes: false, json: false, help: false, ...flags },
    log: { info() {}, success() {}, warn() {}, error() {}, phase() {}, gate() {}, step() {}, substep() {}, errorTrace() {} },
    now: () => "2026-06-12T00:00:00.000Z",
    exec: makeCtxExec(adlcScript),
    ask: null,
  };
}

function seedState(root, mutate) {
  let state = defaultState({ headSha: headOf(root), now: "2026-06-12T00:00:00.000Z" });
  state = setGate(state, "charter", { approved: true });
  state = setGate(state, "comprehend", { passed: true });
  state = setGate(state, "identify", { passed: true });
  return mutate ? mutate(state) : state;
}

function seedCharter(dotdir, weights = {}) {
  writeArtifact(dotdir, LAYOUT.charter, {
    meta: {
      approved: true,
      intent: "stabilize",
      weights: {
        correctness: 3, security: 3, maintainability: 3, performance: 3,
        operability: 3, "test-quality": 3, "dependency-health": 3, dx: 3,
        ...weights,
      },
    },
    body: "# Charter\n",
  });
}

function finding(root, id, dimension, overrides = {}) {
  const sha = headOf(root).slice(0, 7);
  return {
    id,
    dimension,
    title: overrides.title ?? `Issue ${id}`,
    severity: overrides.severity ?? "high",
    confidence: overrides.confidence ?? 0.9,
    evidence: overrides.evidence ?? [{ file: "src/util.js", line: 1, sha }],
    reproduction: overrides.reproduction ?? { method: "command", record: 'node -e "process.exit(0)"', exitCode: 0 },
    status: "verified",
    foundAt: "2026-06-12T00:00:00.000Z",
    headSha: headOf(root),
    stale: false,
  };
}

const FIXTURE_FILES = { "src/util.js": "export function add(a, b) { return a + b; }\n", "package.json": '{ "name": "fixture", "type": "module" }\n' };

const TICKET_JSON = (title) => ({
  title,
  body: "## Motivation\nSee linked finding file for evidence.\n\n## Acceptance Criteria\n- [ ] Repro command exits clean — verification: a command whose output is asserted.\n\n## Partition hints\n- Cited files only.",
  scope: ["src/**"],
  rails: [],
  edges: [],
  duration: 4,
  category: "security",
});

// ---------- pure unit tests ----------

test("scoreItem: impact × confidence ÷ effort with t-shirt mapping", () => {
  assert.equal(scoreItem({ impact: "L", confidence: 0.8, effort: "M" }), (3 * 0.8) / 2);
  assert.equal(scoreItem({ impact: "XL", confidence: 1, effort: "S" }), 5);
  assert.equal(scoreItem({ impact: "S", confidence: 0.5, effort: "XL" }), 0.1);
  assert.throws(() => scoreItem({ impact: "XXL", confidence: 0.5, effort: "M" }), OpError);
  assert.throws(() => scoreItem({ impact: "M", confidence: 2, effort: "M" }), OpError);
});

test("applyCharterWeight multiplies by weight/3 (default weight 3)", () => {
  assert.equal(applyCharterWeight(1.2, "security", { security: 5 }), 2);
  assert.equal(applyCharterWeight(1.2, "dx", {}), 1.2);
});

test("sequence: topo order, Phase-0 first, quick wins front-loaded, score bands", () => {
  const items = [
    { id: "A", score: 2.0, effort: "S", dependsOn: [] },
    { id: "B", score: 1.2, effort: "L", dependsOn: ["A"] },
    { id: "C", score: 0.6, effort: "M", dependsOn: [] },
    { id: "D", score: 0.2, effort: "M", dependsOn: [] },
    { id: "E", score: 0.4, effort: "M", dependsOn: [], phase0: true },
  ];
  const seq = sequence(items);
  assert.deepEqual(seq.map((i) => i.id), ["E", "A", "B", "C", "D"]);
  assert.equal(seq[0].phase, "phase0");
  assert.equal(seq.find((i) => i.id === "A").quickWin, true);
  assert.equal(seq.find((i) => i.id === "A").phase, "now");
  assert.equal(seq.find((i) => i.id === "B").phase, "now");
  assert.equal(seq.find((i) => i.id === "C").phase, "next");
  assert.equal(seq.find((i) => i.id === "D").phase, "later");
  assert.ok(seq.findIndex((i) => i.id === "A") < seq.findIndex((i) => i.id === "B"), "dependency order");
});

test("sequence: dependency feasibility demotes items behind their deps", () => {
  const seq = sequence([
    { id: "X", score: 0.6, effort: "M", dependsOn: [] },          // next
    { id: "Y", score: 2.0, effort: "M", dependsOn: ["X"] },       // would be now, demoted to next
  ]);
  assert.equal(seq.find((i) => i.id === "Y").phase, "next");
});

test("sequence: cycles are broken at the lowest-score edge and flagged", () => {
  const seq = sequence([
    { id: "P", score: 1.5, effort: "M", dependsOn: ["Q"] },
    { id: "Q", score: 1.0, effort: "M", dependsOn: ["P"] },
  ]);
  assert.equal(seq.length, 2);
  assert.ok(seq.some((i) => i.cycleBroken), "one cycle-broken item flagged");
  assert.ok(seq.some((i) => i.cycleBroken && i.id === "Q"), "lowest-score item loses its edge");
});

test("shellSplit handles quoted segments", () => {
  assert.deepEqual(shellSplit('node -e "process.exit(0)"'), ["node", "-e", "process.exit(0)"]);
  assert.throws(() => shellSplit('node -e "oops'), OpError);
});

test("rerunReproduction matches recorded exit code", () => {
  const root = makeRepo(FIXTURE_FILES);
  const exec = makeCtxExec();
  const f = (record, exitCode) => ({ reproduction: { method: "command", record, exitCode } });
  assert.equal(rerunReproduction(root, f('node -e "process.exit(0)"', 0), exec).reproduced, true);
  assert.equal(rerunReproduction(root, f('node -e "process.exit(2)"', 0), exec).reproduced, false);
  assert.equal(rerunReproduction(root, { reproduction: { method: "reread", record: "x" } }, exec).reproduced, null);
});

test("rerunReproduction re-runs persisted argv and check specs (D6/D9)", () => {
  const root = makeRepo(FIXTURE_FILES);
  const exec = makeCtxExec();
  const cmd = (argv, exitCode) => ({ reproduction: { method: "command", record: "$ node -e <snippet>\nexit 0", exitCode, cmd: argv } });
  assert.equal(rerunReproduction(root, cmd(["node", "-e", "process.exit(0)"], 0), exec).reproduced, true);
  assert.equal(rerunReproduction(root, cmd(["node", "-e", "process.exit(3)"], 0), exec).reproduced, false);
  const chk = (pattern) => ({ reproduction: { method: "static", record: "human text", exitCode: null, check: { type: "regex", pattern, file: "src/util.js" } } });
  assert.equal(rerunReproduction(root, chk("\\badd\\b"), exec).reproduced, true, "marker still present → still reproduces");
  assert.equal(rerunReproduction(root, chk("ZZZ_GONE"), exec).reproduced, false, "marker gone → no longer reproduces");
  assert.equal(
    rerunReproduction(root, { reproduction: { method: "static", record: "x", exitCode: null, check: { type: "mystery" } } }, exec).reproduced,
    null,
    "unknown check type is unknowable — never resolved",
  );
});

test("rerunReproduction: human-readable records are unknowable (null), never falsely resolved", () => {
  const root = makeRepo(FIXTURE_FILES);
  const exec = makeCtxExec();
  const f = (record, method = "command", exitCode = 0) => ({ reproduction: { method, record, exitCode } });
  // the exact record formats identify.js used to persist — none are runnable commands
  assert.equal(rerunReproduction(root, f("$ node --test test/x.test.js\nexit 0\nok"), exec).reproduced, null);
  assert.equal(rerunReproduction(root, f("native grep /TODO/ in src/util.js: matched"), exec).reproduced, null);
  assert.equal(rerunReproduction(root, f("static-check no-readme: README.md absent", "static", null), exec).reproduced, null);
  // a spawn failure (status < 0) is unknowable too
  const enoentExec = () => ({ status: -1, stdout: "", stderr: "spawn ENOENT" });
  assert.equal(rerunReproduction(root, f("definitely-not-a-binary --flag"), enoentExec).reproduced, null);
});

test("markRoadmapResolved annotates the matching item line", () => {
  const body = "## Now\n\n- **Bad thing** (F-SEC-0001, score 1.00)\n";
  const out = markRoadmapResolved(body, "F-SEC-0001", "abcdef1234567");
  assert.match(out, /- ✅ done: \*\*Bad thing\*\* \(F-SEC-0001, score 1\.00\) \(resolved @ abcdef1\)/);
  assert.equal(markRoadmapResolved(out, "F-SEC-0001", "abcdef1234567"), out, "idempotent");
});

// ---------- run() integration tests ----------

test("run requires the identify gate", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const state = defaultState({ headSha: headOf(root), now: "2026-06-12T00:00:00.000Z" });
  await assert.rejects(run(makeCtx(root, { state })), (err) => err instanceof OpError && /audit/.test(err.message));
});

test("run: scoring, weighting, omitted-finding defaults, declined section, tickets, coldstart repair loop", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  const state = seedState(root);
  seedCharter(dotdir, { security: 5 });
  writeFinding(dotdir, finding(root, "F-SEC-0001", "security", { title: "Unvalidated input", severity: "high" }));
  writeFinding(dotdir, finding(root, "F-DX-0002", "dx", { title: "Slow local loop", severity: "medium" }));
  writeFinding(dotdir, finding(root, "F-PERF-0003", "performance", { title: "Tiny hot loop", severity: "low" }));

  const llm = makeFakeLLM({
    score: {
      items: [
        { id: "F-SEC-0001", impact: "L", effort: "S", confidence: 0.9, dependsOn: [], railsNeeded: true, riskOfInaction: "exploitable input path stays open" },
        // F-DX-0002 deliberately omitted → conservative defaults M/M/0.5
        { id: "F-PERF-0003", impact: "S", effort: "S", confidence: 0.9, declineReason: "out of engagement scope" },
      ],
    },
    "ticket:T1": TICKET_JSON("Validate request input"),
    "ticket:T2": TICKET_JSON("Speed up dev loop"),
    "ticket-repair": { body: "## Motivation\nrepaired with explicit data shapes embedded.\n\n## Acceptance Criteria\n- [ ] concrete check — verification: a command whose output is asserted." },
  });
  const adlcScript = {
    coldstart: [
      { status: 2, stdout: { results: [{ id: "T1", pass: false, gaps: [{ what: "missing data shapes", why_blocking: "agent cannot infer payload" }] }, { id: "T2", pass: true, gaps: [] }] } },
      { status: 0, stdout: { results: [{ id: "T1", pass: true, gaps: [] }, { id: "T2", pass: true, gaps: [] }] } },
    ],
  };
  const ctx = makeCtx(root, { state, llm, adlcAvailable: { coldstart: true }, adlcScript });
  const result = await run(ctx);

  // human gate 2: pauses, never throws
  assert.equal(result.gate.human, true);
  assert.equal(result.gate.passed, false);
  assert.match(result.gate.detail, /roadmap --approve/);
  assert.equal(result.state.gates.roadmap.coldstartClean, true);
  assert.equal(result.state.gates.roadmap.approved, false);
  assert.equal(result.state.phases.roadmap.status, "done");
  assert.equal(result.state.phases.roadmap.ticketCount, 2);
  assert.equal(result.state.phases.roadmap.declinedCount, 1);
  assert.equal(result.state.counters.tickets, 2);
  assert.equal(result.state.roadmapHistory.length, 1);
  assert.equal(result.state.pins.roadmap, headOf(root));

  const roadmap = readArtifact(dotdir, LAYOUT.roadmap);
  assert.equal(roadmap.meta.approved, false);
  assert.equal(roadmap.meta.basedOnFindings, 3);
  // security weight 5: (3×0.9/1) × 5/3 = 4.5 → Now + quick win
  const nowSection = roadmap.body.split("## Now")[1].split("## Next")[0];
  assert.match(nowSection, /F-SEC-0001.*score 4\.50/);
  assert.match(nowSection, /⚡ quick win/);
  assert.match(nowSection, /Risk of inaction: exploitable input path stays open/);
  // omitted finding got M/M/0.5 → score 0.5 → Next
  const nextSection = roadmap.body.split("## Next")[1].split("## Later")[0];
  assert.match(nextSection, /F-DX-0002.*score 0\.50/);
  // declined: never silently dropped
  const declinedSection = roadmap.body.split("## Declined")[1];
  assert.match(declinedSection, /F-PERF-0003.*declined: out of engagement scope/);
  assert.match(declinedSection, /Risk of inaction:/);
  // evidence citations present
  assert.match(nowSection, /findings\/F-SEC-0001\.md/);
  assert.match(nowSection, /src\/util\.js:1@[0-9a-f]{7}/);

  // tickets: P2 shape, coldstart-repaired body persisted
  const tickets = readTickets(dotdir);
  assert.equal(tickets.length, 2);
  const ids = tickets.map((t) => t.id);
  assert.deepEqual(ids, ["T1", "T2"]);
  for (const t of tickets) assert.deepEqual(validateTicket(t, ids), []);
  assert.match(tickets.find((t) => t.id === "T1").body, /repaired with explicit data shapes/);
  // frontier tier used for scoring and tickets
  assert.equal(llm.calls.find((c) => c.label === "score").tier, "frontier");
  assert.equal(llm.calls.find((c) => c.label === "ticket:T1").tier, "frontier");
});

test("run: coldstart gaps persisting through repair rounds → GateError exit 2, ticket flagged", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  seedCharter(dotdir);
  writeFinding(dotdir, finding(root, "F-SEC-0001", "security"));
  const llm = makeFakeLLM({
    score: { items: [{ id: "F-SEC-0001", impact: "L", effort: "S", confidence: 0.9 }] },
    "ticket:T1": TICKET_JSON("Fix it"),
    "ticket-repair": TICKET_JSON("Fix it (repaired)"),
  });
  const adlcScript = {
    coldstart: [{ status: 2, stdout: { results: [{ id: "T1", pass: false, gaps: [{ what: "vague scope", why_blocking: "unbounded" }] }] } }],
  };
  const ctx = makeCtx(root, { state: seedState(root), llm, adlcAvailable: { coldstart: true }, adlcScript });
  await assert.rejects(run(ctx), (err) => {
    assert.ok(err instanceof GateError, "GateError");
    assert.equal(err.exitCode, 2);
    assert.equal(err.gate, "roadmap");
    assert.ok(err.state, "partial state attached for persistence");
    assert.equal(err.state.gates.roadmap.coldstartClean, false);
    return true;
  });
  const t1 = readArtifact(dotdir, "backlog/T1.md");
  assert.match(t1.body, /coldstart: failed/);
});

test("run: coldstart absent → degraded native cheap-tier probe, recorded in gate", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  seedCharter(dotdir);
  writeFinding(dotdir, finding(root, "F-SEC-0001", "security"));
  const llm = makeFakeLLM({
    score: { items: [{ id: "F-SEC-0001", impact: "L", effort: "S", confidence: 0.9 }] },
    "ticket:T1": TICKET_JSON("Fix it"),
    "coldstart-probe": { pass: true, gaps: [] },
  });
  const ctx = makeCtx(root, { state: seedState(root), llm });
  const result = await run(ctx);
  assert.equal(result.state.gates.roadmap.coldstartClean, true);
  assert.equal(result.state.gates.roadmap.coldstartDegraded, "native-probe");
  const probe = llm.calls.find((c) => c.label === "coldstart-probe");
  assert.ok(probe, "native probe invoked");
  assert.equal(probe.tier, "cheap");
});

test("run: living document — prior item whose finding is gone becomes ✅ done", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  seedCharter(dotdir);
  writeFinding(dotdir, finding(root, "F-SEC-0001", "security"));
  writeArtifact(dotdir, LAYOUT.roadmap, {
    meta: { generatedAt: "x", headSha: "y", approved: true },
    body: "# Technical Roadmap\n\n## Now\n\n- **Old fixed thing** (F-SEC-0009, score 1.00) — evidence: [F-SEC-0009](findings/F-SEC-0009.md)\n",
  });
  const llm = makeFakeLLM({
    score: { items: [{ id: "F-SEC-0001", impact: "L", effort: "S", confidence: 0.9 }] },
    "ticket:T1": TICKET_JSON("Fix it"),
    "coldstart-probe": { pass: true, gaps: [] },
  });
  const result = await run(makeCtx(root, { state: seedState(root), llm }));
  const roadmap = readArtifact(dotdir, LAYOUT.roadmap);
  const doneSection = roadmap.body.split("## Done / Regressed")[1].split("## Declined")[0];
  assert.match(doneSection, /✅ done: \*\*Old fixed thing\*\* \(F-SEC-0009\)/);
  assert.ok(result.state.roadmapHistory.length >= 1);
});

test("approve: requires coldstartClean, then sets the gate and records hash", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  seedCharter(dotdir);
  writeFinding(dotdir, finding(root, "F-SEC-0001", "security"));
  const llm = makeFakeLLM({
    score: { items: [{ id: "F-SEC-0001", impact: "L", effort: "S", confidence: 0.9 }] },
    "ticket:T1": TICKET_JSON("Fix it"),
    "coldstart-probe": { pass: true, gaps: [] },
  });
  const ctx = makeCtx(root, { state: seedState(root), llm });
  const drafted = await run(ctx);

  // not clean → OpError
  const dirty = setGate(drafted.state, "roadmap", { coldstartClean: false });
  await assert.rejects(approve(makeCtx(root, { state: dirty, llm })), OpError);

  const approved = await approve(makeCtx(root, { state: drafted.state, llm }));
  assert.equal(approved.gate.human, true);
  assert.equal(approved.gate.passed, true);
  assert.equal(approved.state.gates.roadmap.approved, true);
  assert.equal(typeof approved.state.gates.roadmap.roadmapSha256, "string");
  assert.equal(approved.state.gates.roadmap.roadmapSha256.length, 64);
});

test("approve: missing ROADMAP.md is an operational error", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const state = seedState(root, (s) => setGate(s, "roadmap", { coldstartClean: true }));
  await assert.rejects(approve(makeCtx(root, { state })), (err) => err instanceof OpError && /ROADMAP/.test(err.message));
});

test("H14: coldstart tool absent + online — a failing native probe fails the gate (exit 2, degraded=native-probe)", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  seedCharter(dotdir);
  writeFinding(dotdir, finding(root, "F-SEC-0001", "security"));
  const llm = makeFakeLLM({
    score: { items: [{ id: "F-SEC-0001", impact: "L", effort: "S", confidence: 0.9 }] },
    "ticket:T1": TICKET_JSON("Fix it"),
    "ticket-repair": TICKET_JSON("Fix it (repaired)"),
    // The native fresh-agent probe reports a blocking gap every round.
    "coldstart-probe": { pass: false, gaps: [{ what: "vague scope", why_blocking: "unbounded" }] },
  });
  // coldstart tool ABSENT (default availability) → the degraded native probe runs.
  const ctx = makeCtx(root, { state: seedState(root), llm });
  await assert.rejects(run(ctx), (err) => {
    assert.ok(err instanceof GateError, "GateError thrown when native-probe gaps persist");
    assert.equal(err.exitCode, 2);
    assert.equal(err.gate, "roadmap");
    assert.equal(err.state.gates.roadmap.coldstartClean, false);
    assert.equal(err.state.gates.roadmap.coldstartDegraded, "native-probe", "the degradation is declared on the gate record");
    return true;
  });
  const t1 = readArtifact(dotdir, "backlog/T1.md");
  assert.match(t1.body, /coldstart: failed/, "the gapped ticket is flagged, never silently shipped");
});

test("H14: coldstart tool absent + offline — degrades to static-lint, gate passes with degradation declared", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  seedCharter(dotdir);
  writeFinding(dotdir, finding(root, "F-SEC-0001", "security"));
  // Offline llm: every LLM call degrades to its deterministic fallback, and
  // coldstart routes through validateTicket (static lint) rather than a probe.
  const llm = { ...makeFakeLLM({}), offline: true };
  const ctx = makeCtx(root, { state: seedState(root), llm, flags: { offline: true } });
  const result = await run(ctx);
  assert.equal(result.state.gates.roadmap.coldstartClean, true, "deterministic tickets pass static lint");
  assert.equal(result.state.gates.roadmap.coldstartDegraded, "static-lint", "the offline degradation is declared, never silent");
  assert.match(result.summary, /coldstart degraded: static-lint/);
});
