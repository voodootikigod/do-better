// src/comprehend.js — D1 Comprehend: coverage plan, 7 artifacts, citations, parallax divergence gate.
// Contract: blueprint §2.6 + §7 D1. Exports: run(ctx), PHASE_ID, buildCoveragePlan(facts, charter).
import path from "node:path";
import fs from "node:fs";
import {
  OpError, gateError, truncate, readPackageFile, gitHeadSha,
  writeFileAtomic, readJsonSafe, isSafeRelPath, mapLimit, warnIfDirtyTree,
} from "./utils.js";
import { recordPhase, addSpend, setGate, pinSha } from "./state.js";
import {
  LAYOUT, ensureLayout, writeArtifact, readArtifact,
  formatCitation, parseCitations, verifyCitations,
} from "./artifacts.js";
import { withFallback, cleanJsonResponse } from "./llm.js";
import { runParallax, runSkillMining } from "./adlc.js";

export const PHASE_ID = "comprehend";

const DEEP_BYTES_CAP = 150_000;
const DEEP_FILES_CAP = 40;
const SCAN_FILES_CAP = 200;
const PACKET_BYTES = 30_000;
const SLICE_CHARS = 24_000;
const BEHAVIOR_KINDS = new Set(["route", "cli", "job", "event", "db-write"]);
const SECURITY_RX = /auth|crypto|secur|token|session|password|login|server|api|input|sanitiz|valid/i;
const TEST_RX = /(^|\/)(test|tests|__tests__|spec)(\/|\.|$)|\.(test|spec)\./i;
const LOWVALUE_RX = /package-lock|pnpm-lock|yarn\.lock|(^|\/)(dist|build|vendor|node_modules)\/|\.min\./;
const READER_SYSTEM =
  "You are a careful code-comprehension reader. Report only what the provided code shows. " +
  "Every claim MUST carry an inline citation of the form path:line@sha (e.g. src/app.js:42@abc1234). " +
  "Claims without verifiable citations will be deleted downstream. Be concise.";

// ---------------------------------------------------------------------------
// Coverage plan (pure, deterministic)
// ---------------------------------------------------------------------------
function normalizeWeights(weights) {
  const w = weights && typeof weights === "object" ? weights : {};
  const out = {};
  for (const [k, v] of Object.entries(w)) {
    const n = Number(v);
    out[k] = Number.isFinite(n) && n >= 1 ? n : 1;
  }
  return out;
}

function candidatePool(facts) {
  if (Array.isArray(facts?.files) && facts.files.length > 0) {
    return facts.files
      .filter((f) => f && typeof f.file === "string")
      .map((f) => ({ file: f.file, loc: Number(f.loc) || 0, bytes: Number(f.bytes) || (Number(f.loc) || 0) * 40 }));
  }
  if (Array.isArray(facts?.largestFiles)) {
    return facts.largestFiles
      .filter((f) => f && typeof f.file === "string")
      .map((f) => ({ file: f.file, loc: Number(f.loc) || 0, bytes: (Number(f.loc) || 0) * 40 }));
  }
  return [];
}

function rankScore(entry, weights) {
  const loc = entry.loc || 0;
  let boost = 1;
  if (SECURITY_RX.test(entry.file)) boost += 0.5 * (weights.security ?? 1);
  if (TEST_RX.test(entry.file)) boost += 0.4 * (weights["test-quality"] ?? 1);
  if ((weights.maintainability ?? 1) >= 3 && loc > 400) boost += 0.3 * (weights.maintainability ?? 1);
  const depth = entry.file.split("/").length;
  const central = depth <= 2 ? 1.2 : 1;
  let score = Math.log2(2 + loc) * boost * central;
  if (LOWVALUE_RX.test(entry.file)) score *= 0.1;
  return score;
}

export function buildCoveragePlan(facts, charter) {
  const weights = normalizeWeights(charter?.weights);
  const pool = candidatePool(facts);
  if (pool.length === 0) {
    return { deepRead: [], scan: [], skipped: [], deepPct: 0, scanPct: 0, skipPct: 0, rationale: "No candidate files found in repo facts." };
  }
  const ranked = pool
    .map((f) => ({ ...f, score: rankScore(f, weights) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const deepRead = [];
  const scan = [];
  const skipped = [];
  let bytes = 0;
  for (const f of ranked) {
    const fb = f.bytes || f.loc * 40 || 400;
    const fitsBytes = deepRead.length === 0 || bytes + fb <= DEEP_BYTES_CAP;
    if (deepRead.length < DEEP_FILES_CAP && fitsBytes && bytes < DEEP_BYTES_CAP) {
      deepRead.push(f.file);
      bytes += fb;
    } else if (scan.length < SCAN_FILES_CAP) {
      scan.push(f.file);
    } else {
      skipped.push(f.file);
    }
  }
  const total = pool.length;
  const pct = (n) => Math.round((n / total) * 100);
  const topDims = Object.entries(weights).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}=${v}`).join(", ");
  return {
    deepRead, scan, skipped,
    deepPct: pct(deepRead.length), scanPct: pct(scan.length), skipPct: pct(skipped.length),
    rationale:
      `Ranked ${total} files by charter-weighted relevance (top weights: ${topDims || "defaults"}) × size × centrality. ` +
      `Deep-read capped at ${DEEP_FILES_CAP} files / ${DEEP_BYTES_CAP} bytes; next ${SCAN_FILES_CAP} files scanned; remainder skipped (declared, never silent).`,
  };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------
function patchPhase(state, phase, patch) {
  return { ...state, phases: { ...state.phases, [phase]: { ...state.phases[phase], ...patch } } };
}

function makeGateError(_message, gate, detail) {
  return gateError(gate, detail); // H15 — shared, well-formed message
}

function enrichFacts(facts, root) {
  if (Array.isArray(facts?.files) && facts.files.length > 0) return facts;
  try {
    const files = [];
    const walk = (rel) => {
      const abs = path.join(root, rel);
      for (const name of fs.readdirSync(abs)) {
        if (name === ".git" || name === "node_modules" || name === ".dobetter") continue;
        const childRel = rel ? `${rel}/${name}` : name;
        const st = fs.statSync(path.join(root, childRel));
        if (st.isDirectory()) walk(childRel);
        else if (st.isFile()) {
          let loc = 0;
          if (st.size <= 1_000_000) {
            try { loc = fs.readFileSync(path.join(root, childRel), "utf8").split("\n").length; } catch { loc = 0; }
          }
          files.push({ file: childRel, loc, bytes: st.size });
        }
      }
    };
    walk("");
    return { ...facts, files };
  } catch {
    return facts;
  }
}

function loadSlices(root, files) {
  const slices = [];
  for (const file of files) {
    if (!isSafeRelPath(file)) continue;
    try {
      const raw = fs.readFileSync(path.join(root, file), "utf8");
      const numbered = raw.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
      slices.push({ file, content: truncate(numbered, SLICE_CHARS), raw });
    } catch { /* unreadable file — declared via skipped set */ }
  }
  return slices;
}

function buildPackets(header, slices) {
  const packets = [];
  let cur = header;
  for (const s of slices) {
    const chunk = `\n\n=== ${s.file} ===\n${s.content}`;
    if (cur.length + chunk.length > PACKET_BYTES && cur !== header) {
      packets.push(cur);
      cur = header;
    }
    cur += chunk;
  }
  packets.push(cur);
  return packets;
}

async function jsonCall(llm, args, fallbackFn) {
  // json:true routes withFallback to llm.callJson (object + re-ask retry);
  // jsonMode:true covers implementations that thread it into llm.call instead.
  // Either way a string result is parsed defensively below (fail closed).
  const out = await withFallback(llm, { ...args, json: true, jsonMode: true }, fallbackFn);
  if (typeof out !== "string") return out;
  try {
    return JSON.parse(cleanJsonResponse(out));
  } catch {
    throw new OpError(`[${args.label}] returned unparseable JSON`);
  }
}

async function readerText(llm, name, instruction, packets, fallbackFn) {
  const parts = [];
  for (let i = 0; i < packets.length; i++) {
    const prompt =
      `${instruction}\n\nCite every claim inline as path:line@sha. ` +
      `Packet ${i + 1}/${packets.length}:\n\n${packets[i]}`;
    const out = await withFallback(
      llm,
      { prompt, system: READER_SYSTEM, tier: "mid", label: `reader:${name}` },
      fallbackFn,
    );
    parts.push(typeof out === "string" ? out : String(out));
    if (llm.offline) break; // fallback covers the whole artifact in one shot
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Offline / deterministic builders
// ---------------------------------------------------------------------------
function structureCodemap(facts) {
  const lines = ["# Codemap", "", "Structure-only codemap (offline degradation — purposes not inferred).", ""];
  for (const d of facts.topDirs ?? []) lines.push(`- \`${d.dir}/\` — ${d.files} files, ${d.loc} LOC (structure-only)`);
  for (const f of (facts.largestFiles ?? []).slice(0, 10)) lines.push(`- \`${f.file}\` — ${f.loc} LOC (structure-only)`);
  return lines.join("\n");
}

function grepBehaviors(root, files) {
  const routeRx = /\b(?:app|router|server|api)\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/;
  const eventRx = /\.(?:addEventListener|on)\s*\(\s*["'`]([^"'`]+)["'`]/;
  const found = [];
  for (const file of files) {
    if (!isSafeRelPath(file) || !/\.(c|m)?(j|t)sx?$/.test(file)) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(root, file), "utf8"); } catch { continue; }
    const lines = raw.split("\n");
    let cliNoted = false;
    for (let i = 0; i < lines.length && found.length < 200; i++) {
      const route = routeRx.exec(lines[i]);
      if (route) { found.push({ kind: "route", surface: `${route[1].toUpperCase()} ${route[2]}`, file, line: i + 1, summary: "route handler (structure-only)" }); continue; }
      const ev = eventRx.exec(lines[i]);
      if (ev) { found.push({ kind: "event", surface: ev[1], file, line: i + 1, summary: "event listener (structure-only)" }); continue; }
      if (!cliNoted && /process\.argv/.test(lines[i])) { cliNoted = true; found.push({ kind: "cli", surface: path.basename(file), file, line: i + 1, summary: "CLI argv entry (structure-only)" }); }
    }
  }
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    if (pkg.bin) {
      const line = raw.split("\n").findIndex((l) => l.includes('"bin"')) + 1 || 1;
      const names = typeof pkg.bin === "string" ? [pkg.name ?? "cli"] : Object.keys(pkg.bin);
      for (const name of names) found.push({ kind: "cli", surface: name, file: "package.json", line, summary: "declared bin entry (structure-only)" });
    }
  } catch { /* no package.json — fine */ }
  return found;
}

function depsSection(root, facts) {
  const lines = ["## Declared dependencies", ""];
  let pkg = null;
  try { pkg = readJsonSafe(path.join(root, "package.json")); } catch { pkg = null; }
  if (pkg) {
    for (const [name, ver] of Object.entries(pkg.dependencies ?? {})) lines.push(`- ${name}@${ver} (prod)`);
    for (const [name, ver] of Object.entries(pkg.devDependencies ?? {})) lines.push(`- ${name}@${ver} (dev)`);
    if (lines.length === 2) lines.push("- (none declared)");
  } else {
    lines.push("- (no parseable package.json)");
  }
  if (Array.isArray(facts.manifests) && facts.manifests.length) {
    lines.push("", "## Manifests", "", ...facts.manifests.map((m) => `- ${m}`));
  }
  return lines.join("\n");
}

function behaviorsToBody(entries, head7) {
  const lines = [
    "# Behavior Inventory",
    "",
    "KEYSTONE artifact — the denominator for \"retain existing functionality\".",
    "One bullet per observable behavior: `- **B-NNN** [kind] surface — summary (file:line@sha)`.",
    "",
  ];
  entries.forEach((b, i) => {
    const id = `B-${String(i + 1).padStart(3, "0")}`;
    lines.push(`- **${id}** [${b.kind}] ${b.surface} — ${b.summary || "observed behavior"} (${formatCitation({ file: b.file, line: b.line, sha: head7 })})`);
  });
  if (entries.length === 0) lines.push("- (no observable behaviors identified)");
  return lines.join("\n");
}

function validateBehavior(b) {
  if (!b || typeof b !== "object") return null;
  const kind = String(b.kind ?? "").toLowerCase();
  const line = Number(b.line);
  if (!BEHAVIOR_KINDS.has(kind)) return null;
  if (typeof b.file !== "string" || !isSafeRelPath(b.file)) return null;
  if (!Number.isInteger(line) || line < 1) return null;
  if (typeof b.surface !== "string" || b.surface.trim() === "") return null;
  return { kind, surface: b.surface.trim(), file: b.file, line, summary: typeof b.summary === "string" ? b.summary.trim() : "" };
}

// ---------------------------------------------------------------------------
// Citation gate (F4, deterministic)
// ---------------------------------------------------------------------------
function scrubCitations(root, body, exec, head7, log) {
  const all = parseCitations(body);
  if (all.length === 0) return { body, dropped: 0 };
  const { verified } = verifyCitations(root, all, exec);
  const okSet = new Set(verified.map((c) => `${c.file}:${c.line}`));
  const kept = [];
  let dropped = 0;
  for (const line of body.split("\n")) {
    const cits = parseCitations(line);
    if (cits.length === 0) { kept.push(line); continue; }
    const good = cits.filter((c) => okSet.has(`${c.file}:${c.line}`));
    if (good.length === 0) {
      dropped += 1;
      log?.warn?.(`citation gate: dropped uncited claim: ${truncate(line.trim(), 120)}`);
      continue;
    }
    let out = line;
    for (const c of cits) {
      const token = formatCitation(c);
      const replacement = okSet.has(`${c.file}:${c.line}`) ? formatCitation({ ...c, sha: head7 }) : "(citation removed: unverifiable)";
      out = out.split(token).join(replacement);
    }
    kept.push(out);
  }
  return { body: kept.join("\n"), dropped };
}

function writeCoverageManifest(dotdir, { headSha, generatedAt, plan, degradations }) {
  const body = [
    "# Coverage Manifest", "",
    "Declared sampling — never silent (D10).", "",
    "## Coverage",
    `- deep-read: ${plan.deepPct}% (${plan.deepRead.length} files)`,
    `- scanned: ${plan.scanPct}% (${plan.scan.length} files)`,
    `- skipped: ${plan.skipPct}% (${plan.skipped.length} files)`, "",
    "## Rationale", plan.rationale, "",
    "## Deep-read files", ...(plan.deepRead.length ? plan.deepRead.map((f) => `- ${f}`) : ["- (none)"]), "",
    "## Scanned files", ...(plan.scan.length ? plan.scan.map((f) => `- ${f}`) : ["- (none)"]), "",
    "## Skipped files", ...(plan.skipped.length ? plan.skipped.map((f) => `- ${f}`) : ["- (none)"]), "",
    "## Degradations",
    ...(degradations.length ? degradations.map((d) => `- ${d}`) : ["- (none)"]),
  ].join("\n") + "\n";
  writeArtifact(dotdir, LAYOUT.comprehension.coverageManifest, {
    meta: { headSha, generatedAt, deepPct: plan.deepPct, scanPct: plan.scanPct, skipPct: plan.skipPct },
    body,
  });
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------
export async function run(ctx) {
  const { root, dotdir, llm, adlc, flags, log, exec } = ctx;
  const now = ctx.now;
  let state = ctx.state;
  try {
    if (!state?.gates?.charter?.approved) {
      throw new OpError("Charter not approved — run `do-better charter` and approve it (or `do-better charter --approve`) before `do-better audit`.");
    }
    const scanFacts = state?.phases?.scan?.facts;
    if (!scanFacts) throw new OpError("No scan facts found — run `do-better scan` first.");
    const charterArt = readArtifact(dotdir, LAYOUT.charter);
    if (!charterArt) throw new OpError("Missing .dobetter/charter.md — run `do-better charter` first.");
    const charter = {
      weights: normalizeWeights(charterArt.meta?.weights),
      intent: charterArt.meta?.intent ?? null,
      body: charterArt.body ?? "",
    };

    const headSha = gitHeadSha(root, exec);
    const head7 = headSha.slice(0, 7);
    warnIfDirtyTree(root, exec, log, "D1 comprehend"); // H10 — declared, never silent
    ensureLayout(dotdir);

    const offline = llm.offline === true;
    // Progress (H16): D1 is the other heavy phase that previously ran silent.
    log?.phase?.("D1", `Comprehend${offline ? " (offline structure-only)" : ""}`);
    const parallaxAvailable = !offline && adlc?.available?.parallax === true;
    const readings = parallaxAvailable ? (flags.n ?? 3) : 1;
    const threshold = flags.threshold ?? 0.25;
    const degradations = [];

    // 1) Coverage plan
    const facts = enrichFacts(scanFacts, root);
    const plan = buildCoveragePlan(facts, charter);
    writeCoverageManifest(dotdir, { headSha, generatedAt: now(), plan, degradations });
    const slices = loadSlices(root, plan.deepRead);

    // 2) Packets seeded with charter + scan-time codemap draft
    const draft = readArtifact(dotdir, LAYOUT.comprehension.codemap);
    const header =
      `Charter intent: ${charter.intent ?? "(unspecified)"}\n` +
      `Dimension weights: ${JSON.stringify(charter.weights)}\n\n` +
      `Charter excerpt:\n${truncate(charter.body, 2000)}\n\n` +
      `Codemap draft:\n${truncate(draft?.body ?? "(no draft)", 4000)}`;
    const packets = buildPackets(header, slices);
    const baseMeta = { headSha, generatedAt: now(), readings };

    // 3) Behaviors first (keystone) — JSON-validated entries
    let behaviors = [];
    if (offline) {
      behaviors = grepBehaviors(root, plan.deepRead.concat(plan.scan));
    } else {
      // The per-packet behavior calls are independent (results merged and
      // deduped afterward), so run them concurrently (H8). Validated entries are
      // returned per packet and merged in PACKET ORDER below, so the inventory
      // is byte-identical to the previous sequential loop — concurrency is
      // wall-clock only.
      const perPacket = await mapLimit(packets, packets.length, async (packet, i) => {
        log?.step?.(`Behavior inventory · packet ${i + 1}/${packets.length} · $${llm.spentSoFar().toFixed(2)} spent`);
        const obj = await jsonCall(
          llm,
          {
            prompt:
              "Enumerate every OBSERVABLE behavior in this code (routes, CLI entrypoints, jobs, events, db-writes). " +
              'Return JSON {"behaviors":[{"kind":"route|cli|job|event|db-write","surface":"GET /x","file":"src/a.js","line":12,"summary":"..."}]}\n\n' + packet,
            system: READER_SYSTEM, tier: "mid", label: "reader:behavior-inventory",
          },
          () => ({ behaviors: grepBehaviors(root, plan.deepRead) }),
        );
        const arr = Array.isArray(obj) ? obj : Array.isArray(obj?.behaviors) ? obj.behaviors : [];
        const out = [];
        for (const raw of arr) {
          const b = validateBehavior(raw);
          if (b) out.push(b);
          else log?.warn?.("behavior-inventory: dropped invalid entry (fail closed)");
        }
        return out;
      });
      for (const arr of perPacket) behaviors.push(...arr);
    }
    const seen = new Set();
    behaviors = behaviors.filter((b) => {
      const k = `${b.kind}|${b.surface}|${b.file}:${b.line}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // 4) Remaining readers
    log?.step?.(`Reader artifacts (codemap, architecture, dependencies, rails-map, glossary) · $${llm.spentSoFar().toFixed(2)} spent`);
    const offlineNote = (title, extra = "") =>
      `# ${title}\n\n(structure-only) Offline degradation — no LLM narrative.\n${extra}`;
    // The five reader artifacts have no data dependency on each other (rails-map
    // reads `behaviors`, already fully computed above), so run them concurrently
    // (H8) with bounded concurrency. Each reader's result is assigned to its own
    // named slot, so completion order is irrelevant — output is byte-identical
    // to the previous sequential assignment.
    const readerDefs = [
      { key: "codemap", run: () => readerText(llm, "codemap",
        "Verify and extend this codemap draft: one line of purpose per top-level directory and major file.",
        packets, () => structureCodemap(facts)) },
      { key: "architecture", run: () => readerText(llm, "architecture",
        "Describe the intended design versus the actual implementation drift you can evidence in the code.",
        packets, () => offlineNote("Architecture", (facts.topDirs ?? []).map((d) => `- \`${d.dir}/\``).join("\n"))) },
      { key: "dependencies", run: () => (offline
        ? Promise.resolve("## Risk flags\n\n(structure-only) EOL/CVE flags require online verification.")
        : readerText(llm, "dependencies",
            "Flag dependency risks (EOL, known-CVE-prone, coupling hotspots). Mark every external-knowledge flag as \"needs verification\".",
            [packets[0]], () => "## Risk flags\n\n(structure-only)")) },
      { key: "railsMap", run: () => readerText(llm, "rails-map",
        `Map these observable behaviors to existing tests; mark each covered or load-bearing-but-untested.\nBehaviors:\n${behaviorsToBody(behaviors, head7)}`,
        [packets[0]], () => "# Rails Map\n\n(structure-only) Existing tests:\n" + (facts.testDirs ?? []).map((d) => `- \`${d}/\``).join("\n") + "\n\nBehavior coverage unknown offline.") },
      { key: "glossary", run: () => readerText(llm, "glossary",
        "Build a glossary mapping business/domain terms to code terms, citing where each term is defined or used.",
        [packets[0]], () => "# Glossary\n\n(structure-only) No glossary terms extracted offline.") },
    ];
    const readerResults = await mapLimit(readerDefs, 4, (d) => d.run());
    const bodies = {};
    readerDefs.forEach((d, i) => { bodies[d.key] = readerResults[i]; });
    bodies.dependencies = depsSection(root, facts) + "\n\n" + bodies.dependencies;

    // 5) Citation gate + write artifacts
    const writeScrubbed = (relPath, body, meta) => {
      const { body: clean, dropped } = scrubCitations(root, body, exec, head7, log);
      writeArtifact(dotdir, relPath, { meta, body: clean });
      return dropped;
    };
    let droppedClaims = 0;
    droppedClaims += writeScrubbed(LAYOUT.comprehension.codemap, bodies.codemap, { ...baseMeta, draft: false, generatedBy: "comprehend" });
    const behaviorBody = behaviorsToBody(behaviors, head7);
    const { body: behaviorClean, dropped: behaviorDropped } = scrubCitations(root, behaviorBody, exec, head7, log);
    if (behaviorDropped > 0) log?.warn?.(`behavior-inventory: ${behaviorDropped} entries dropped (zero verified citations)`);
    droppedClaims += behaviorDropped;
    writeArtifact(dotdir, LAYOUT.comprehension.behaviorInventory, { meta: baseMeta, body: behaviorClean });
    droppedClaims += writeScrubbed(LAYOUT.comprehension.dependencies, bodies.dependencies, baseMeta);
    droppedClaims += writeScrubbed(LAYOUT.comprehension.railsMap, bodies.railsMap, baseMeta);
    droppedClaims += writeScrubbed(LAYOUT.comprehension.glossary, bodies.glossary, baseMeta);
    let architectureBody = scrubCitations(root, bodies.architecture, exec, head7, log).body;
    writeArtifact(dotdir, LAYOUT.comprehension.architecture, { meta: baseMeta, body: architectureBody });

    // 6) skill-mining sub-step (declared, never silent)
    const sm = runSkillMining(adlc, { targetDir: root, offline, exec });
    if (sm.skipped) degradations.push(`mined skills: skipped (${sm.reason ?? "skill-mining unavailable"})`);
    else if (!sm.ok) degradations.push("mined skills: failed (skill-mining exited non-zero)");

    // 7) Divergence gate (parallax)
    let divergence = null;
    let degraded = null;
    let gateDetail = "";
    if (!parallaxAvailable) {
      degraded = "single-reading";
      degradations.push(offline
        ? "parallax: skipped (--offline) — single-reading mode; human skim required before proceeding"
        : "parallax: unavailable — single-reading mode; human skim required before proceeding");
      gateDetail = "degraded single-reading mode — HUMAN SKIM REQUIRED before proceeding";
      log?.warn?.("Parallax unavailable — single-reading mode. Human skim required before proceeding.");
    } else {
      const packetPath = path.join(dotdir, "tmp", "reading-packet.md");
      writeFileAtomic(packetPath,
        `# Reading packet\n\n## Charter\n${truncate(charter.body, 3000)}\n\n## Behavior inventory\n${behaviorClean}\n\n## Architecture\n${architectureBody}\n`);
      const res = runParallax(adlc, { file: packetPath, n: readings, threshold, cwd: root, exec });
      if (res.skipped) {
        degraded = "single-reading";
        degradations.push(`parallax: ${res.reason ?? "could not run"} — single-reading mode; human skim required before proceeding`);
        gateDetail = "degraded single-reading mode — HUMAN SKIM REQUIRED before proceeding";
      } else {
        divergence = typeof res.score === "number" ? res.score : null;
        const divs = Array.isArray(res.divergences) ? res.divergences : [];
        if (divs.length > 0) {
          architectureBody += "\n\n## Open questions\n" +
            divs.map((d) => `- ${typeof d === "string" ? d : JSON.stringify(d)} (divergent reading — D2 confusion-finding seed)`).join("\n");
          writeArtifact(dotdir, LAYOUT.comprehension.architecture, { meta: baseMeta, body: architectureBody });
        }
        if (!res.gate) {
          writeCoverageManifest(dotdir, { headSha, generatedAt: now(), plan, degradations });
          state = patchPhase(state, PHASE_ID, { divergence, readings });
          state = setGate(state, "comprehend", { passed: false, divergence, threshold, degraded: null });
          state = addSpend(state, PHASE_ID, llm.drainSpend());
          state = recordPhase(state, PHASE_ID, { status: "failed", sha: headSha, now: now() });
          const detail = `divergence ${divergence ?? "unknown"} ≥ ${threshold} — re-run audit after resolving the open questions appended to comprehension/architecture.md`;
          const err = makeGateError(`Gate failed: comprehend — ${detail}`, "comprehend", detail);
          err.state = state;
          throw err;
        }
        gateDetail = `divergence ${divergence ?? 0} < ${threshold}`;
      }
    }

    // 8) Persist gate + state
    writeCoverageManifest(dotdir, { headSha, generatedAt: now(), plan, degradations });
    state = patchPhase(state, PHASE_ID, { divergence, readings });
    state = setGate(state, "comprehend", { passed: true, divergence, threshold, degraded });
    state = addSpend(state, PHASE_ID, llm.drainSpend());
    state = recordPhase(state, PHASE_ID, { status: "done", sha: headSha, now: now() });
    state = pinSha(state, PHASE_ID, headSha);

    const summary =
      `Comprehension complete @ ${head7}: ${behaviors.length} behaviors inventoried, ` +
      `coverage deep ${plan.deepPct}% / scanned ${plan.scanPct}% / skipped ${plan.skipPct}% (declared in coverage-manifest.md), ` +
      `${droppedClaims} unverifiable claim(s) removed by the citation gate, ` +
      `${degradations.length} degradation(s) declared. Gate: ${gateDetail}.` +
      (degraded ? " HUMAN SKIM REQUIRED: review .dobetter/comprehension/ before `do-better audit` continues to D2." : "");
    return { state, gate: { name: "comprehend", passed: true, human: false, detail: gateDetail }, summary };
  } catch (err) {
    if (!err.state) {
      try { err.state = addSpend(state, PHASE_ID, llm.drainSpend()); } catch { err.state = state; }
    }
    throw err;
  }
}
