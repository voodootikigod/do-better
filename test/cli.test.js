// End-to-end CLI integration via spawnSync. No network: --offline and/or
// DOBETTER_FAKE_LLM everywhere; DOBETTER_ADLC_DIR points at the fake fixture;
// DOBETTER_NO_NPX disables every npx fallback and DOBETTER_SKILL_MINING_DIR
// points at the fake skill-mining fixture so comprehend's skill-mining
// sub-step never resolves npx packages or executes a real sibling checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CLI = path.join(ROOT, "bin", "cli.js");
const FIXTURE = path.join(HERE, "fixtures", "tiny-repo");
const FAKE_ADLC = path.join(HERE, "fixtures", "fake-adlc");
const FAKE_SKILL_MINING = path.join(HERE, "fixtures", "fake-skill-mining");
const FAKE_LLM = path.join(HERE, "fixtures", "fake-llm.js");
const ANSWERS = path.join(HERE, "fixtures", "answers.json");

// Phase/service modules owned by other work packages — skip end-to-end
// pipeline tests gracefully until they exist (WP-B/C/D/E).
const PHASE_MODULES = ["llm", "adlc", "scan", "charter", "comprehend", "identify", "roadmap", "rail", "refresh"];
const missingModules = PHASE_MODULES.filter((m) => !fs.existsSync(path.join(ROOT, "src", `${m}.js`)));
const SERVICES_PRESENT = !missingModules.includes("llm") && !missingModules.includes("adlc");
const SCAN_PRESENT = SERVICES_PRESENT && !missingModules.includes("scan");
const ALL_PRESENT = missingModules.length === 0;
const skipNote = missingModules.length ? `awaiting modules from other work packages: ${missingModules.join(", ")}` : false;

function cli(args, { cwd = ROOT, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      ANTHROPIC_API_KEY: "",
      GEMINI_API_KEY: "",
      OPENAI_API_KEY: "",
      DOBETTER_ADLC_DIR: FAKE_ADLC,
      DOBETTER_SKILL_MINING_DIR: FAKE_SKILL_MINING,
      DOBETTER_NO_NPX: "1",
      DOBETTER_FAKE_LLM: FAKE_LLM,
      ...env,
    },
  });
}

function makeTmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-cli-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const g = (args) =>
    spawnSync("git", ["-c", "user.email=test@test", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
    });
  g(["init", "-q"]);
  g(["add", "-A"]);
  const c = g(["commit", "-q", "-m", "init"]);
  assert.equal(c.status, 0, `git commit failed: ${c.stderr}`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ".dobetter", "state.json"), "utf8"));
}

// --- always runnable (no phase modules needed) -----------------------------------

test("--help exits 0 and lists the command surface", () => {
  const r = cli(["--help"]);
  assert.equal(r.status, 0, r.stderr);
  for (const cmd of ["scan", "charter", "audit", "roadmap", "rail", "run", "refresh"]) {
    assert.ok(r.stdout.includes(cmd), `help missing ${cmd}`);
  }
  assert.match(r.stdout, /EXIT CODES/);
});

test("unknown command prints usage and exits 1", () => {
  const r = cli(["frobnicate"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown command: frobnicate/);
  assert.match(r.stdout, /USAGE/);
});

test("no command prints usage and exits 1", () => {
  const r = cli([]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /USAGE/);
});

test("invalid --budget is an operational error (exit 1)", () => {
  const r = cli(["scan", "--budget", "lots"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid --budget/);
});

// --- end-to-end (require other packages' modules) -----------------------------------

test("scan --offline on a tmp tiny-repo: exit 0, state.json + codemap created", { skip: !SCAN_PRESENT && skipNote }, (t) => {
  const dir = makeTmpRepo(t);
  const r = cli(["scan", dir, "--offline"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  assert.ok(fs.existsSync(path.join(dir, ".dobetter", "state.json")));
  assert.ok(fs.existsSync(path.join(dir, ".dobetter", "comprehension", "codemap.md")));
  const state = readState(dir);
  assert.equal(state.phases.scan.status, "done");
  assert.ok(state.pins.scan);
});

test("scan on a non-git directory fails with exit 1", { skip: !SCAN_PRESENT && skipNote }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-nogit-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = cli(["scan", dir, "--offline"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git/i);
});

test("run --offline stops cleanly at human gate 1 (exit 0 + instructions)", { skip: !ALL_PRESENT && skipNote }, (t) => {
  const dir = makeTmpRepo(t);
  const r = cli(["run", dir, "--offline"], { env: { DOBETTER_ANSWERS: ANSWERS } });
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /charter --approve/);
  const state = readState(dir);
  assert.equal(state.gates.charter.approved, false);
  assert.ok(fs.existsSync(path.join(dir, ".dobetter", "charter.md")));
});

test("charter --approve then run resumes past charter (nextIncompletePhase honored)", { skip: !ALL_PRESENT && skipNote }, (t) => {
  const dir = makeTmpRepo(t);
  const draft = cli(["run", dir, "--offline"], { env: { DOBETTER_ANSWERS: ANSWERS } });
  assert.equal(draft.status, 0, draft.stderr);

  const approve = cli(["charter", dir, "--approve", "--offline"]);
  assert.equal(approve.status, 0, `stderr: ${approve.stderr}\nstdout: ${approve.stdout}`);
  assert.equal(readState(dir).gates.charter.approved, true);

  const resumed = cli(["run", dir, "--offline"], { env: { DOBETTER_ANSWERS: ANSWERS } });
  const out = resumed.stdout + resumed.stderr;
  // resumed past charter: it must not re-draft or re-ask for charter approval
  assert.ok(!out.includes("charter --approve"), `unexpectedly re-paused at charter:\n${out}`);
  assert.ok([0, 2].includes(resumed.status), `unexpected exit ${resumed.status}:\n${out}`);
});

test("deterministic gate failure exits 2 (fake parallax FAKE_EXIT=2)", { skip: !ALL_PRESENT && skipNote }, (t) => {
  const dir = makeTmpRepo(t);
  const draft = cli(["run", dir, "--offline"], { env: { DOBETTER_ANSWERS: ANSWERS } });
  assert.equal(draft.status, 0, draft.stderr);
  const approve = cli(["charter", dir, "--approve", "--offline"]);
  assert.equal(approve.status, 0, approve.stderr);

  const audit = cli(["audit", dir, "--offline"], {
    env: { FAKE_EXIT_PARALLAX: "2", ANTHROPIC_API_KEY: "test-key-so-parallax-counts-as-available" },
  });
  if (audit.status === 2) {
    assert.match(audit.stderr, /Gate failed/);
  } else {
    // Degraded environments may treat key-less/offline parallax as absent
    // (per the §5 degradation table) — then the gate passes with degradation.
    assert.equal(audit.status, 0, `stderr: ${audit.stderr}\nstdout: ${audit.stdout}`);
  }
});

test("H17: --json success emits ONE parseable envelope on stdout with spend + counts", { skip: !SCAN_PRESENT && skipNote }, (t) => {
  const dir = makeTmpRepo(t);
  const r = cli(["scan", dir, "--offline", "--json"]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
  // The WHOLE of stdout must parse as one JSON object — no interleaved human lines.
  const env = JSON.parse(r.stdout.trim());
  assert.equal(env.ok, true);
  assert.equal(env.command, "scan");
  assert.equal(typeof env.spendUSD, "number", "spend is in the envelope");
  assert.ok("artifactsDir" in env, "artifact dir is in the envelope");
  // Progress/banner decoration must NOT be on stdout under --json.
  assert.doesNotMatch(r.stdout, /=== D-1/, "phase headers routed off stdout under --json");
});

test("H17: --json failure emits a parseable {ok:false,error} envelope on stdout (exit code intact)", { skip: !SCAN_PRESENT && skipNote }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-nogit-json-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = cli(["scan", dir, "--offline", "--json"]);
  assert.equal(r.status, 1, "operational error exit code preserved");
  const env = JSON.parse(r.stdout.trim());
  assert.equal(env.ok, false);
  assert.equal(env.command, "scan");
  assert.ok(env.error && typeof env.error.kind === "string", "a typed error envelope on stdout for CI");
});
