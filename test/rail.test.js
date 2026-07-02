import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { OpError, GateError } from "../src/utils.js";
import { defaultState, setGate, pinSha } from "../src/state.js";
import { LAYOUT, writeArtifact, readArtifact, writeTickets, readTickets } from "../src/artifacts.js";
import {
  PHASE_ID, run, basicEnvProbe, mapBehaviorsToTickets, globMatch, parseBehaviorInventory,
} from "../src/rail.js";

// ---------- inline fixture helpers ----------

function realExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function makeRepo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-rail-"));
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
    offline: false, provider: "fake", models: { cheap: "c", mid: "m", frontier: "f" }, calls,
    async call(prompt, opts = {}) {
      const label = opts.label ?? "LLM";
      calls.push({ label, tier: opts.tier, jsonMode: Boolean(opts.jsonMode), prompt });
      const entry = script[label];
      let resp = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
      if (resp === undefined) resp = opts.jsonMode ? "{}" : "";
      return typeof resp === "string" ? resp : JSON.stringify(resp);
    },
    async callJson(prompt, opts = {}) { return JSON.parse(await llm.call(prompt, { ...opts, jsonMode: true })); },
    drainSpend() { return { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 }; },
    estimateTokens: (t) => Math.ceil(String(t ?? "").length / 4),
  };
  return llm;
}

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
    root, dotdir, state,
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

const FIXTURE_FILES = {
  "src/util.js": "export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n",
  "package.json": '{ "name": "fixture", "type": "module" }\n',
  "test/.gitkeep": "",
};

function seedDelivery(root, { behaviors = 1 } = {}) {
  const dotdir = path.join(root, ".dobetter");
  const sha = headOf(root);
  const sha7 = sha.slice(0, 7);
  let state = defaultState({ headSha: sha, now: "2026-06-12T00:00:00.000Z" });
  state = setGate(state, "identify", { passed: true });
  state = setGate(state, "roadmap", { approved: true, approvedAt: "2026-06-12T00:00:00.000Z", coldstartClean: true });
  state = pinSha(state, "roadmap", sha);
  state = { ...state, counters: { ...state.counters, tickets: 1 } };
  const lines = ["# Behavior Inventory", "", `- **B-001** (cli) add utility — entry src/util.js:1@${sha7} — adds two numbers`];
  if (behaviors > 1) lines.push(`- **B-002** (cli) sub utility — entry src/util.js:2@${sha7} — subtracts two numbers`);
  writeArtifact(dotdir, LAYOUT.comprehension.behaviorInventory, { meta: { headSha: sha }, body: `${lines.join("\n")}\n` });
  writeArtifact(dotdir, LAYOUT.comprehension.railsMap, { meta: { headSha: sha }, body: "# Rails map\n\n- B-001: load-bearing-but-untested\n" });
  writeArtifact(dotdir, LAYOUT.roadmap, {
    meta: { generatedAt: "x", headSha: sha, approved: true },
    body: "# Technical Roadmap\n\n## Phase 0 — Rails & runnability\n\n_None._\n\n## Now\n\n- **Fix it** (F-SEC-0001, score 2.00)\n",
  });
  writeTickets(dotdir, [{
    id: "T1", title: "Fix it",
    body: "## Motivation\nlinked finding.\n\n## Acceptance Criteria\n- [ ] x — verification: command.",
    scope: ["src/**"], rails: [], edges: [], duration: 4, category: "security",
  }]);
  return state;
}

const GOOD_RAIL = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { add } from "../../src/util.js";',
  "// pinned current behavior, possibly a bug",
  'test("B-001 pins add()", () => { assert.equal(add(2, 2), 4); });',
].join("\n");

const GOOD_RAIL_B2 = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { sub } from "../../src/util.js";',
  'test("B-002 pins sub()", () => { assert.equal(sub(5, 2), 3); });',
].join("\n");

const VACUOUS_RAIL = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'test("B-002 vacuous", () => { assert.ok(true); });',
].join("\n");

const BAD_RAIL = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { add } from "../../src/util.js";',
  'test("B-001 wrong pin", () => { assert.equal(add(2, 2), 5); });',
].join("\n");

const PREFLIGHT_PASS = { status: 0, stdout: { verdict: "pass", checks: [], failedNames: [] } };
const HOLLOW_CLEAN = { status: 0, stdout: { summary: { total: 2, killed: 2, survived: 0 }, mutants: [] } };

// ---------- pure unit tests ----------

test("globMatch supports *, **, ? and bare-basename patterns", () => {
  assert.equal(globMatch("src/**", "src/a/b.js"), true);
  assert.equal(globMatch("src/*.js", "src/util.js"), true);
  assert.equal(globMatch("src/*.js", "src/a/b.js"), false);
  assert.equal(globMatch("*.js", "src/util.js"), true);
  assert.equal(globMatch("lib/**", "src/util.js"), false);
});

test("mapBehaviorsToTickets matches ticket scope globs against behavior files", () => {
  const behaviors = [
    { id: "B-001", files: ["src/util.js"] },
    { id: "B-002", files: ["lib/other.js"] },
  ];
  const tickets = [
    { id: "T1", scope: ["src/**"] },
    { id: "T2", scope: ["docs/**"] },
  ];
  assert.deepEqual(mapBehaviorsToTickets(behaviors, tickets), [
    { behaviorId: "B-001", ticketIds: ["T1"] },
    { behaviorId: "B-002", ticketIds: [] },
  ]);
});

test("parseBehaviorInventory extracts ids and entry citations from bullets", () => {
  const list = parseBehaviorInventory("- **B-001** route — src/server.js:10@abcdef1\nnot a bullet B-009\n- **B-002** cli — bin/tool.js:3@abcdef1");
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].entry, { file: "src/server.js", line: 10, sha: "abcdef1" });
  assert.deepEqual(list[1].files, ["bin/tool.js"]);
});

test("basicEnvProbe passes on a clean repo and fails where it cannot write", () => {
  const root = makeRepo(FIXTURE_FILES);
  const exec = makeCtxExec();
  const ok = basicEnvProbe(root, exec);
  assert.equal(ok.verdict, "pass");
  assert.ok(ok.checks.some((c) => c.name === "write-test" && c.status === "pass"));

  const ro = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-ro-"));
  fs.chmodSync(ro, 0o555);
  try {
    const bad = basicEnvProbe(ro, exec);
    assert.equal(bad.verdict, "fail");
  } finally {
    fs.chmodSync(ro, 0o755);
  }
});

// ---------- run() integration tests ----------

test("run requires the approved roadmap gate", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const state = defaultState({ headSha: headOf(root), now: "2026-06-12T00:00:00.000Z" });
  await assert.rejects(run(makeCtx(root, { state })), (err) => err instanceof OpError && /roadmap/.test(err.message));
});

test("run: preflight red injects Phase-0 runnability item + ticket, exits without GateError", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  const state = seedDelivery(root);
  const adlcScript = {
    preflight: { status: 2, stdout: { verdict: "fail", checks: [{ name: "tests", status: "fail", detail: "no runner" }], failedNames: ["tests"] } },
  };
  const llm = makeFakeLLM({ "coldstart-probe": { pass: true, gaps: [] } });
  const ctx = makeCtx(root, { state, llm, adlcAvailable: { preflight: true }, adlcScript });
  const result = await run(ctx);

  assert.equal(result.gate.passed, false);
  assert.equal(result.gate.human, false);
  assert.match(result.gate.detail, /Make the environment runnable/);
  assert.equal(result.state.gates.rail.preflight.verdict, "fail");
  assert.equal(result.state.gates.rail.passed, false);

  const roadmap = readArtifact(dotdir, LAYOUT.roadmap);
  const phase0 = roadmap.body.split("## Phase 0")[1].split("## Now")[0];
  assert.match(phase0, /Make the environment runnable/);
  const tickets = readTickets(dotdir);
  assert.equal(tickets.length, 2);
  assert.equal(tickets[1].title, "Make the environment runnable");
  assert.equal(tickets[1].id, "T2");
  // manifest records the env gap
  const manifest = readArtifact(dotdir, LAYOUT.railsManifest);
  assert.match(manifest.body, /environment not runnable/);
});

test("run: authors green rails, hollow-clean audit, manifest rows, tickets gain rails (freeze)", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  const state = seedDelivery(root);
  const llm = makeFakeLLM({ "rail:B-001": GOOD_RAIL });
  const adlcScript = { preflight: PREFLIGHT_PASS, "hollow-test": HOLLOW_CLEAN };
  const ctx = makeCtx(root, { state, llm, adlcAvailable: { preflight: true, "hollow-test": true }, adlcScript });
  const result = await run(ctx);

  const railRel = "test/dobetter-rails/B-001.rail.test.js";
  assert.ok(fs.existsSync(path.join(root, railRel)), "rail file written into the repo test tree");
  assert.equal(result.state.gates.rail.passed, true);
  assert.equal(result.state.gates.rail.railsGreen, true);
  assert.equal(result.state.gates.rail.hollowAudited, true);
  assert.equal(result.state.gates.rail.hollowSurvivors, 0);
  assert.equal(result.state.phases.rail.railsAuthored, 1);
  assert.equal(result.state.phases.rail.status, "done");
  assert.match(result.summary, /ADLC P3\/P4 intake/);
  // mid tier for rail drafting
  assert.equal(llm.calls.find((c) => c.label === "rail:B-001").tier, "mid");

  const manifest = readArtifact(dotdir, LAYOUT.railsManifest);
  assert.match(manifest.body, /\| B-001 \| test\/dobetter-rails\/B-001\.rail\.test\.js \| boundary golden-master \|/);
  assert.match(manifest.body, /hollow: killed 2\/2/);
  assert.match(manifest.body, /frozen/i);

  const tickets = readTickets(dotdir);
  assert.deepEqual(tickets[0].rails, [railRel]);
  // rails-map annotated
  const railsMap = readArtifact(dotdir, LAYOUT.comprehension.railsMap);
  assert.match(railsMap.body, /Rail coverage \(do-better D4\)/);
  assert.match(railsMap.body, /B-001: railed/);
});

test("run: rail red after fix loop is deleted (fail closed) → GateError when nothing pinned", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  const state = seedDelivery(root);
  const llm = makeFakeLLM({ "rail:B-001": BAD_RAIL, "rail-fix": BAD_RAIL });
  const adlcScript = { preflight: PREFLIGHT_PASS };
  const ctx = makeCtx(root, { state, llm, adlcAvailable: { preflight: true }, adlcScript });
  await assert.rejects(run(ctx), (err) => {
    assert.ok(err instanceof GateError);
    assert.equal(err.exitCode, 2);
    assert.ok(err.state);
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, "test/dobetter-rails/B-001.rail.test.js")), false, "red rail deleted");
  const manifest = readArtifact(dotdir, LAYOUT.railsManifest);
  assert.match(manifest.body, /could not pin/);
  assert.ok(llm.calls.filter((c) => c.label === "rail-fix").length >= 1, "fix loop ran");
});

test("run: hollow-test survivor → fix loop → offending rail deleted, survivor count recorded", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  const state = seedDelivery(root, { behaviors: 2 });
  const survivorMutants = {
    status: 2,
    stdout: {
      summary: { total: 2, killed: 1, survived: 1 },
      mutants: [{ file: "test/dobetter-rails/B-002.rail.test.js", survived: true }],
    },
  };
  const llm = makeFakeLLM({ "rail:B-001": GOOD_RAIL, "rail:B-002": VACUOUS_RAIL, "rail-fix": VACUOUS_RAIL });
  const adlcScript = { preflight: PREFLIGHT_PASS, "hollow-test": [survivorMutants, survivorMutants] };
  const ctx = makeCtx(root, { state, llm, adlcAvailable: { preflight: true, "hollow-test": true }, adlcScript });
  const result = await run(ctx);

  assert.equal(fs.existsSync(path.join(root, "test/dobetter-rails/B-002.rail.test.js")), false, "vacuous rail deleted");
  assert.ok(fs.existsSync(path.join(root, "test/dobetter-rails/B-001.rail.test.js")), "good rail kept");
  assert.equal(result.state.gates.rail.hollowSurvivors, 1);
  assert.equal(result.state.gates.rail.passed, true);
  const manifest = readArtifact(dotdir, LAYOUT.railsManifest);
  assert.match(manifest.body, /B-002: hollow-test survivor/);
});

test("run: hollow-test operational failure → declared degradation + spot-check, never 'hollow: killed 0/0'", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  const state = seedDelivery(root, { behaviors: 2 });
  const llm = makeFakeLLM({ "rail:B-001": GOOD_RAIL, "rail:B-002": VACUOUS_RAIL });
  // exit 1 + unparseable --json stdout: the audit demonstrably did not run
  const adlcScript = {
    preflight: PREFLIGHT_PASS,
    "hollow-test": { status: 1, stdout: "boom: not json", stderr: "hollow-test crashed" },
  };
  const ctx = makeCtx(root, { state, llm, adlcAvailable: { preflight: true, "hollow-test": true }, adlcScript });
  const result = await run(ctx);

  assert.equal(result.state.gates.rail.hollowAudited, false, "an erroring hollow-test run is NOT an audit");
  const manifest = readArtifact(dotdir, LAYOUT.railsManifest);
  assert.ok(!manifest.body.includes("hollow: killed"), "no hollow kill counts for a run that produced no mutants");
  assert.match(manifest.body, /hollow-test failed to run/, "degradation declared, never silent");
  assert.match(manifest.body, /spot-check: ok/, "mandatory native deletion spot-check applied");
  assert.equal(fs.existsSync(path.join(root, "test/dobetter-rails/B-002.rail.test.js")), false, "vacuous rail still caught");
  assert.ok(fs.existsSync(path.join(root, "test/dobetter-rails/B-001.rail.test.js")), "real rail kept");
  assert.equal(result.state.gates.rail.passed, true, "gate may pass on rails-green + spot-check");
});

test("run: hollow-test absent → native deletion spot-check deletes vacuous rails, keeps real ones", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  const state = seedDelivery(root, { behaviors: 2 });
  const llm = makeFakeLLM({ "rail:B-001": GOOD_RAIL, "rail:B-002": VACUOUS_RAIL });
  const adlcScript = { preflight: PREFLIGHT_PASS };
  const ctx = makeCtx(root, { state, llm, adlcAvailable: { preflight: true }, adlcScript });
  const result = await run(ctx);

  assert.ok(fs.existsSync(path.join(root, "test/dobetter-rails/B-001.rail.test.js")), "real rail kept");
  assert.equal(fs.existsSync(path.join(root, "test/dobetter-rails/B-002.rail.test.js")), false, "vacuous rail deleted");
  assert.equal(result.state.gates.rail.hollowAudited, false);
  assert.equal(result.state.gates.rail.passed, true);
  const manifest = readArtifact(dotdir, LAYOUT.railsManifest);
  assert.match(manifest.body, /spot-check: ok/);
  assert.match(manifest.body, /B-002: vacuous rail/);
  // fixture source restored after spot-check
  assert.match(fs.readFileSync(path.join(root, "src/util.js"), "utf8"), /^export function add/m);
  // degradation declared, never silent
  assert.match(manifest.body, /hollow-test absent/);
});
