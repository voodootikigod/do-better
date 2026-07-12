import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { OpError, GateError } from "../src/utils.js";
import { defaultState, pinSha } from "../src/state.js";
import { LAYOUT, writeArtifact, readArtifact, writeFinding } from "../src/artifacts.js";
import { PHASE_ID, run, changedFilesSince } from "../src/refresh.js";

// ---------- inline fixture helpers ----------

function realExec(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: false, ...opts });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitIn(root) {
  return (args) => realExec("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root });
}

function makeRepo(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-refresh-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const g = gitIn(root);
  g(["init", "-q"]);
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  return root;
}

const headOf = (root) => realExec("git", ["rev-parse", "HEAD"], { cwd: root }).stdout.trim();

function commitChange(root, rel, content) {
  fs.writeFileSync(path.join(root, rel), content);
  const g = gitIn(root);
  g(["add", "-A"]);
  g(["commit", "-qm", `change ${rel}`]);
}

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
    llm: llm ?? makeFakeLLM({ codemap: "- updated entry" }),
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
  "src/util.js": "export function add(a, b) { return a + b; }\n",
  "package.json": '{ "name": "fixture", "type": "module" }\n',
};

// Writes comprehension artifacts into .dobetter/ (commit them with sealState before running refresh).
function seedComprehended(root) {
  const dotdir = path.join(root, ".dobetter");
  const sha = headOf(root);
  const sha7 = sha.slice(0, 7);
  writeArtifact(dotdir, LAYOUT.comprehension.codemap, { meta: { headSha: sha, draft: false }, body: `# Codemap\n\n- src/util.js:1@${sha7} math helpers\n` });
  writeArtifact(dotdir, LAYOUT.comprehension.behaviorInventory, {
    meta: { headSha: sha },
    body: `# Behavior Inventory\n\n- **B-001** (cli) add utility — entry src/util.js:1@${sha7}\n`,
  });
  return { dotdir, sha, sha7 };
}

// Commits all seeded .dobetter artifacts and returns state pinned at the resulting HEAD.
function sealState(root) {
  const g = gitIn(root);
  g(["add", "-A"]);
  g(["commit", "-qm", "seed .dobetter"]);
  const sha = headOf(root);
  let state = defaultState({ headSha: sha, now: "2026-06-12T00:00:00.000Z" });
  state = pinSha(state, "scan", sha);
  state = pinSha(state, "comprehend", sha);
  return state;
}

function seedFinding(root, id, record, exitCode) {
  const sha = headOf(root);
  writeFinding(path.join(root, ".dobetter"), {
    id, dimension: "security", title: `Issue ${id}`, severity: "high", confidence: 0.9,
    evidence: [{ file: "src/util.js", line: 1, sha: sha.slice(0, 7) }],
    reproduction: { method: "command", record, exitCode },
    status: "verified", foundAt: "2026-06-12T00:00:00.000Z", headSha: sha, stale: false,
  });
}

// ---------- tests ----------

test("changedFilesSince includes committed changes and untracked files", () => {
  const root = makeRepo(FIXTURE_FILES);
  const pin = headOf(root);
  commitChange(root, "src/util.js", "export function add(a, b) { return a + b; } // changed\n");
  fs.writeFileSync(path.join(root, "notes.txt"), "untracked\n");
  const changed = changedFilesSince(root, pin, makeCtxExec());
  assert.ok(changed.includes("src/util.js"), "committed change listed");
  assert.ok(changed.includes("notes.txt"), "untracked file listed");
});

test("run requires at least one prior pin", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const state = defaultState({ headSha: headOf(root), now: "2026-06-12T00:00:00.000Z" });
  await assert.rejects(run(makeCtx(root, { state })), (err) => err instanceof OpError && /scan/.test(err.message));
});

test("run: no changes since pin → fresh, informational, phase done", async () => {
  const root = makeRepo(FIXTURE_FILES);
  seedComprehended(root);
  const state = sealState(root);
  const result = await run(makeCtx(root, { state }));
  assert.match(result.summary, /Fresh @/);
  assert.equal(result.state.phases.refresh.status, "done");
  assert.equal(result.state.phases.refresh.changedFiles, 0);
  assert.equal(result.state.pins.refresh, headOf(root));
});

test("run: stale claims flagged, resolved finding marked, ROADMAP gets ✅ done, surviving finding re-pinned", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  seedComprehended(root);
  // F-SEC-0001 recorded exit 0 but now exits 2 → no longer reproduces → resolved
  seedFinding(root, "F-SEC-0001", 'node -e "process.exit(2)"', 0);
  // F-SEC-0002 still reproduces → stale cleared, citations re-pinned
  seedFinding(root, "F-SEC-0002", 'node -e "process.exit(0)"', 0);
  writeArtifact(dotdir, LAYOUT.roadmap, {
    meta: { generatedAt: "x", headSha: "y", approved: true },
    body: "# Technical Roadmap\n\n## Now\n\n- **Issue F-SEC-0001** (F-SEC-0001, score 2.00) — evidence: [F-SEC-0001](findings/F-SEC-0001.md)\n\n## Done / Regressed\n\n_None._\n",
  });
  const state = sealState(root);
  commitChange(root, "src/util.js", "export function add(a, b) { return a + b; } // patched\n");
  const newSha7 = headOf(root).slice(0, 7);

  const result = await run(makeCtx(root, { state }));

  // behavior inventory line flagged stale (skill-rot doctrine: flagged, not trusted)
  const inv = readArtifact(dotdir, LAYOUT.comprehension.behaviorInventory);
  assert.match(inv.body, /⚠ STALE/);
  assert.ok(result.state.phases.refresh.staleClaims >= 3, `stale claims counted (got ${result.state.phases.refresh.staleClaims})`);
  assert.equal(result.state.phases.refresh.status, "done");

  // resolved finding: RESOLVED note + roadmap ✅ done
  const f1 = readArtifact(dotdir, "findings/F-SEC-0001.md");
  assert.match(f1.body, /RESOLVED @ /);
  assert.equal(f1.meta.stale, true);
  const roadmap = readArtifact(dotdir, LAYOUT.roadmap);
  assert.match(roadmap.body, /✅ done: \*\*Issue F-SEC-0001\*\*/);
  assert.match(result.summary, /resolved: F-SEC-0001/);

  // surviving finding: stale cleared, evidence re-pinned to new sha
  const f2 = readArtifact(dotdir, "findings/F-SEC-0002.md");
  assert.equal(f2.meta.stale, false);
  assert.ok(String(f2.meta.evidence[0]).includes(`@${newSha7}`), "evidence re-pinned");

  // codemap got targeted refresh notes (cheap tier)
  const codemap = readArtifact(dotdir, LAYOUT.comprehension.codemap);
  assert.match(codemap.body, /## Refresh notes/);

  // behavior-diff absent → declared degradation, never silent
  assert.match(result.summary, /behavior-diff unavailable/);
});

test("run: behavior-diff compare gate-fail → ⚠ regressed in ROADMAP + GateError exit 2", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  seedComprehended(root);
  seedFinding(root, "F-SEC-0002", 'node -e "process.exit(0)"', 0);
  writeArtifact(dotdir, LAYOUT.roadmap, {
    meta: { generatedAt: "x", headSha: "y", approved: true },
    body: "# Technical Roadmap\n\n## Now\n\n- **Something** (F-SEC-0002, score 1.00)\n\n## Done / Regressed\n\n_None._\n",
  });
  fs.mkdirSync(path.join(dotdir, "tmp"), { recursive: true });
  fs.writeFileSync(path.join(dotdir, "tmp/behavior.json"), "{}\n");
  fs.writeFileSync(path.join(dotdir, "tmp/behavior-before.json"), "{}\n");
  const state = sealState(root);
  commitChange(root, "src/util.js", "export function add(a, b) { return a + b + 0; }\n");

  const adlcScript = {
    "behavior-diff": (args) => (args.includes("capture")
      ? { status: 0, stdout: { ok: true } }
      : { status: 2, stdout: { changed: [{ id: "B-001" }] } }),
  };
  const ctx = makeCtx(root, { state, adlcAvailable: { "behavior-diff": true }, adlcScript });
  await assert.rejects(run(ctx), (err) => {
    assert.ok(err instanceof GateError);
    assert.equal(err.exitCode, 2);
    assert.match(err.detail, /B-001/);
    assert.ok(err.state, "state attached for persistence");
    return true;
  });
  const roadmap = readArtifact(dotdir, LAYOUT.roadmap);
  assert.match(roadmap.body, /⚠ regressed: B-001/);
});

test("run: still-reproducing static finding is NOT marked resolved (reproduction actually re-runs, D6/D9)", async () => {
  const root = makeRepo({
    ...FIXTURE_FILES,
    "src/util.js": "export function add(a, b) { return a + b; } // TODO: fix rounding\n",
  });
  const dotdir = path.join(root, ".dobetter");
  seedComprehended(root);
  const sha = headOf(root);
  // the machine-re-runnable reproduction identify now persists for static findings
  writeFinding(dotdir, {
    id: "F-MAIN-0003", dimension: "maintainability", title: "Acknowledged debt marker in src/util.js",
    severity: "low", confidence: 0.9,
    evidence: [{ file: "src/util.js", line: 1, sha: sha.slice(0, 7) }],
    reproduction: {
      method: "static",
      record: "repro-check regex /\\b(TODO|FIXME|HACK)\\b/ in src/util.js: matched",
      exitCode: null,
      check: { type: "regex", pattern: "\\b(TODO|FIXME|HACK)\\b", file: "src/util.js" },
    },
    status: "verified", foundAt: "2026-06-12T00:00:00.000Z", headSha: sha, stale: false,
  });
  writeArtifact(dotdir, LAYOUT.roadmap, {
    meta: { generatedAt: "x", headSha: "y", approved: true },
    body: "# Technical Roadmap\n\n## Now\n\n- **Acknowledged debt marker in src/util.js** (F-MAIN-0003, score 1.00)\n\n## Done / Regressed\n\n_None._\n",
  });
  const state = sealState(root);
  // the cited file changes but the TODO marker SURVIVES — the finding still reproduces
  commitChange(root, "src/util.js", "export function add(a, b) { return a + b + 0; } // TODO: fix rounding\n");
  const newSha7 = headOf(root).slice(0, 7);

  const result = await run(makeCtx(root, { state }));

  const f = readArtifact(dotdir, "findings/F-MAIN-0003.md");
  assert.ok(!/RESOLVED @/.test(f.body), "a still-reproducing finding must never be stamped RESOLVED");
  assert.equal(f.meta.stale, false, "still reproduces → stale cleared");
  assert.ok(String(f.meta.evidence[0]).includes(`@${newSha7}`), "evidence re-pinned to current sha");
  const roadmap = readArtifact(dotdir, LAYOUT.roadmap);
  assert.ok(!roadmap.body.includes("✅ done"), "roadmap item must not be falsely marked done");
  assert.ok(!/resolved: F-MAIN-0003/.test(result.summary), "summary must not claim resolution");
});

test("run: legacy human-readable reproduction record → unknowable, finding stays stale, never auto-resolved", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  seedComprehended(root);
  const sha = headOf(root);
  // pre-fix findings persisted only a human-readable record — not re-runnable
  writeFinding(dotdir, {
    id: "F-SEC-0009", dimension: "security", title: "Legacy record finding", severity: "high", confidence: 0.9,
    evidence: [{ file: "src/util.js", line: 1, sha: sha.slice(0, 7) }],
    reproduction: { method: "command", record: "$ node --test test/x.test.js\nexit 0\nok", exitCode: 0 },
    status: "verified", foundAt: "2026-06-12T00:00:00.000Z", headSha: sha, stale: false,
  });
  const state = sealState(root);
  commitChange(root, "src/util.js", "export function add(a, b) { return a + b; } // patched\n");

  const result = await run(makeCtx(root, { state }));

  const f = readArtifact(dotdir, "findings/F-SEC-0009.md");
  assert.ok(!/RESOLVED @/.test(f.body), "unknowable reproduction must not resolve the finding");
  assert.equal(f.meta.stale, true, "finding stays flagged stale (skill-rot doctrine: flag, never trust)");
  assert.ok(!/resolved: F-SEC-0009/.test(result.summary));
});

test("run: idempotent — second refresh does not duplicate stale annotations", async () => {
  const root = makeRepo(FIXTURE_FILES);
  const dotdir = path.join(root, ".dobetter");
  seedComprehended(root);
  seedFinding(root, "F-SEC-0002", 'node -e "process.exit(0)"', 0);
  const state = sealState(root);
  commitChange(root, "src/util.js", "export function add(a, b) { return a + b; } // patched\n");

  const first = await run(makeCtx(root, { state }));
  const afterFirst = readArtifact(dotdir, LAYOUT.comprehension.behaviorInventory).body;
  const second = await run(makeCtx(root, { state: first.state }));
  const afterSecond = readArtifact(dotdir, LAYOUT.comprehension.behaviorInventory).body;
  const count = (s) => (s.match(/⚠ STALE/g) ?? []).length;
  assert.equal(count(afterSecond), count(afterFirst), "stale markers not duplicated");
  assert.equal(second.state.phases.refresh.status, "done");
});

// A verified finding whose reproduction is a blind reread (method "reread"),
// produced in production by identify.js's blind-frontier-reread path.
function seedFindingReread(root, id) {
  const sha = headOf(root);
  writeFinding(path.join(root, ".dobetter"), {
    id, dimension: "security", title: `Reread ${id}`, severity: "high", confidence: 0.9,
    evidence: [{ file: "src/util.js", line: 1, sha: sha.slice(0, 7) }],
    reproduction: { method: "reread", record: "CONFIRM (blind reread): the add helper trusts its inputs", exitCode: null },
    status: "verified", foundAt: "2026-06-12T00:00:00.000Z", headSha: sha, stale: false,
  });
}

// H13 — the reread re-verdict branch (KILL/CONFIRM/UNCERTAIN + fenced JSON).
async function runRereadRefresh(root, verdictResp) {
  const dotdir = path.join(root, ".dobetter");
  const state = sealState(root);
  commitChange(root, "src/util.js", "export function add(a, b) { return a + b; } // touched\n");
  const llm = makeFakeLLM({ codemap: "- updated", verdict: verdictResp });
  const result = await run(makeCtx(root, { state, llm }));
  return { result, dotdir };
}

test("H13: reread verdict KILL resolves the finding (RESOLVED stamp + resolvedIds)", async () => {
  const root = makeRepo(FIXTURE_FILES);
  seedComprehended(root);
  seedFindingReread(root, "F-SEC-0100");
  const { result, dotdir } = await runRereadRefresh(root, { verdict: "KILL" });
  const f = readArtifact(dotdir, "findings/F-SEC-0100.md");
  assert.match(f.body, /RESOLVED @ /, "KILL stamps the finding RESOLVED");
  assert.equal(f.meta.stale, true);
  assert.match(result.summary, /resolved: F-SEC-0100/);
});

test("H13: reread verdict CONFIRM keeps the finding, clears stale, re-pins evidence", async () => {
  const root = makeRepo(FIXTURE_FILES);
  seedComprehended(root);
  seedFindingReread(root, "F-SEC-0101");
  const { dotdir } = await runRereadRefresh(root, { verdict: "CONFIRM" });
  const newSha7 = headOf(root).slice(0, 7);
  const f = readArtifact(dotdir, "findings/F-SEC-0101.md");
  assert.equal(f.meta.stale, false, "CONFIRM clears stale");
  assert.ok(String(f.meta.evidence[0]).includes(`@${newSha7}`), "evidence re-pinned to the new sha");
});

test("H13: reread verdict UNCERTAIN leaves the finding stale, unresolved", async () => {
  const root = makeRepo(FIXTURE_FILES);
  seedComprehended(root);
  seedFindingReread(root, "F-SEC-0102");
  const { result, dotdir } = await runRereadRefresh(root, { verdict: "UNCERTAIN" });
  const f = readArtifact(dotdir, "findings/F-SEC-0102.md");
  assert.equal(f.meta.stale, true, "UNCERTAIN stays stale");
  assert.doesNotMatch(f.body, /RESOLVED @ /, "UNCERTAIN does not resolve");
  assert.doesNotMatch(result.summary, /resolved: F-SEC-0102/);
});

test("H13: a fenced-JSON reread verdict is parsed via coerceJson", async () => {
  const root = makeRepo(FIXTURE_FILES);
  seedComprehended(root);
  seedFindingReread(root, "F-SEC-0103");
  // Verdict arrives wrapped in a ```json fence — coerceJson (refresh.js:48-53)
  // must strip it. If it were not parsed, the finding would stay stale.
  const { result, dotdir } = await runRereadRefresh(root, '```json\n{"verdict":"KILL"}\n```');
  const f = readArtifact(dotdir, "findings/F-SEC-0103.md");
  assert.match(f.body, /RESOLVED @ /, "fenced KILL is parsed and resolves the finding");
  assert.match(result.summary, /resolved: F-SEC-0103/);
});

test("H12: a stale finding's marker cites the diff-base sha, not current HEAD", async () => {
  const root = makeRepo(FIXTURE_FILES);
  seedComprehended(root);
  seedFindingReread(root, "F-SEC-0104");
  const state = sealState(root);
  const baseSha7 = headOf(root).slice(0, 7); // the diff base (pins.comprehend)
  commitChange(root, "src/util.js", "export function add(a, b) { return a + b; } // moved\n");
  const headSha7 = headOf(root).slice(0, 7); // current HEAD after the change
  assert.notEqual(baseSha7, headSha7);

  // UNCERTAIN → finding stays stale, so annotateStale's marker survives verbatim.
  const llm = makeFakeLLM({ codemap: "- updated", verdict: { verdict: "UNCERTAIN" } });
  const dotdir = path.join(root, ".dobetter");
  await run(makeCtx(root, { state, llm }));

  const f = readArtifact(dotdir, "findings/F-SEC-0104.md");
  assert.match(f.body, new RegExp(`changed since ${baseSha7}`), "stale marker cites the diff-base sha");
  assert.doesNotMatch(f.body, new RegExp(`changed since ${headSha7}`), "stale marker does NOT cite current HEAD");
});
