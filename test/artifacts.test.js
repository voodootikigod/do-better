import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpError } from "../src/utils.js";
import {
  LAYOUT,
  annotateStale,
  ensureLayout,
  formatCitation,
  parseCitations,
  parseFrontmatter,
  readArtifact,
  readFindings,
  readTickets,
  runReproCheck,
  serializeFrontmatter,
  validateTicket,
  verifyCitations,
  writeArtifact,
  writeFinding,
  writeTickets,
} from "../src/artifacts.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tiny-repo");

function tmpdir(t, prefix = "dobetter-artifacts-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function tmpRepo(t) {
  const dir = tmpdir(t, "dobetter-repo-");
  fs.cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

// --- layout ----------------------------------------------------------------------

test("LAYOUT encodes the §3 artifact layout verbatim", () => {
  assert.equal(LAYOUT.charter, "charter.md");
  assert.equal(LAYOUT.comprehension.behaviorInventory, "comprehension/behavior-inventory.md");
  assert.equal(LAYOUT.comprehension.coverageManifest, "comprehension/coverage-manifest.md");
  assert.equal(LAYOUT.findingsDir, "findings");
  assert.equal(LAYOUT.roadmap, "ROADMAP.md");
  assert.equal(LAYOUT.backlogJson, "backlog/tickets.json");
  assert.equal(LAYOUT.railsManifest, "rails/manifest.md");
  assert.equal(LAYOUT.state, "state.json");
});

test("ensureLayout creates all dirs once and is idempotent", (t) => {
  const dotdir = path.join(tmpdir(t), ".dobetter");
  const created = ensureLayout(dotdir);
  assert.ok(created.length >= 5);
  for (const sub of ["comprehension", "findings", "backlog", "rails", "tmp"]) {
    assert.ok(fs.statSync(path.join(dotdir, sub)).isDirectory(), `${sub} missing`);
  }
  assert.deepEqual(ensureLayout(dotdir), []);
});

// --- frontmatter codec ---------------------------------------------------------

test("frontmatter codec round-trips scalars, arrays, and one-level nesting", () => {
  const meta = {
    title: "Hello: world",
    approved: false,
    count: 3,
    ratio: 0.25,
    nothing: null,
    tags: ["a", "b c", 'quoted "x"', 7, true],
    weights: { security: 5, "test-quality": 3, label: "Maintainability / debt" },
  };
  const body = "\n# Body\n\nsome text\n";
  const text = serializeFrontmatter(meta, body);
  const parsed = parseFrontmatter(text);
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.body, body);
});

test("frontmatter codec: no frontmatter → empty meta, body unchanged", () => {
  const { meta, body } = parseFrontmatter("# Just a doc\n");
  assert.deepEqual(meta, {});
  assert.equal(body, "# Just a doc\n");
});

test("frontmatter codec rejects deeper nesting and non-scalar arrays", () => {
  assert.throws(() => serializeFrontmatter({ a: { b: { c: 1 } } }, ""), OpError);
  assert.throws(() => serializeFrontmatter({ a: [{ b: 1 }] }, ""), OpError);
  assert.throws(
    () => parseFrontmatter("---\na:\n  b:\n    c: 1\n---\nbody"),
    OpError,
  );
  assert.throws(() => parseFrontmatter("---\na: [[1], 2]\n---\n"), OpError);
  assert.throws(() => parseFrontmatter("---\nunterminated: true\n"), /Unterminated/);
  assert.throws(() => parseFrontmatter("---\n- block: array\n---\n"), OpError);
});

// --- artifact I/O ----------------------------------------------------------------

test("writeArtifact/readArtifact round-trip; readArtifact null on missing", (t) => {
  const dotdir = tmpdir(t);
  const abs = writeArtifact(dotdir, "comprehension/codemap.md", {
    meta: { generatedBy: "scan", draft: true },
    body: "\n# Codemap\n",
  });
  assert.ok(abs.endsWith(path.join("comprehension", "codemap.md")));
  const back = readArtifact(dotdir, "comprehension/codemap.md");
  assert.deepEqual(back.meta, { generatedBy: "scan", draft: true });
  assert.equal(back.body, "\n# Codemap\n");
  assert.equal(readArtifact(dotdir, "nope.md"), null);
  assert.throws(() => writeArtifact(dotdir, "../escape.md", { body: "x" }), OpError);
});

// --- citations -------------------------------------------------------------------

test("formatCitation/parseCitations vectors and dedupe", () => {
  const c = { file: "src/a.js", line: 12, sha: "a1b2c3d" };
  assert.equal(formatCitation(c), "src/a.js:12@a1b2c3d");
  const text =
    "see src/a.js:12@a1b2c3d and again src/a.js:12@A1B2C3D plus " +
    "lib/b.py:3@abcdef0123456789abcdef0123456789abcdef01 but not src/a.js:12 (no sha) " +
    "nor file.js:0@zzzzzzz (bad sha)";
  const parsed = parseCitations(text);
  assert.deepEqual(parsed, [
    { file: "src/a.js", line: 12, sha: "a1b2c3d" },
    { file: "lib/b.py", line: 3, sha: "abcdef0123456789abcdef0123456789abcdef01" },
  ]);
  assert.deepEqual(parseCitations("no citations here"), []);
});

test("verifyCitations: deterministic file+line check against the worktree", (t) => {
  const repo = tmpRepo(t);
  const good = { file: "src/util.js", line: 2, sha: "1234567" };
  const tooFar = { file: "src/util.js", line: 9999, sha: "1234567" };
  const missing = { file: "src/nope.js", line: 1, sha: "1234567" };
  const unsafe = { file: "../etc/passwd", line: 1, sha: "1234567" };
  const { verified, failed } = verifyCitations(repo, [good, tooFar, missing, unsafe]);
  assert.deepEqual(verified, [good]);
  assert.equal(failed.length, 3);
  assert.match(failed.find((f) => f.citation === tooFar).reason, /out of range/);
  assert.match(failed.find((f) => f.citation === missing).reason, /not found/);
  assert.match(failed.find((f) => f.citation === unsafe).reason, /unsafe/);
});

// --- findings --------------------------------------------------------------------

const FINDING = {
  id: "F-SECU-0001",
  dimension: "security",
  title: "Hardcoded version string",
  severity: "medium",
  confidence: 0.8,
  evidence: [{ file: "src/server.js", line: 21, sha: "a1b2c3d" }],
  reproduction: { method: "command", record: "node -e \"process.exit(0)\"", exitCode: 0 },
  status: "verified",
  foundAt: "2026-06-12T00:00:00.000Z",
  headSha: "a".repeat(40),
  stale: false,
};

test("writeFinding/readFindings round-trip", (t) => {
  const dotdir = tmpdir(t);
  const abs = writeFinding(dotdir, FINDING);
  assert.ok(abs.endsWith(path.join("findings", "F-SECU-0001.md")));
  const all = readFindings(dotdir);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0], FINDING);
});

test("writeFinding/readFindings round-trip preserves the machine-re-runnable reproduction (claim/cmd/check)", (t) => {
  const dotdir = tmpdir(t);
  const finding = {
    ...FINDING,
    id: "F-MAIN-0002",
    claim: "TODO/FIXME/HACK marker indicates acknowledged unaddressed debt (line 6)",
    reproduction: {
      method: "static",
      record: "repro-check regex /\\b(TODO|FIXME|HACK)\\b/ in src/server.js: matched",
      exitCode: null,
      check: { type: "regex", pattern: "\\b(TODO|FIXME|HACK)\\b", flags: "", file: "src/server.js" },
    },
  };
  writeFinding(dotdir, finding);
  const cmdFinding = {
    ...FINDING,
    id: "F-SECU-0003",
    reproduction: {
      method: "command",
      record: "$ node -e <snippet>\nexit 0\n",
      exitCode: 0,
      cmd: ["node", "-e", "process.exit(0)"],
    },
  };
  writeFinding(dotdir, cmdFinding);
  const all = readFindings(dotdir);
  assert.deepEqual(all.find((f) => f.id === "F-MAIN-0002"), finding);
  assert.deepEqual(all.find((f) => f.id === "F-SECU-0003"), cmdFinding);
});

test("runReproCheck re-runs persisted check specs deterministically; unknown specs are unknowable (null)", (t) => {
  const repo = tmpRepo(t);
  const grep = (pattern, file) => runReproCheck(repo, { type: "regex", pattern, file });
  assert.equal(grep("\\bversion\\b", "package.json").ok, true);
  assert.equal(grep("ZZZ_NO_SUCH_MARKER", "package.json").ok, false);
  assert.equal(grep("anything", "src/deleted.js").ok, false, "cited file gone → no longer reproduces");
  assert.equal(runReproCheck(repo, { type: "mystery" }).ok, null, "unknown type is unknowable, never resolved");
  assert.equal(runReproCheck(repo, { type: "regex", pattern: "x", file: "../etc/passwd" }).ok, null, "unsafe path is unknowable");
  assert.equal(runReproCheck(repo, { type: "no-readme" }).ok, !fs.existsSync(path.join(repo, "README.md")));
});

test("writeFinding refuses unverified findings and bad shapes (fail closed)", (t) => {
  const dotdir = tmpdir(t);
  assert.throws(() => writeFinding(dotdir, { ...FINDING, status: "unverified" }), /never written/);
  assert.throws(() => writeFinding(dotdir, { ...FINDING, severity: "catastrophic" }), OpError);
  assert.throws(() => writeFinding(dotdir, { ...FINDING, evidence: [] }), OpError);
  assert.throws(() => writeFinding(dotdir, { ...FINDING, confidence: 2 }), OpError);
  assert.equal(readFindings(dotdir).length, 0);
});

test("readFindings skips corrupt files with a warning", (t) => {
  const dotdir = tmpdir(t);
  writeFinding(dotdir, FINDING);
  fs.writeFileSync(path.join(dotdir, "findings", "BAD.md"), "---\n- not: [valid\n---\nx");
  fs.writeFileSync(path.join(dotdir, "findings", "EMPTY.md"), "no frontmatter at all");
  const all = readFindings(dotdir);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "F-SECU-0001");
});

// --- tickets ---------------------------------------------------------------------

const TICKETS = [
  {
    id: "T1",
    title: "Fix hardcoded version",
    body: "Motivation: findings/F-SECU-0001.md\n\nAcceptance Criteria:\n- a command whose output is asserted: `tiny-tool greet` prints the package version",
    scope: ["src/server.js"],
    rails: ["test/dobetter-rails/B-001.rail.test.js"],
    edges: [{ to: "T2", contract: "src/util.js" }],
    duration: 1,
    category: "correctness",
  },
  {
    id: "T2",
    title: "Extract version helper",
    body: "Self-contained body",
    scope: ["src/util.js"],
    rails: [],
    edges: [],
    duration: 2,
    category: "maintainability",
    budget: 5,
  },
];

test("writeTickets/readTickets round-trip; tickets.json matches the aidlc schema", (t) => {
  const dotdir = tmpdir(t);
  writeTickets(dotdir, TICKETS);
  const raw = JSON.parse(fs.readFileSync(path.join(dotdir, "backlog", "tickets.json"), "utf8"));
  assert.deepEqual(Object.keys(raw), ["tickets"]);
  assert.deepEqual(raw.tickets, TICKETS);
  assert.deepEqual(readTickets(dotdir), TICKETS);
  // one markdown file per ticket
  assert.ok(fs.existsSync(path.join(dotdir, "backlog", "T1.md")));
  assert.ok(fs.existsSync(path.join(dotdir, "backlog", "T2.md")));
  const t1 = readArtifact(dotdir, "backlog/T1.md");
  assert.equal(t1.meta.id, "T1");
  assert.deepEqual(t1.meta.rails, ["test/dobetter-rails/B-001.rail.test.js"]);
  assert.match(t1.body, /T2 — contract: src\/util\.js/);
});

test("readTickets: [] when no backlog yet", (t) => {
  assert.deepEqual(readTickets(tmpdir(t)), []);
});

test("validateTicket mirrors aidlc rules", () => {
  const ids = ["T1", "T2"];
  assert.deepEqual(validateTicket(TICKETS[0], ids), []);
  assert.deepEqual(validateTicket(TICKETS[1], ids), []);
  const errs = validateTicket(
    { id: "T3", title: "", body: "", scope: "src", rails: [], edges: [{ to: "T9" }], duration: 0, category: "" },
    ids,
  );
  assert.ok(errs.some((e) => /title/.test(e)));
  assert.ok(errs.some((e) => /body/.test(e)));
  assert.ok(errs.some((e) => /scope/.test(e)));
  assert.ok(errs.some((e) => /unknown ticket "T9"/.test(e)));
  assert.ok(errs.some((e) => /contract/.test(e)));
  assert.ok(errs.some((e) => /duration/.test(e)));
  assert.ok(errs.some((e) => /category/.test(e)));
  assert.deepEqual(validateTicket({ ...TICKETS[1], budget: -1 }, ids), [
    "budget must be a positive number when present",
  ]);
});

// --- stale annotation -------------------------------------------------------------

test("annotateStale flags lines citing changed files and is idempotent", () => {
  const body = [
    "# Behaviors",
    "- B-001 GET /health — src/server.js:14@a1b2c3d",
    "- B-002 CLI greet — bin/tool.js:8@a1b2c3d",
    "no citation line",
  ].join("\n");
  const opts = { changedFiles: ["src/server.js"], asOfSha: "a1b2c3d", now: "2026-06-12T00:00:00.000Z" };
  const first = annotateStale(body, opts);
  assert.equal(first.staleCount, 1);
  const lines = first.body.split("\n");
  const idx = lines.findIndex((l) => l.includes("B-001"));
  assert.match(lines[idx - 1], /^> ⚠ STALE @ 2026-06-12T00:00:00\.000Z \(changed since a1b2c3d\):/);
  assert.ok(!first.body.split("\n")[lines.findIndex((l) => l.includes("B-002")) - 1].startsWith("> ⚠ STALE"));
  // idempotent
  const second = annotateStale(first.body, opts);
  assert.equal(second.body, first.body);
  assert.equal(second.staleCount, 1);
});
