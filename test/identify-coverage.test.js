// test/identify-coverage.test.js — T1 acceptance criteria for the D2
// coverage-driven dry loop: partitionSlices (AC1), the break-bug regression
// (AC2), per-(dimension × packet) coverage (AC3), the starvation gate (AC4),
// the D2 finder coverage manifest section (AC5), and persisted per-cell dry
// state across resumes (AC8). No network ever: DOBETTER_FAKE_LLM seam or
// --offline in every phase-touching test (house style per test/identify.test.js
// and test/identify-rails.test.js — helpers live inline, not in src/).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as identify from "../src/identify.js";
import * as utils from "../src/utils.js";
import * as stateMod from "../src/state.js";
import * as artifacts from "../src/artifacts.js";
import * as llmMod from "../src/llm.js";

const { GateError, BudgetError, TAXONOMY } = utils;
const { PACKET_BYTES } = identify;

// ---------------------------------------------------------------------------
// Fixture helpers (inline, house style)
// ---------------------------------------------------------------------------

function sh(cwd, cmd, args) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

// One dimension weighted above the rest so processing order is deterministic
// (security first, descending weight) without hardcoding the taxonomy list.
const ALL_WEIGHTS = Object.fromEntries(TAXONOMY.map((d) => [d.id, d.id === "security" ? 5 : 1]));

const quietLog = {
  info() {}, success() {}, warn() {}, error() {}, phase() {}, gate() {},
  step() {}, substep() {}, errorTrace() {},
};

const ABSENT_ADLC = Object.freeze({
  mode: "absent", dir: null, probedAt: null,
  available: {
    parallax: false, coldstart: false, "hollow-test": false,
    "behavior-diff": false, preflight: false, "skill-mining": false,
  },
});

// A repo with caller-supplied source files. Every file is committed so
// citation verification and headSha pinning have real ground to check against.
function makeRepo(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-cov-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "tiny", version: "1.0.0", type: "module" }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(root, "README.md"), "# tiny\n");
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  sh(root, "git", ["init", "-q"]);
  sh(root, "git", ["add", "-A"]);
  sh(root, "git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  const headSha = sh(root, "git", ["rev-parse", "HEAD"]);
  return { root, dotdir: path.join(root, ".dobetter"), headSha };
}

function bumpSha(root) {
  sh(root, "git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "bump"]);
  return sh(root, "git", ["rev-parse", "HEAD"]);
}

function comprehendPassedState({ headSha, now }) {
  let s = stateMod.defaultState({ headSha, now });
  s = stateMod.recordPhase(s, "scan", { status: "done", sha: headSha, now });
  s = stateMod.setGate(s, "charter", { approved: true, approvedAt: now, charterSha256: "0".repeat(64) });
  s = stateMod.setGate(s, "comprehend", { passed: true, divergence: 0.1 });
  s = stateMod.recordPhase(s, "comprehend", { status: "done", sha: headSha, now });
  return s;
}

function writeComprehensionInputs(dotdir, headSha, now, deepReadFiles) {
  artifacts.ensureLayout(dotdir);
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.charter, {
    meta: { approved: true, headSha, generatedAt: now, intent: "stabilize", weights: ALL_WEIGHTS },
    body: "# Charter\n\nPain: stability.\n",
  });
  artifacts.writeArtifact(dotdir, artifacts.LAYOUT.comprehension.coverageManifest, {
    meta: { headSha, generatedAt: now, deepPct: 100, scanPct: 0, skipPct: 0 },
    body: [
      "# Coverage Manifest", "",
      "## Deep-read files",
      ...deepReadFiles.map((f) => `- ${f}`), "",
      "## Scanned files", "- (none)", "",
      "## Skipped files", "- (none)", "",
      "## Degradations", "- (none)",
    ].join("\n") + "\n",
  });
}

// Writes a DOBETTER_FAKE_LLM module from a source string.
function writeFake(t, source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-cov-fake-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "fake-llm.mjs");
  fs.writeFileSync(file, source);
  return file;
}

// A fake that logs every call as one JSON line ({label, prompt}) and returns
// empty candidates for every finder (so all cells go dry, gate passes) — used
// to inspect which packet content reached which dimension's finder prompts.
function emptyFinderFake(logFile) {
  return [
    'import fs from "node:fs";',
    `const logFile = ${JSON.stringify(logFile)};`,
    "export default async function fake({ prompt = '', label = '', jsonMode }) {",
    "  fs.appendFileSync(logFile, JSON.stringify({ label, prompt }) + '\\n');",
    "  if (label.includes('finder')) return '{\"candidates\":[]}';",
    "  if (label.includes('verdict')) return '{\"verdict\":\"KILL\"}';",
    "  return '{\"reproCmd\":null}';",
    "}",
  ].join("\n");
}

function readLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function makeLogFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dobetter-cov-log-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "calls.jsonl");
}

function makeCtx({ root, dotdir, state, fakeFile = null, offline = false, budget = null }) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; delete env.GEMINI_API_KEY;
  delete env.DOBETTER_FAKE_LLM;
  if (!offline && fakeFile) env.DOBETTER_FAKE_LLM = fakeFile;
  const flags = {
    command: "audit", target: root, provider: null, budget, offline,
    modelCheap: "claude-haiku-4-5", modelMid: "claude-sonnet-4-6", modelFrontier: "claude-opus-4-8",
    n: null, threshold: null, approve: false, yes: false, json: false, help: false,
  };
  const llm = llmMod.createLLM({ flags, state, env });
  return {
    root, dotdir, state, llm, adlc: ABSENT_ADLC, flags, log: quietLog,
    now: () => new Date().toISOString(), exec: utils.makeExec(), ask: null,
  };
}

// A single-line source file whose rendered chunk lands in [half, full) of
// PACKET_BYTES: big enough that two files cannot share a packet, small enough
// to never be truncated. Used to force one-file-per-packet fixtures.
function packetSizedFile(marker) {
  return `${marker} ` + "a".repeat(Math.floor(PACKET_BYTES * 0.55));
}

// ---------------------------------------------------------------------------
// AC1 — partitionSlices (unit): covers every slice once; oversized → singleton
// truncated packet; never [] for non-empty input.
// ---------------------------------------------------------------------------

test("AC1: partitionSlices covers every slice exactly once; oversized → singleton truncated; never [] for non-empty", () => {
  const maxBytes = 80;
  const slices = [
    { file: "a.js", raw: "aaa" },
    { file: "b.js", raw: "bbb" },
    { file: "big.js", raw: "x\n".repeat(400) }, // rendered chunk ≫ maxBytes
    { file: "c.js", raw: "ccc" },
  ];
  const packets = identify.partitionSlices(slices, maxBytes);

  // Every readable slice appears in exactly one packet, in input order.
  assert.deepEqual(packets.flatMap((p) => p.files), ["a.js", "b.js", "big.js", "c.js"]);

  // The oversized slice is its own singleton packet, hard-truncated —
  // asserted on ACTUAL truncated content, not just length. A regression that
  // makes the oversized-chunk branch skip the slice entirely (falling through
  // to the "(no deep-read slices available)" fallback) would still satisfy a
  // length-only check, since the fallback string is short too — it must not
  // satisfy this one.
  const big = packets.find((p) => p.files.length === 1 && p.files[0] === "big.js");
  assert.ok(big, "oversized slice becomes a singleton packet");
  assert.ok(big.packet.length <= maxBytes, `oversized packet is truncated to ≤ maxBytes (got ${big.packet.length})`);
  assert.notEqual(big.packet, "(no deep-read slices available)", "the oversized slice must be truncated, not silently dropped");
  assert.ok(big.packet.startsWith("\n=== big.js ==="), `truncated packet keeps the exact file delimiter, got ${JSON.stringify(big.packet.slice(0, 30))}`);
  assert.ok(big.packet.includes("\n1: x"), "the numbered content starts at line 1 (not shifted), and real body content survived truncation");

  // No packet ever exceeds the budget.
  for (const p of packets) assert.ok(p.packet.length <= maxBytes, `packet within budget (got ${p.packet.length})`);

  // Non-empty input never yields []; empty input yields [].
  assert.ok(packets.length >= 1);
  assert.deepEqual(identify.partitionSlices([], maxBytes), []);

  // A lone oversized slice still produces exactly one (truncated) packet.
  const lone = identify.partitionSlices([{ file: "huge.js", raw: "y\n".repeat(1000) }], maxBytes);
  assert.equal(lone.length, 1);
  assert.deepEqual(lone[0].files, ["huge.js"]);
  assert.ok(lone[0].packet.length <= maxBytes);
  assert.ok(lone[0].packet.startsWith("\n=== huge.js ==="));
  assert.ok(lone[0].packet.includes("\n1: y"));

  // Boundary: two small slices whose COMBINED chunk length lands exactly at
  // maxBytes must share one packet — groupBytes starts at 0 (and resets to 0
  // after each flush), so "0 + combined === maxBytes" is not ">" and they are
  // never split. An off-by-one in the initial or reset accumulator value
  // would flush after the first slice, splitting a pair that should have
  // shared a packet. Self-calibrated from the real render format rather than
  // hand-counted, so the fixture can't silently drift out of sync with it.
  const prefixLen = (file) => `\n=== ${file} ===\n1: `.length;
  const chunkLenFor = (file, raw) => prefixLen(file) + raw.length + 1;
  const rawA = "a".repeat(20);
  const chunkA = chunkLenFor("pair-a.js", rawA);
  const rawB = "b".repeat(maxBytes - chunkA - prefixLen("pair-b.js") - 1);
  const chunkB = chunkLenFor("pair-b.js", rawB);
  assert.equal(chunkA + chunkB, maxBytes, "fixture calibrated so the pair's combined chunk length is exactly maxBytes");
  const pairPackets = identify.partitionSlices(
    [{ file: "pair-a.js", raw: rawA }, { file: "pair-b.js", raw: rawB }],
    maxBytes,
  );
  assert.equal(pairPackets.length, 1, "two slices whose combined chunk length is exactly maxBytes share one packet, not two");
  assert.deepEqual(pairPackets[0].files, ["pair-a.js", "pair-b.js"]);

  // Same boundary, chained a second time — exercises the POST-FLUSH reset
  // specifically. After the a+b pair is flushed, groupBytes must reset to 0,
  // not 1, or a SECOND pair (c+d, also calibrated to sum to exactly maxBytes)
  // built on top of that stale offset would flush after c alone instead of
  // sharing a packet with d.
  const rawC = "c".repeat(20);
  const chunkC = chunkLenFor("pair-c.js", rawC);
  const rawD = "d".repeat(maxBytes - chunkC - prefixLen("pair-d.js") - 1);
  const chunkD = chunkLenFor("pair-d.js", rawD);
  assert.equal(chunkC + chunkD, maxBytes, "second pair also calibrated to sum to exactly maxBytes");
  const chainedPackets = identify.partitionSlices(
    [
      { file: "pair-a.js", raw: rawA }, { file: "pair-b.js", raw: rawB },
      { file: "pair-c.js", raw: rawC }, { file: "pair-d.js", raw: rawD },
    ],
    maxBytes,
  );
  assert.deepEqual(chainedPackets.flatMap((p) => p.files), ["pair-a.js", "pair-b.js", "pair-c.js", "pair-d.js"]);
  assert.equal(chainedPackets.length, 2, "both exact-maxBytes pairs land in their own shared packet (2 total), not 4 — proves the post-flush reset is exact, not off-by-one");
  assert.deepEqual(chainedPackets[0].files, ["pair-a.js", "pair-b.js"]);
  assert.deepEqual(chainedPackets[1].files, ["pair-c.js", "pair-d.js"]);
});

// ---------------------------------------------------------------------------
// AC2 — break-bug regression: an oversized slice at the head made the OLD
// builder return an empty packet (break, not skip), silently dropping every
// following file. The new partitioning surfaces the other file in its own
// packet, and the fake finder receives its content.
// ---------------------------------------------------------------------------

// Faithful copy of main's buildFinderPacket (the break version) — the bug this
// AC pins. Kept local so the test proves both the old failure and the new fix.
function oldBuildFinderPacket(slices, maxBytes) {
  let packet = "";
  for (const s of slices) {
    const numbered = s.raw.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
    const chunk = `\n=== ${s.file} ===\n${numbered}\n`;
    if (packet.length + chunk.length > maxBytes) break; // the bug: break, not skip
    packet += chunk;
  }
  return packet || "(no deep-read slices available)";
}

test("AC2: an oversized head slice no longer hides following files — the finder receives the other file's content", async (t) => {
  // bigFirst.js: enough short lines that its NUMBERED form exceeds PACKET_BYTES
  // (line-number prefixes push it over even though the raw is under SLICE_CHARS).
  const bigRaw = "z\n".repeat(9000);
  const smallRaw = 'const marker = "MARKER_SMALL_AC2";\n';
  const slices = [{ file: "bigFirst.js", raw: bigRaw }, { file: "small.js", raw: smallRaw }];

  // Old builder: the oversized head slice trips `break`, so small.js is dropped.
  const old = oldBuildFinderPacket(slices, PACKET_BYTES);
  assert.ok(!old.includes("MARKER_SMALL_AC2"), "old builder drops the following file (the break bug)");

  // New partitioning: the oversized slice is its own truncated packet and
  // small.js gets its own packet — its content is preserved.
  const packets = identify.partitionSlices(slices);
  assert.ok(packets.some((p) => p.packet.includes("MARKER_SMALL_AC2")), "new partitioning covers the following file");

  // Integration: run identify against the same shape and confirm the small
  // file's content actually reaches a finder prompt (fake-LLM prompt log).
  const now = new Date().toISOString();
  const { root, dotdir, headSha } = makeRepo(t, { "bigFirst.js": bigRaw, "small.js": smallRaw });
  writeComprehensionInputs(dotdir, headSha, now, ["bigFirst.js", "small.js"]);
  const logFile = makeLogFile(t);
  const state = comprehendPassedState({ headSha, now });
  const ctx = makeCtx({ root, dotdir, state, fakeFile: writeFake(t, emptyFinderFake(logFile)) });

  const result = await identify.run(ctx);
  assert.equal(result.gate.passed, true);

  const finderPrompts = readLog(logFile).filter((c) => c.label.startsWith("finder:"));
  assert.ok(
    finderPrompts.some((c) => c.prompt.includes("MARKER_SMALL_AC2")),
    "the following file's content reached at least one finder prompt",
  );
});

// ---------------------------------------------------------------------------
// AC3 — with 2 dimensions × 3 packets, every packet's content appears in ≥1
// finder prompt per dimension.
// ---------------------------------------------------------------------------

test("AC3: every packet's content reaches ≥1 finder prompt for each dimension", async (t) => {
  const files = {
    "p1.js": packetSizedFile("MARKER_P1"),
    "p2.js": packetSizedFile("MARKER_P2"),
    "p3.js": packetSizedFile("MARKER_P3"),
  };
  const markers = ["MARKER_P1", "MARKER_P2", "MARKER_P3"];
  const now = new Date().toISOString();
  const { root, dotdir, headSha } = makeRepo(t, files);
  writeComprehensionInputs(dotdir, headSha, now, ["p1.js", "p2.js", "p3.js"]);
  const logFile = makeLogFile(t);
  const state = comprehendPassedState({ headSha, now });
  const ctx = makeCtx({ root, dotdir, state, fakeFile: writeFake(t, emptyFinderFake(logFile)) });

  const result = await identify.run(ctx);
  assert.equal(result.gate.passed, true);
  // 3 files, each its own packet.
  assert.equal(result.state.phases.identify.packetsByDimension.security, 3);

  const calls = readLog(logFile);
  for (const dim of ["security", "correctness"]) {
    const prompts = calls.filter((c) => c.label === `finder:${dim}`).map((c) => c.prompt);
    for (const marker of markers) {
      assert.ok(
        prompts.some((p) => p.includes(marker)),
        `packet ${marker} reached a finder prompt for dimension ${dim}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// AC4 — empty/unreadable deep-read set online → GateError (exit 2); offline is
// exempt (static pass still runs, gate passes, unexamined files recorded).
// ---------------------------------------------------------------------------

test("AC4: an unreadable deep-read set fails the gate online but is exempt offline", async (t) => {
  const now = new Date().toISOString();
  // The declared deep-read file does not exist in the worktree → zero readable
  // slices → zero packets.
  const { root, dotdir, headSha } = makeRepo(t, { "src/real.js": "export const x = 1;\n" });
  writeComprehensionInputs(dotdir, headSha, now, ["src/ghost.js"]);

  // Online: starvation is a gate failure, never a silent zero-finding pass.
  const online = comprehendPassedState({ headSha, now });
  const ctx = makeCtx({ root, dotdir, state: online, fakeFile: writeFake(t, emptyFinderFake(makeLogFile(t))) });
  await assert.rejects(
    () => identify.run(ctx),
    (err) => {
      assert.ok(err instanceof GateError, `expected GateError, got ${err?.constructor?.name}`);
      assert.equal(err.exitCode, 2);
      assert.equal(err.gate, "identify");
      assert.ok(err.state?.gates?.identify?.passed === false);
      assert.match(err.detail, /deep-read|unreadable|readable/i, "detail describes the starvation");
      return true;
    },
  );

  // Offline: exempt — the static pass runs, the gate passes, and the unreadable
  // file is recorded under the coverage manifest's Unexamined subheading.
  const offlineState = comprehendPassedState({ headSha, now });
  const offCtx = makeCtx({ root, dotdir, state: offlineState, offline: true });
  const res = await identify.run(offCtx);
  assert.equal(res.gate.passed, true, "offline is exempt from the starvation gate");
  const manifest = fs.readFileSync(path.join(dotdir, artifacts.LAYOUT.comprehension.coverageManifest), "utf8");
  assert.match(manifest, /### Unexamined/);
  assert.match(manifest, /src\/ghost\.js \(unreadable\)/);
});

// ---------------------------------------------------------------------------
// AC5 — coverage-manifest.md gains a "## D2 finder coverage" section with
// per-dimension entries; re-running replaces it rather than duplicating.
// ---------------------------------------------------------------------------

test("AC5: the D2 finder coverage section is written and re-runs replace it (never duplicate)", async (t) => {
  const now = new Date().toISOString();
  const { root, dotdir, headSha } = makeRepo(t, { "src/util.js": "export const add = (a, b) => a + b;\n" });
  writeComprehensionInputs(dotdir, headSha, now, ["src/util.js"]);
  const manifestPath = path.join(dotdir, artifacts.LAYOUT.comprehension.coverageManifest);

  const first = await identify.run(makeCtx({ root, dotdir, state: comprehendPassedState({ headSha, now }), offline: true }));
  const afterFirst = fs.readFileSync(manifestPath, "utf8");
  assert.match(afterFirst, /## D2 finder coverage/);
  for (const dim of TAXONOMY) assert.match(afterFirst, new RegExp(`### ${dim.id}\\b`), `section lists dimension ${dim.id}`);
  assert.equal((afterFirst.match(/## D2 finder coverage/g) ?? []).length, 1, "exactly one section after first run");
  // The original D1 content survives (section is appended, not clobbered).
  assert.match(afterFirst, /## Deep-read files/);

  await identify.run(makeCtx({ root, dotdir, state: first.state, offline: true }));
  const afterSecond = fs.readFileSync(manifestPath, "utf8");
  assert.equal((afterSecond.match(/## D2 finder coverage/g) ?? []).length, 1, "re-run replaces rather than duplicates the section");
  assert.match(afterSecond, /## Deep-read files/, "the D1 deep-read section is still present after the re-run");
});

// ---------------------------------------------------------------------------
// AC8 — persisted per-cell dry state. After a run that fails the gate (one
// packet never dry), a same-sha re-run skips the packets already recorded dry
// (zero finder calls for them) and resumes the non-dry packet from the recorded
// pool; a sha change discards all dry-cell state (full re-examination).
// ---------------------------------------------------------------------------

// Run-1 fake: security packet A yields ONE confirmable finding then goes dry;
// security packet B never goes dry (a fresh distinct claim every pass). Verdict
// routes off the cited slice: A confirms (written), B kills (never written).
function ac8Fake(logFile) {
  return [
    'import fs from "node:fs";',
    `const logFile = ${JSON.stringify(logFile)};`,
    "let sawA = false;",
    "let n = 0;",
    "export default async function fake({ prompt = '', label = '', jsonMode }) {",
    "  fs.appendFileSync(logFile, JSON.stringify({ label, prompt }) + '\\n');",
    "  if (label.includes('finder')) {",
    "    if (label.includes('finder:security')) {",
    "      if (prompt.includes('MARKER_A')) {",
    "        if (!sawA) { sawA = true; return JSON.stringify({ candidates: [{ title: 'FINDING_A_TITLE', claim: 'CLAIM_A holds', file: 'a.js', line: 1, severity: 'high', confidence: 0.9 }] }); }",
    "        return '{\"candidates\":[]}';",
    "      }",
    "      if (prompt.includes('MARKER_B')) {",
    "        n += 1;",
    "        return JSON.stringify({ candidates: [{ title: 'novel-B-' + n, claim: 'CLAIM_B distinct ' + n, file: 'b.js', line: 1, severity: 'low', confidence: 0.4 }] });",
    "      }",
    "    }",
    "    return '{\"candidates\":[]}';",
    "  }",
    "  if (label.includes('verdict')) {",
    "    return prompt.includes('MARKER_A') ? '{\"verdict\":\"CONFIRM\",\"reason\":\"ok\"}' : '{\"verdict\":\"KILL\",\"reason\":\"no\"}';",
    "  }",
    "  return '{\"reproCmd\":null}';",
    "}",
  ].join("\n");
}

async function runExpectingGate(ctx) {
  try {
    await identify.run(ctx);
    assert.fail("expected the identify gate to fail (a packet never went dry)");
  } catch (err) {
    assert.ok(err instanceof GateError, `expected GateError, got ${err?.constructor?.name}`);
    assert.ok(err.state, "GateError carries state for the resume");
    return err.state;
  }
}

test("AC8: same-sha re-run skips recorded-dry packets and resumes the non-dry one; a sha change re-examines everything", async (t) => {
  const files = { "a.js": packetSizedFile("MARKER_A"), "b.js": packetSizedFile("MARKER_B") };
  const now = new Date().toISOString();
  const { root, dotdir, headSha } = makeRepo(t, files);
  writeComprehensionInputs(dotdir, headSha, now, ["a.js", "b.js"]);

  // Run 1: security is not dry (packet B loops to MAX_PASSES) → gate fails.
  // Packet A (cell 0) goes dry after one confirmed finding.
  const log1 = makeLogFile(t);
  const state1 = await runExpectingGate(makeCtx({ root, dotdir, state: comprehendPassedState({ headSha, now }), fakeFile: writeFake(t, ac8Fake(log1)) }));
  assert.deepEqual(state1.phases.identify.dryCellsByDimension.security, [0], "packet 0 (A) recorded dry");
  assert.equal(state1.phases.identify.dryCellsSha, headSha, "dry-cell state is pinned to the head sha");
  assert.equal(artifacts.readFindings(dotdir).length, 1, "packet A's confirmed finding was written before the gate failed");

  // Run 2: same sha, fresh fake. Packet 0 (A) is skipped entirely — no finder
  // call sees MARKER_A. Packet 1 (B) is re-queried and its finder prompt
  // resumes from the recorded pool (it carries packet A's prior conclusion).
  const log2 = makeLogFile(t);
  await runExpectingGate(makeCtx({ root, dotdir, state: state1, fakeFile: writeFake(t, ac8Fake(log2)) }));
  const finder2 = readLog(log2).filter((c) => c.label === "finder:security").map((c) => c.prompt);
  assert.ok(finder2.length > 0, "packet B was re-queried");
  assert.ok(!finder2.some((p) => p.includes("MARKER_A")), "recorded-dry packet A was NOT re-queried (zero finder calls for it)");
  assert.ok(finder2.some((p) => p.includes("MARKER_B")), "the non-dry packet B was re-queried");
  assert.ok(finder2.some((p) => p.includes("FINDING_A_TITLE")), "the non-dry packet resumed from the recorded pool (prior conclusion carried in)");

  // Run 3: the sha changed → all dry-cell state is discarded → packet A is
  // examined again (full re-examination).
  const newSha = bumpSha(root);
  assert.notEqual(newSha, headSha);
  const log3 = makeLogFile(t);
  await runExpectingGate(makeCtx({ root, dotdir, state: state1, fakeFile: writeFake(t, ac8Fake(log3)) }));
  const finder3 = readLog(log3).filter((c) => c.label === "finder:security").map((c) => c.prompt);
  assert.ok(finder3.some((p) => p.includes("MARKER_A")), "a sha change re-examines the previously-dry packet A");
});

// ---------------------------------------------------------------------------
// Completion guard (adversarial review finding, T1 follow-up): persisted
// dry-cell state must be honored ONLY when the prior identify run did NOT
// complete successfully at this sha. A deliberate re-audit after a SUCCESSFUL
// run (e.g. widening --n to search harder) must re-examine everything, not
// silently skip cells whose dryness was only ever verified at the OLD width.
// ---------------------------------------------------------------------------

test("completion guard: a same-sha re-run AFTER A SUCCESSFUL identify does NOT skip any packet as recorded-dry", async (t) => {
  const files = { "a.js": packetSizedFile("MARKER_A") };
  const now = new Date().toISOString();
  const { root, dotdir, headSha } = makeRepo(t, files);
  writeComprehensionInputs(dotdir, headSha, now, ["a.js"]);

  // Run 1: everything dries immediately with zero candidates → gate PASSES,
  // status becomes "done", and dryCellsByDimension.security is populated
  // (packet 0 recorded dry) at this exact headSha.
  const log1 = makeLogFile(t);
  const ctx1 = makeCtx({ root, dotdir, state: comprehendPassedState({ headSha, now }), fakeFile: writeFake(t, emptyFinderFake(log1)) });
  const result1 = await identify.run(ctx1);
  assert.equal(result1.gate.passed, true);
  assert.equal(result1.state.phases.identify.status, "done", "the prior run completed successfully");
  assert.deepEqual(result1.state.phases.identify.dryCellsByDimension.security, [0], "packet 0 recorded dry on the successful run");
  assert.equal(result1.state.phases.identify.dryCellsSha, headSha);

  // Run 2: SAME sha, SAME state carried forward (as `do-better audit` would
  // do — it always loads persisted state.json and calls identify.run
  // unconditionally, with no check for prior completion). A NEW fake this
  // time returns a genuinely new candidate and logs every finder call it
  // receives. Before the completion guard, run 2 would skip packet 0
  // entirely (dryCellsSha === headSha) and issue ZERO finder calls for it,
  // regardless of what a wider --n or a deliberate re-audit intended.
  const log2 = makeLogFile(t);
  const freshCandidateFake = [
    'import fs from "node:fs";',
    `const logFile = ${JSON.stringify(log2)};`,
    "export default async function fake({ prompt = '', label = '', jsonMode }) {",
    "  fs.appendFileSync(logFile, JSON.stringify({ label, prompt }) + '\\n');",
    "  if (label.includes('finder')) return '{\"candidates\":[]}';",
    "  if (label.includes('verdict')) return '{\"verdict\":\"KILL\"}';",
    "  return '{\"reproCmd\":null}';",
    "}",
  ].join("\n");
  const ctx2 = makeCtx({ root, dotdir, state: result1.state, fakeFile: writeFake(t, freshCandidateFake) });
  const result2 = await identify.run(ctx2);
  assert.equal(result2.gate.passed, true);

  const finder2 = readLog(log2).filter((c) => c.label === "finder:security").map((c) => c.prompt);
  assert.ok(finder2.some((p) => p.includes("MARKER_A")), "packet A WAS re-queried on the fresh audit — the stale dry-cell state from the completed run was correctly discarded, not silently honored");
});

// ---------------------------------------------------------------------------
// Completion guard, round 2 (adversarial review finding): the guard must be
// keyed on a DEDICATED dryCellsComplete marker, not phase `status` — a
// BudgetError never calls recordPhase, so `status` keeps whatever value it
// had BEFORE the interrupted run started. A status-keyed guard therefore
// breaks the exact case it exists to protect: complete a run (status "done")
// -> deliberately re-audit (correctly resets and starts fresh) -> THAT
// re-audit is interrupted mid-flight, persisting its own incremental
// dry-cell progress -> status is STILL "done" (untouched by the
// interruption) -> a status-keyed guard wrongly reads that stale "done" as
// "already complete" and discards the interrupted run's own progress on
// every subsequent resume attempt, never converging under a tight budget.
// ---------------------------------------------------------------------------

test("completion guard, round 2: an interrupted re-audit's OWN dry-cell progress is honored on resume, even though phase status is stale 'done' from the PRIOR completed run", async (t) => {
  const files = { "a.js": packetSizedFile("MARKER_A") };
  const now = new Date().toISOString();
  const { root, dotdir, headSha } = makeRepo(t, files);
  writeComprehensionInputs(dotdir, headSha, now, ["a.js"]);

  // Run 1: completes successfully, exactly as in the test above.
  const log1 = makeLogFile(t);
  const ctx1 = makeCtx({ root, dotdir, state: comprehendPassedState({ headSha, now }), fakeFile: writeFake(t, emptyFinderFake(log1)) });
  const result1 = await identify.run(ctx1);
  assert.equal(result1.gate.passed, true);
  assert.equal(result1.state.phases.identify.status, "done");
  assert.equal(result1.state.phases.identify.dryCellsComplete, true, "completion marker set on genuine success");

  // Simulate the exact interruption scenario: a fresh re-audit was
  // dispatched from result1.state (as `do-better audit` genuinely does —
  // unconditionally, per bin/cli.js), it reset dryCellsComplete to false at
  // its own start, made SOME progress of its own (persisted incrementally,
  // mid-loop, exactly as identify.run's patchPhase calls do), and then was
  // interrupted by something that bypasses recordPhase entirely (a
  // BudgetError propagates straight through the outer catch, which only
  // attaches spend — it never touches `status`). The result: `status` is
  // STILL "done" from run 1 (never rewritten), but `dryCellsComplete` is
  // correctly false, and `dryCellsByDimension`/`dryCellsSha` reflect this
  // interrupted run's OWN progress, not run 1's.
  const interruptedState = {
    ...result1.state,
    phases: {
      ...result1.state.phases,
      identify: {
        ...result1.state.phases.identify,
        status: "done", // stale — untouched by the interruption, exactly the bug condition
        dryCellsComplete: false, // correctly reset at the interrupted run's own start
        dryCellsByDimension: { security: [0] }, // this interrupted run's own progress
        dryCellsSha: headSha,
      },
    },
  };

  // Resume: a fresh fake logs every finder call it receives. If the guard
  // wrongly trusts stale `status === "done"`, it discards the interrupted
  // run's progress and packet A gets re-queried. The fix must NOT do that.
  const log2 = makeLogFile(t);
  const ctx2 = makeCtx({ root, dotdir, state: interruptedState, fakeFile: writeFake(t, emptyFinderFake(log2)) });
  const result2 = await identify.run(ctx2);
  assert.equal(result2.gate.passed, true);

  const finder2 = readLog(log2).filter((c) => c.label === "finder:security").map((c) => c.prompt);
  assert.equal(finder2.length, 0, "packet A was NOT re-queried — the interrupted run's own dry-cell progress was honored on resume, despite stale status:\"done\" from the earlier completed run");
});

// ---------------------------------------------------------------------------
// Completion guard, round 3 (adversarial review finding): the round-2 fix
// discarded stale dry-cell state only IN MEMORY (priorDry = {}) — the
// PERSISTED dryCellsByDimension/dryCellsSha were never cleared at the same
// point. A BudgetError firing before the FIRST per-dimension patchPhase call
// (realistic: it can fire on the very first finder call) left the PRIOR
// completed run's full dry set on disk, now paired with
// dryCellsComplete:false — so the next resume honored run-1's STALE
// determinations instead of re-examining anything, silently defeating the
// deliberate re-audit. This test uses a REAL BudgetError (not a
// hand-constructed state) specifically to exercise the true early-
// interruption window the round-2 test's single-packet fixture couldn't
// distinguish from legitimate own-progress.
// ---------------------------------------------------------------------------

test("completion guard, round 3: an EARLY BudgetError (before any per-dimension persist) does not leave the prior completed run's stale dry set on disk", async (t) => {
  // Two dimensions so there is a genuine "not yet reached" dimension for the
  // early interruption to expose — security (weight 5) is processed before
  // correctness (weight 1) by descending-weight order.
  const files = { "a.js": packetSizedFile("MARKER_A") };
  const now = new Date().toISOString();
  const { root, dotdir, headSha } = makeRepo(t, files);
  writeComprehensionInputs(dotdir, headSha, now, ["a.js"]);

  // Run 1: completes successfully — both security and correctness dry
  // immediately (zero candidates), gate passes.
  const log1 = makeLogFile(t);
  const ctx1 = makeCtx({ root, dotdir, state: comprehendPassedState({ headSha, now }), fakeFile: writeFake(t, emptyFinderFake(log1)) });
  const result1 = await identify.run(ctx1);
  assert.equal(result1.gate.passed, true);
  assert.equal(result1.state.phases.identify.dryCellsComplete, true);
  assert.deepEqual(result1.state.phases.identify.dryCellsByDimension.security, [0]);
  assert.deepEqual(result1.state.phases.identify.dryCellsByDimension.correctness, [0]);

  // Run 2: a genuine fresh re-audit from result1.state, under a budget so
  // tight that the VERY FIRST finder call's projected cost exceeds it —
  // BudgetError fires before the dims loop completes even ONE iteration,
  // i.e. before the first per-dimension patchPhase call. MAX_OUTPUT_TOKENS
  // (16000) alone at the mid-tier fake-pricing floor (~$15/1M out) prices
  // any single call at >= $0.24, so a $0.01 ceiling is guaranteed to reject
  // the first attempt regardless of prompt size.
  const fakeAny = writeFake(t, emptyFinderFake(makeLogFile(t)));
  const ctx2 = makeCtx({ root, dotdir, state: result1.state, fakeFile: fakeAny, budget: 0.01 });
  let interruptedState;
  await assert.rejects(
    () => identify.run(ctx2),
    (err) => {
      assert.ok(err instanceof BudgetError, `expected BudgetError, got ${err?.constructor?.name}`);
      assert.ok(err.state, "BudgetError carries state for the resume");
      // The core round-3 assertion: the PERSISTED dry-cell state must NOT
      // still be run-1's stale full set. It must be empty (nothing yet
      // recorded for this discarded-and-restarted attempt), not
      // {security:[0], correctness:[0]} resurrected from run 1.
      assert.deepEqual(err.state.phases.identify.dryCellsByDimension, {}, "no stale dry-cell data survives the early interruption");
      assert.equal(err.state.phases.identify.dryCellsComplete, false);
      assert.equal(err.state.phases.identify.dryCellsSha, headSha);
      interruptedState = err.state;
      return true;
    },
  );

  // Run 3: resume from the interrupted state with a fresh, budget-unlimited
  // fake that logs every call. BOTH dimensions must be genuinely
  // re-examined — proving the early interruption didn't silently resurrect
  // run-1's stale determinations for either the already-reached-in-memory
  // dimension or (more importantly) the not-yet-reached one.
  const log3 = makeLogFile(t);
  const ctx3 = makeCtx({ root, dotdir, state: interruptedState, fakeFile: writeFake(t, emptyFinderFake(log3)) });
  const result3 = await identify.run(ctx3);
  assert.equal(result3.gate.passed, true);

  const calls3 = readLog(log3);
  assert.ok(calls3.some((c) => c.label === "finder:security"), "security was genuinely re-examined on resume, not skipped via stale run-1 data");
  assert.ok(calls3.some((c) => c.label === "finder:correctness"), "correctness (not yet reached when run 2 was interrupted) was ALSO genuinely re-examined, not silently trusted from run 1");
});

// ---------------------------------------------------------------------------
// Dry-cell content fingerprint (adversarial review finding, round 4): the
// resume cache was keyed ONLY on the commit sha, but packet identity is
// POSITIONAL and content is read from the WORKING TREE, not the committed
// blob. A same-sha resume with uncommitted edits (the realistic budget-stop
// resume flow) could silently skip a packet whose content had actually
// changed since it was recorded dry — never-examined code passing the gate
// vacuously. This is the "simpler variant" from the review's own exploit
// scenario: edit a file's content in the working tree between runs, at a
// CONSTANT commit sha.
// ---------------------------------------------------------------------------

test("dry-cell fingerprint: a same-sha resume with an uncommitted content edit re-examines the changed packet, not skip it as stale-dry", async (t) => {
  const files = { "a.js": packetSizedFile("MARKER_A") };
  const now = new Date().toISOString();
  const { root, dotdir, headSha } = makeRepo(t, files);
  writeComprehensionInputs(dotdir, headSha, now, ["a.js"]);

  // Run 1: completes, packet 0 (a.js, containing MARKER_A) recorded dry, with
  // its fingerprint over MARKER_A's content.
  const log1 = makeLogFile(t);
  const ctx1 = makeCtx({ root, dotdir, state: comprehendPassedState({ headSha, now }), fakeFile: writeFake(t, emptyFinderFake(log1)) });
  const result1 = await identify.run(ctx1);
  assert.equal(result1.gate.passed, true);
  assert.deepEqual(result1.state.phases.identify.dryCellsByDimension.security, [0]);
  const staleFingerprint = result1.state.phases.identify.dryCellsFingerprint;
  assert.ok(staleFingerprint, "run 1 recorded a fingerprint over MARKER_A's content");

  // Simulate a genuine INTERRUPTED resume (not a completed run): the
  // completion guard (rounds 2/3) already forces full re-examination after
  // ANY successful completion, which would make the fingerprint's own effect
  // unobservable if run 2 simply resumed from a completed result1.state —
  // packet 0 would be re-examined regardless of fingerprint match/mismatch,
  // purely because dryCellsComplete was true. Hand-constructing an
  // interrupted-but-not-complete state isolates the fingerprint check from
  // the completion guard, exactly as the round-2 test does for `status`.
  const interruptedState = {
    ...result1.state,
    phases: {
      ...result1.state.phases,
      identify: {
        ...result1.state.phases.identify,
        dryCellsComplete: false, // a genuine interrupted resume, not a completed run
        dryCellsByDimension: { security: [0] }, // this interrupted run's own recorded-dry progress
        dryCellsSha: headSha,
        dryCellsFingerprint: staleFingerprint, // recorded against MARKER_A's content
      },
    },
  };

  // Between the interruption and the resume: edit a.js's content IN THE
  // WORKING TREE, uncommitted — the commit sha (headSha) does not change,
  // exactly the realistic scenario (uncommitted work mid-budget-stop-resume,
  // or any working-tree drift).
  fs.writeFileSync(path.join(root, "a.js"), packetSizedFile("MARKER_B"));

  // Resume: same headSha, dryCellsComplete:false (a genuine resume the
  // completion guard would honor), but content has drifted since the
  // fingerprint was recorded. Without the fingerprint check, packet 0 would
  // be skipped as "recorded dry" and MARKER_B would never be shown to any
  // finder — a real content change passing the gate unaudited.
  const log2 = makeLogFile(t);
  const ctx2 = makeCtx({ root, dotdir, state: interruptedState, fakeFile: writeFake(t, emptyFinderFake(log2)) });
  const result2 = await identify.run(ctx2);
  assert.equal(result2.gate.passed, true);

  const finder2 = readLog(log2).filter((c) => c.label === "finder:security").map((c) => c.prompt);
  assert.ok(finder2.some((p) => p.includes("MARKER_B")), "the edited content WAS shown to a finder — the fingerprint mismatch correctly discarded the stale positional dry-cell index, despite dryCellsComplete:false and a matching sha (which alone would have honored the stale index)");
});
