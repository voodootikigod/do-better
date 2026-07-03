// src/identify.js — D2 Identify: refute-chartered finders, loop-until-dry (K=2),
// adversarial reproduce-or-kill verification. One file per VERIFIED finding.
// Contract: blueprint §2.6 + §7 D2. Exports: run(ctx), PHASE_ID, dedupeKey(candidate).
import path from "node:path";
import fs from "node:fs";
import {
  OpError, BudgetError, GateError, sha256Hex, isSafeRelPath, truncate,
  readPackageFile, gitHeadSha, TAXONOMY,
} from "./utils.js";
import { recordPhase, addSpend, setGate, pinSha, nextFindingId } from "./state.js";
import { LAYOUT, readArtifact, readFindings, runReproCheck, verifyCitations, writeArtifact, writeFinding } from "./artifacts.js";
import { withFallback, cleanJsonResponse } from "./llm.js";

export const PHASE_ID = "identify";
export const K_DRY = 2;
export const MAX_PASSES = 8;

const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
export const PACKET_BYTES = 30_000;
const SLICE_CHARS = 24_000;
const REPRO_TIMEOUT_MS = 30_000;
const FALLBACK_REFUTE =
  "You are chartered to REFUTE the claim that this codebase is acceptable on the given dimension. " +
  "Find concrete evidence that it is not. Every claim requires a file and line citation into the code you were shown. " +
  "Report everything, including low-confidence findings — verification happens downstream and will kill anything that does not reproduce.";
const VERDICT_SYSTEM =
  "You are a blind adversarial verifier. You see ONLY a bare claim and the cited code slice — no proposer reasoning. " +
  'Decide whether the code shown actually supports the claim. Respond with JSON {"verdict":"CONFIRM"|"KILL"|"UNCERTAIN","reason":"..."}. ' +
  "When in doubt, do NOT confirm.";
const REPRO_SYSTEM =
  "You propose mechanical reproduction checks for code findings. Allowed shapes ONLY: " +
  '`node --test <relative test file>`, `node -e "<snippet ≤500 chars>"` (snippet must exit 0 iff the issue is present), ' +
  'or a native grep as {"grep":{"pattern":"<regex>","file":"<relative path>"}}. ' +
  'If no deterministic check exists, return {"reproCmd":null}. Respond with JSON only.';
// T3 semantic dedupe: a cheap-tier equivalence judge layered OVER the free hash
// filter. It sees a numbered list of prior findings (same dimension+file) and
// one new finding, and decides whether the new one merely restates a prior in
// different words. Bias toward "new" (null) — false-new is cheap, false-dup is
// unrecoverable (see the fail-open doctrine at the call site).
const DEDUPE_SYSTEM =
  "You judge whether a NEW code finding is a SEMANTIC DUPLICATE of one already recorded — the same " +
  "underlying issue restated in different words, not merely a finding in the same file or area. " +
  'You are given a numbered list of prior findings and one new finding. Respond with JSON ' +
  '{"duplicateOf": <the index of the prior finding it duplicates, or null if it is genuinely new>}. ' +
  "Return an index ONLY when you are confident it is the same issue; when in any doubt, return null.";

// The five finder lenses (T2 pooled parallax). IDs are fixed doctrine; the
// paragraph text lives in refute-charter.md's "## Lenses" section and is loaded
// via parseLenses(). The hardcoded fallback below preserves diversity when that
// section is absent or unparseable — degraded loudly, never silently.
const LENS_IDS = Object.freeze([
  "exploit-author", "oncall-3am", "new-hire-reader", "performance-profiler", "staff-skeptic",
]);
const FALLBACK_LENSES = Object.freeze([
  { id: "exploit-author", text: "Read as an attacker: trace every path from an untrusted boundary to a dangerous sink (shell, query, template, deserializer, file path, outbound request). Cite the line where attacker-controlled data reaches the call and the input that turns it hostile." },
  { id: "oncall-3am", text: "Read as the engineer the pager just woke: hunt for what fails silently or un-diagnosably — swallowed errors, missing timeouts, retries that mask the cause, states with no breadcrumb. Cite the line where a real failure produces no signal or the wrong one." },
  { id: "new-hire-reader", text: "Read as someone here on day one, trusting names and comments: hunt for anything that builds a wrong mental model — misleading names, comments that contradict the code, magic constants, implicit coupling. Cite the line a careful reader would misunderstand and the mistake it invites." },
  { id: "performance-profiler", text: "Read with a flamegraph in mind: hunt for cost hidden in innocent code — a query inside a loop, a quadratic scan, blocking I/O on a hot path, unbounded growth on untrusted input. Cite the line whose cost is super-linear in something a caller controls and the scale that stalls it." },
  { id: "staff-skeptic", text: "Read as a staff engineer in design review: look past the line to the decision it encodes and how it ages — eroding layer boundaries, unenforced invariants, two sources of truth, load-bearing 'temporary' shapes. Cite where intent and implementation diverge and the change that would break it." },
]);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
export function dedupeKey(candidate) {
  const claim = String(candidate?.claim ?? candidate?.title ?? "")
    .toLowerCase().replace(/\s+/g, " ").trim();
  return sha256Hex(`${candidate?.dimension ?? ""}|${candidate?.file ?? ""}|${claim}`);
}

// Split the refute-charter doc into the finder base prompt (everything ABOVE
// "## Lenses" — this is what every finder sees, replacing the pre-T2 whole-file
// load) and the parsed lens catalog. Fallback (section absent or not the
// expected 5 lenses): base = the whole doc (pre-T2 behavior preserved) and the
// hardcoded catalog is used — a declared degradation, logged loudly via
// log.warn so a malformed reference never silently collapses lens diversity.
export function parseLenses(refuteDoc, log) {
  const doc = String(refuteDoc ?? "");
  const headingRx = /^##\s+Lenses\s*$/m;
  const m = headingRx.exec(doc);
  if (m) {
    const base = doc.slice(0, m.index).replace(/\s+$/, "");
    const section = doc.slice(m.index + m[0].length);
    const lenses = [];
    const lensRx = /^###\s+(.+?)\s*$/gm;
    let lm;
    const marks = [];
    while ((lm = lensRx.exec(section)) !== null) marks.push({ id: lm[1].trim(), start: lensRx.lastIndex });
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length
        ? section.lastIndexOf("###", marks[i + 1].start)
        : section.length;
      const text = section.slice(marks[i].start, end === -1 ? section.length : end).trim();
      if (marks[i].id && text) lenses.push({ id: marks[i].id, text });
    }
    const ids = lenses.map((l) => l.id);
    const wellFormed = lenses.length === LENS_IDS.length && LENS_IDS.every((id) => ids.includes(id));
    if (wellFormed) return { base, lenses };
  }
  log?.warn?.(
    'refute-charter.md: "## Lenses" section absent or unparseable — falling back to the ' +
    `${FALLBACK_LENSES.length} hardcoded finder lenses (declared degradation; lens diversity preserved).`,
  );
  return { base: doc.replace(/\s+$/, ""), lenses: FALLBACK_LENSES.map((l) => ({ ...l })) };
}

// The MAXIMUM pool width from the --n flag. When --n is unset the ceiling is 1
// (pooling is opt-in): a no-flag `audit` keeps the pre-T2 single-finder call
// count per pass, which the frozen identify.test.js "MAX_PASSES cap" rail pins
// exactly (a weight-5 dimension at width>1 would go dry early and never hit the
// cap). Lens ROTATION across passes is still active at width 1; only the
// within-pass FAN-OUT needs --n>1. --n N raises the ceiling to N.
function charterPoolMax(n) {
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

// Charter-weighted finder pool width (T2). `n` is the --n ceiling (the MAXIMUM
// pool width). A high-weight dimension gets the full width; mid-weight gets
// half (floored, min 1); weight 1 gets a single finder — no pooling, identical
// to the pre-T2 single-call behavior for that dimension.
export function charterPoolWidth(weight, n) {
  const cap = Number.isInteger(n) && n >= 1 ? n : 1;
  const w = Number(weight);
  let width;
  if (w >= 4) width = cap;
  else if (w >= 2) width = Math.max(1, Math.floor(cap / 2));
  else width = 1;
  return Math.min(cap, Math.max(1, width));
}

function patchPhase(state, phase, patch) {
  return { ...state, phases: { ...state.phases, [phase]: { ...state.phases[phase], ...patch } } };
}

function makeGateError(message, gate, detail) {
  const err = new GateError(message);
  err.gate = gate;
  err.detail = detail;
  return err;
}

function clamp01(n, dflt = 0.5) {
  const v = Number(n);
  if (!Number.isFinite(v)) return dflt;
  return Math.min(1, Math.max(0, v));
}

function validateCandidate(raw, dimensionId, log) {
  if (!raw || typeof raw !== "object") return null;
  const file = raw.file;
  const line = Number(raw.line);
  const severity = String(raw.severity ?? "").toLowerCase();
  const ok =
    typeof raw.title === "string" && raw.title.trim() !== "" &&
    typeof file === "string" && isSafeRelPath(file) &&
    Number.isInteger(line) && line >= 1 &&
    SEVERITIES.has(severity);
  if (!ok) {
    log?.warn?.(`finder:${dimensionId}: dropped invalid candidate (fail closed): ${truncate(JSON.stringify(raw ?? null), 120)}`);
    return null;
  }
  return {
    dimension: dimensionId,
    title: raw.title.trim(),
    claim: typeof raw.claim === "string" && raw.claim.trim() !== "" ? raw.claim.trim() : raw.title.trim(),
    file, line, severity,
    confidence: clamp01(raw.confidence),
    method: raw.method === "static" ? "static" : null,
    check: raw.check ?? null,
  };
}

function parseExtraDimensions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const e of value) {
    let id = null, label = null, weight = 3;
    if (e && typeof e === "object" && e.id) {
      id = String(e.id); label = String(e.label ?? e.id);
      const w = Number(e.weight); if (Number.isFinite(w) && w >= 1) weight = w;
    } else if (typeof e === "string" && e.trim() !== "") {
      const [rawId, rawW] = e.split(":");
      id = rawId.trim(); label = id;
      const w = Number(rawW); if (Number.isFinite(w) && w >= 1) weight = w;
    }
    if (id && /^[a-z0-9_-]+$/i.test(id)) out.push({ id, label, weight });
  }
  return out;
}

function orderedDimensions(charterMeta) {
  const weights = charterMeta?.weights && typeof charterMeta.weights === "object" ? charterMeta.weights : {};
  const dims = TAXONOMY.map((t, i) => {
    const w = Number(weights[t.id]);
    return { id: t.id, label: t.label, weight: Number.isFinite(w) && w >= 1 ? w : 1, order: i };
  });
  parseExtraDimensions(charterMeta?.extraDimensions).forEach((e, i) => {
    if (!dims.some((d) => d.id === e.id)) dims.push({ ...e, order: 100 + i });
  });
  return dims.sort((a, b) => b.weight - a.weight || a.order - b.order);
}

function loadRef(name, fallback) {
  try { return readPackageFile(`do-better/references/${name}`); } catch { return fallback; }
}

function dimensionBrief(taxonomyDoc, dim) {
  if (taxonomyDoc) {
    const rx = new RegExp(`^##\\s+${dim.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "mi");
    const m = rx.exec(taxonomyDoc);
    if (m) {
      const rest = taxonomyDoc.slice(m.index + m[0].length);
      const next = rest.search(/^##\s+/m);
      const section = (next === -1 ? rest : rest.slice(0, next)).trim();
      if (section) return truncate(section, 2000);
    }
  }
  return `Find concrete, citable evidence of "${dim.label}" problems in this codebase: anything a skeptical senior engineer would flag on that dimension.`;
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

// ---------------------------------------------------------------------------
// Coverage slices (from D1's declared coverage manifest)
// ---------------------------------------------------------------------------
function deepReadFileList(dotdir, state) {
  const manifest = readArtifact(dotdir, LAYOUT.comprehension.coverageManifest);
  if (manifest?.body) {
    const lines = manifest.body.split("\n");
    const start = lines.findIndex((l) => l.trim() === "## Deep-read files");
    if (start !== -1) {
      const files = [];
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith("## ")) break;
        const m = /^-\s+(.+)$/.exec(line);
        if (m && m[1] !== "(none)" && isSafeRelPath(m[1])) files.push(m[1]);
      }
      if (files.length) return files;
    }
  }
  const largest = state?.phases?.scan?.facts?.largestFiles;
  if (Array.isArray(largest)) return largest.map((f) => f?.file).filter((f) => typeof f === "string" && isSafeRelPath(f));
  return [];
}

function loadSlices(root, files) {
  const slices = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(root, file), "utf8");
      slices.push({ file, raw: truncate(raw, SLICE_CHARS) });
    } catch { /* unreadable — declared in coverage manifest already */ }
  }
  return slices;
}

// Content fingerprint over the ordered, readable deep-read set (adversarial
// review finding, round 4): the dry-cell resume cache below is keyed on
// headSha, but packet identity is POSITIONAL and content is read from the
// WORKING TREE, not the committed blob. Two things can change while headSha
// stays constant — file content (a budget-stop resume is precisely the flow
// where uncommitted edits are live) and the file SET/order (`audit` always
// re-runs D1 comprehend before D2, which can regenerate a different deep-read
// list). Either shift silently invalidates a positional index -> packet
// mapping: a recorded-dry packet 0 could be entirely different files/content
// on resume. This fingerprint changes on ANY such drift, so the completion
// guard can invalidate the WHOLE dry-cell cache (full re-examination) rather
// than trusting a positional index against content it never actually
// verified. Whole-set invalidation, not per-packet reconciliation: simpler
// and safe — the failure mode of over-invalidating is one extra pass, not a
// silently unaudited file.
function packetSetFingerprint(slices) {
  const parts = slices.map((s) => `${s.file}:${sha256Hex(s.raw)}`);
  return sha256Hex(parts.join("|"));
}

// One slice → its numbered, file-delimited chunk (the unit of packetization).
function renderSlice(s) {
  const numbered = s.raw.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
  return `\n=== ${s.file} ===\n${numbered}\n`;
}

// Render a group of slices into a single finder packet. Skip-and-continue (NOT
// break): a chunk that would overflow maxBytes is skipped so later slices still
// get a chance; a SINGLE chunk larger than maxBytes is hard-truncated rather
// than dropped — given ≥1 readable slice the packet is never empty. Callers
// that need every slice covered must partition first (partitionSlices), which
// only ever hands this a group that already fits (or a lone oversized slice).
function buildFinderPacket(slices, maxBytes = PACKET_BYTES) {
  let packet = "";
  for (const s of slices) {
    const chunk = renderSlice(s);
    if (chunk.length > maxBytes) {
      packet += truncate(chunk, maxBytes);
      continue;
    }
    if (packet.length + chunk.length > maxBytes) continue;
    packet += chunk;
  }
  return packet || "(no deep-read slices available)";
}

// Partition the WHOLE readable deep-read set into finder packets: every slice
// lands in exactly one packet, in input order; a slice whose rendered chunk
// exceeds maxBytes becomes its own hard-truncated singleton packet; non-empty
// input never yields []. This replaces the old "rotate one shared window"
// scheme — the loop now examines the entire set, never just the head.
export function partitionSlices(slices, maxBytes = PACKET_BYTES) {
  const packets = [];
  let group = [];
  let groupBytes = 0;
  const flush = () => {
    if (group.length === 0) return;
    packets.push({ files: group.map((s) => s.file), packet: buildFinderPacket(group, maxBytes) });
    group = [];
    groupBytes = 0;
  };
  for (const s of slices) {
    const chunk = renderSlice(s);
    if (chunk.length > maxBytes) {
      flush();
      packets.push({ files: [s.file], packet: buildFinderPacket([s], maxBytes) });
      continue;
    }
    if (groupBytes + chunk.length > maxBytes) flush();
    group.push(s);
    groupBytes += chunk.length;
  }
  flush();
  return packets;
}

// ---------------------------------------------------------------------------
// Offline static finders (deterministic, one pass per dimension)
// ---------------------------------------------------------------------------
function regexCandidates(slices, dimension, rx, { title, claim, severity, perFile = true }) {
  const out = [];
  for (const s of slices) {
    const lines = s.raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i])) {
        out.push({
          dimension, title: `${title} in ${s.file}`, claim: `${claim} (line ${i + 1})`,
          file: s.file, line: i + 1, severity, confidence: 0.9,
          method: "static", check: { type: "regex", pattern: rx.source, flags: rx.flags.replace("g", "") },
        });
        if (perFile) break;
      }
    }
  }
  return out;
}

function staticFinderPass(dimId, root, slices) {
  switch (dimId) {
    case "maintainability":
      return regexCandidates(slices, dimId, /\b(TODO|FIXME|HACK)\b/, {
        title: "Acknowledged debt marker", claim: "TODO/FIXME/HACK marker indicates acknowledged unaddressed debt", severity: "low",
      });
    case "security":
      return [
        ...regexCandidates(slices, dimId, /\beval\s*\(/, {
          title: "eval() usage", claim: "eval() executes dynamically constructed code", severity: "high",
        }),
        ...regexCandidates(slices, dimId, /(api[_-]?key|secret|password)\s*[:=]\s*["'][^"']{8,}["']/i, {
          title: "Possible hardcoded secret", claim: "string literal assigned to a secret-named binding", severity: "high",
        }),
      ];
    case "correctness":
      return regexCandidates(slices, dimId, /catch\s*(\([^)]*\))?\s*\{\s*\}/, {
        title: "Empty catch block", claim: "errors are silently swallowed by an empty catch block", severity: "medium",
      });
    case "test-quality": {
      const hasTests = slices.some((s) => /(^|\/)(test|tests|__tests__)\//.test(s.file) || /\.(test|spec)\./.test(s.file));
      if (!hasTests && fs.existsSync(path.join(root, "package.json"))) {
        return [{
          dimension: dimId, title: "No test files in analyzed set", claim: "no test files were found among analyzed files",
          file: "package.json", line: 1, severity: "medium", confidence: 0.7,
          method: "static", check: { type: "no-tests" },
        }];
      }
      return [];
    }
    case "dependency-health": {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
        const hasDeps = Object.keys(pkg.dependencies ?? {}).length > 0;
        const hasLock = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"].some((f) => fs.existsSync(path.join(root, f)));
        if (hasDeps && !hasLock) {
          return [{
            dimension: dimId, title: "Dependencies without a lockfile", claim: "runtime dependencies declared but no lockfile is committed",
            file: "package.json", line: 1, severity: "medium", confidence: 0.9,
            method: "static", check: { type: "no-lockfile" },
          }];
        }
      } catch { /* no parseable package.json */ }
      return [];
    }
    case "dx": {
      if (fs.existsSync(path.join(root, "package.json")) && !fs.existsSync(path.join(root, "README.md"))) {
        return [{
          dimension: dimId, title: "Missing README", claim: "repository has no README.md onboarding entry point",
          file: "package.json", line: 1, severity: "low", confidence: 0.9,
          method: "static", check: { type: "no-readme" },
        }];
      }
      return [];
    }
    default:
      return []; // performance / operability / extras: no safe deterministic heuristic offline
  }
}

// Self-contained, re-runnable check spec for a static candidate: the cited file
// rides along so refresh/roadmap can re-execute it without the candidate object.
function staticCheckSpec(cand) {
  return { ...(cand.check ?? {}), file: cand.check?.file ?? cand.file };
}

// ---------------------------------------------------------------------------
// Adversarial verification (reproduce-or-kill, F2/F4)
// ---------------------------------------------------------------------------
function sanitizeRepro(obj, root) {
  if (obj && typeof obj === "object" && obj.grep && typeof obj.grep === "object") {
    const { pattern, file } = obj.grep;
    if (typeof pattern === "string" && pattern.length <= 200 &&
        typeof file === "string" && isSafeRelPath(file)) {
      return { kind: "grep", pattern, file };
    }
    return null;
  }
  const cmd = obj?.reproCmd;
  if (typeof cmd !== "string") return null;
  let m = /^node --test\s+(\S+)$/.exec(cmd.trim());
  if (m && isSafeRelPath(m[1]) && fs.existsSync(path.join(root, m[1]))) return { kind: "test", file: m[1] };
  m = /^node -e\s+([\s\S]+)$/.exec(cmd.trim());
  if (m) {
    let snippet = m[1].trim();
    if ((snippet.startsWith('"') && snippet.endsWith('"')) || (snippet.startsWith("'") && snippet.endsWith("'"))) {
      snippet = snippet.slice(1, -1);
    }
    if (snippet.length > 0 && snippet.length <= 500) return { kind: "eval", snippet };
  }
  return null;
}

function runRepro(root, repro, exec) {
  if (repro.kind === "grep") {
    const check = { type: "grep", pattern: repro.pattern, file: repro.file };
    const res = runReproCheck(root, check);
    return { exitCode: res.ok === true ? 0 : 1, record: res.record, check };
  }
  const args = repro.kind === "test" ? ["--test", repro.file] : ["-e", repro.snippet];
  const r = exec("node", args, { cwd: root, timeout: REPRO_TIMEOUT_MS });
  const status = typeof r.status === "number" ? r.status : 1;
  return {
    exitCode: status,
    cmd: ["node", ...args],
    record: truncate(`$ node ${repro.kind === "test" ? `--test ${repro.file}` : "-e <snippet>"}\nexit ${status}\n${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim(), 2000),
  };
}

function codeSlice(root, file, line, span) {
  try {
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    const start = Math.max(0, line - 1 - span);
    const end = Math.min(lines.length, line + span);
    return lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join("\n");
  } catch {
    return "(cited file unreadable)";
  }
}

async function verifyCandidate(ctx, cand, head7) {
  const { root, llm, exec, log } = ctx;
  const citation = { file: cand.file, line: cand.line, sha: head7 };
  const { verified } = verifyCitations(root, [citation], exec);
  if (verified.length === 0) return { verified: false, reason: "citation does not verify against the worktree" };
  const evidence = [{ file: cand.file, line: cand.line, sha: head7 }];

  if (cand.method === "static") {
    const checkSpec = staticCheckSpec(cand);
    const check = runReproCheck(root, checkSpec);
    return check.ok === true
      ? { verified: true, evidence, reproduction: { method: "static", record: check.record, exitCode: null, check: checkSpec } }
      : { verified: false, reason: `static check did not reproduce: ${check.record}` };
  }
  if (llm.offline) return { verified: false, reason: "offline: no deterministic reproduction available" };

  // a) deterministic reproduction first
  let repro = null;
  try {
    const obj = await jsonCall(llm, {
      prompt: `Claim: ${cand.claim}\nCited location: ${cand.file}:${cand.line}\nPropose a mechanical reproduction check, or {"reproCmd":null}.`,
      system: REPRO_SYSTEM, tier: "mid", label: "repro-cmd",
    }, () => ({ reproCmd: null }));
    repro = sanitizeRepro(obj, root);
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    repro = null; // unparseable proposal → fall through to blind reread
  }
  if (repro) {
    const r = runRepro(root, repro, exec);
    if (r.exitCode === 0) {
      return {
        verified: true,
        evidence,
        reproduction: {
          method: "command", record: r.record, exitCode: 0,
          ...(r.cmd ? { cmd: r.cmd } : {}),
          ...(r.check ? { check: r.check } : {}),
        },
      };
    }
    return { verified: false, reason: `reproduction command failed (exit ${r.exitCode})` };
  }

  // b) blind frontier reread — proposer reasoning withheld (F2)
  try {
    const slice = codeSlice(root, cand.file, cand.line, 40);
    const obj = await jsonCall(llm, {
      prompt: `Bare claim: ${cand.claim}\n\nCited code slice (${cand.file}, ±40 lines around line ${cand.line}):\n${slice}`,
      system: VERDICT_SYSTEM, tier: "frontier", label: "verdict",
    }, () => ({ verdict: "UNCERTAIN" }));
    const v = String(obj?.verdict ?? "").toUpperCase();
    if (v === "CONFIRM") {
      return {
        verified: true, evidence,
        reproduction: { method: "reread", record: truncate(`CONFIRM (blind reread): ${String(obj?.reason ?? "")}`.trim(), 1000), exitCode: null },
      };
    }
    log?.substep?.(`killed (verdict ${v || "missing"}): ${cand.title}`);
    return { verified: false, reason: `verdict ${v || "missing"}` };
  } catch (e) {
    if (e instanceof BudgetError) throw e;
    return { verified: false, reason: "unparseable verdict (fail closed)" };
  }
}

// ---------------------------------------------------------------------------
// T3 semantic dedupe — the SECOND admission filter, layered over the free hash
// filter (dedupeKey). Only hash-survivors reach here, and only online (the
// offline path never calls finderCell). One cheap-tier call per survivor,
// comparing it against `priorSameCell` — prior ADMITTED entries (this run's
// pool + prior VERIFIED findings) that share the candidate's dimension AND
// file. Returns true iff the model judges the candidate a paraphrase of one of
// them.
//
// FAILS OPEN — deliberately, and this is the ONE sanctioned fail-open path in
// D2; every other failure here fails CLOSED (drop the candidate, kill the
// finding). An unparseable response, an out-of-range index, or a thrown error
// (network exhaustion, bad JSON) is treated as "not a duplicate" → the
// candidate is ADMITTED. Rationale for the asymmetry: a false NEW costs one
// wasted downstream verification call — and verification kills genuine junk
// anyway — whereas a false DUPLICATE permanently suppresses a real finding that
// nothing downstream can resurrect. When the cheap judge is uncertain or
// broken, admitting is the recoverable error. (BudgetError is NOT a
// semantic-check failure — it is the hard spend ceiling, so it still rethrows
// stop-the-world, matching every other call site in this file.)
async function isSemanticDuplicate(ctx, cand, priorSameCell) {
  const { llm, log } = ctx;
  if (priorSameCell.length === 0) return false; // nothing to be a duplicate of — skip the call entirely
  const list = priorSameCell
    .map((p, i) => `${i}. title: ${p.title}\n   claim: ${p.claim}`)
    .join("\n");
  const prompt =
    `Prior findings for dimension "${cand.dimension}" in ${cand.file}:\n${list}\n\n` +
    `New finding:\n   title: ${cand.title}\n   claim: ${cand.claim}\n\n` +
    'Is the new finding a semantic duplicate of one listed above? Respond {"duplicateOf": <index>|null}.';
  try {
    const obj = await jsonCall(llm, {
      prompt, system: DEDUPE_SYSTEM, tier: "cheap", label: `dedupe:${cand.dimension}`,
    }, () => ({ duplicateOf: null }));
    const idx = obj?.duplicateOf;
    if (idx === null || idx === undefined) return false; // model says genuinely new
    const n = Number(idx);
    if (Number.isInteger(n) && n >= 0 && n < priorSameCell.length) return true;
    // Out-of-range / non-integer index: fail OPEN — admit. (See doctrine above.)
    log?.warn?.(
      `dedupe:${cand.dimension}: semantic check returned an out-of-range index ${JSON.stringify(idx)} ` +
      `(list length ${priorSameCell.length}) — fail open, admitting the candidate.`,
    );
    return false;
  } catch (e) {
    if (e instanceof BudgetError) throw e; // budget ceiling stops the world, never fails open
    // Network exhaustion / unparseable JSON after the LLM layer's own retries:
    // fail OPEN — admit. (See doctrine above.)
    log?.warn?.(
      `dedupe:${cand.dimension}: semantic check failed (${e.message}) — fail open, admitting the candidate.`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// D2 finder coverage manifest (§7.6) — an auditable record of exactly what the
// packetized finder loop examined, written idempotently into D1's
// coverage-manifest.md.
// ---------------------------------------------------------------------------
const D2_COVERAGE_HEADING = "## D2 finder coverage";

function d2CoverageSection({ dims, offline, passesByDimension, packetsByDimension, suppressedByDimension, examinedFiles, truncatedFiles, unreadableFiles }) {
  const examinedTxt = examinedFiles.length ? examinedFiles.join(", ") : "(none)";
  const truncatedTxt = truncatedFiles.length ? truncatedFiles.join(", ") : "(none)";
  const lines = [D2_COVERAGE_HEADING, ""];
  for (const dim of dims) {
    const packets = packetsByDimension[dim.id] ?? 0;
    const passes = passesByDimension[dim.id] ?? 0;
    const suppressed = suppressedByDimension?.[dim.id] ?? 0;
    lines.push(`### ${dim.id}`);
    lines.push(`- Files examined: ${examinedTxt}`);
    lines.push(`- Packets: ${packets}${offline ? " (offline — no packetization)" : ""}`);
    lines.push(`- Total passes: ${passes}`);
    // T3 semantic suppressions — declared, never silent (adversarial review
    // finding: a false-duplicate permanently loses a real finding, and that
    // outcome was previously invisible anywhere in the run's output).
    lines.push(`- Semantic suppressions: ${suppressed}`);
    lines.push(`- Truncated slices: ${truncatedTxt}`);
    lines.push("");
  }
  lines.push("### Unexamined");
  if (unreadableFiles.length === 0) lines.push("- (none)");
  else for (const f of unreadableFiles) lines.push(`- ${f} (unreadable)`);
  return lines.join("\n");
}

// Replace the existing "## D2 finder coverage" section (if present) or append a
// fresh one — idempotent, so re-runs update rather than duplicate.
function replaceOrAppendD2Section(body, section) {
  const lines = String(body ?? "").split("\n");
  const start = lines.findIndex((l) => l.trim() === D2_COVERAGE_HEADING);
  let head, tail;
  if (start === -1) {
    head = lines;
    tail = [];
  } else {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].startsWith("## ")) { end = i; break; }
    }
    head = lines.slice(0, start);
    tail = lines.slice(end);
  }
  const headTxt = head.join("\n").replace(/\s+$/, "");
  const tailTxt = tail.join("\n").replace(/^\s+/, "").replace(/\s+$/, "");
  const parts = headTxt ? [headTxt, "", section] : [section];
  if (tailTxt) parts.push("", tailTxt);
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
}

function writeD2Coverage(dotdir, data) {
  const rel = LAYOUT.comprehension.coverageManifest;
  const existing = readArtifact(dotdir, rel);
  const meta = existing?.meta ?? {};
  const body = existing?.body ?? "# Coverage Manifest\n";
  writeArtifact(dotdir, rel, { meta, body: replaceOrAppendD2Section(body, d2CoverageSection(data)) });
}

// One (dimension × packet) cell: loop-until-dry (K_DRY consecutive zero-new
// passes, MAX_PASSES cap). priorConclusions is pool-wide per dimension — a
// candidate already found via another packet is never re-proposed here.
async function finderCell(ctx, { dim, packetText, pool, priorFixed, seen, base, lenses, poolWidth, taxonomyDoc }) {
  const { llm, log } = ctx;
  const newCands = [];
  let suppressed = 0;
  let dryStreak = 0;
  let pass = 0;
  while (pass < MAX_PASSES && dryStreak < K_DRY) {
    const passIndex = pass;
    pass += 1;
    // One shared context per pass (prior conclusions + packet); the N pooled
    // calls differ ONLY by their assigned lens. Candidates from all N are
    // validated and deduped together — the pass's newCount is the POOLED total,
    // and the dry streak advances only when the whole pool yields zero new.
    const priorList = priorFixed.concat(pool.map((c) => ({ title: c.title, file: c.file })));
    const priorTxt = priorList.length
      ? priorList.map((c) => `- ${c.title} (${c.file})`).join("\n")
      : "(none)";
    const prompt =
      `Dimension under refutation: ${dim.label} (charter weight ${dim.weight}).\n\n` +
      `${dimensionBrief(taxonomyDoc, dim)}\n\n` +
      `Conclusions of prior passes — do NOT repeat these; find NEW evidence or return an empty list:\n${priorTxt}\n\n` +
      `Code under review:\n${packetText}\n\n` +
      'Return JSON {"candidates":[{"title":"...","claim":"...","file":"src/x.js","line":12,"severity":"critical|high|medium|low","confidence":0.8}]} — empty array if nothing new.';
    let newCount = 0;
    for (let i = 0; i < poolWidth; i++) {
      const lens = lenses[(passIndex + i) % lenses.length];
      const system = `${base}\n\nLens: ${lens.text}`;
      // A BudgetError from any pooled call rethrows immediately (stop-the-world,
      // matching the single-finder contract); any other error, after the LLM
      // layer's own retries, propagates and fails the phase (fail closed — a
      // silently absent pool member would be undeclared coverage loss).
      const obj = await jsonCall(llm, { prompt, system, tier: "mid", label: `finder:${dim.id}` }, () => ({ candidates: [] }));
      const raw = Array.isArray(obj) ? obj : Array.isArray(obj?.candidates) ? obj.candidates : [];
      for (const r of raw) {
        const cand = validateCandidate(r, dim.id, log);
        if (!cand) continue;
        const key = dedupeKey(cand);
        // (a) Hash filter — free, unchanged, FIRST. Exact/normalized-wording
        // repeats never reach the semantic tier.
        if (seen.has(key)) continue;
        // (b) Semantic filter (T3) — hash-survivors only, online only. Compare
        // against prior ADMITTED entries (prior verified findings + this run's
        // pool) sharing this candidate's dimension AND file. A judged paraphrase
        // is suppressed: it does NOT join the pool or become a finding, and it
        // is NOT counted toward newCount (so it neither resets nor blocks the
        // dry streak). Its hash key IS recorded, so the identical paraphrase is
        // not re-litigated by a later pass.
        if (!llm.offline) {
          const priorSameCell = priorFixed
            .concat(pool)
            .filter((p) => p.dimension === cand.dimension && p.file === cand.file);
          if (await isSemanticDuplicate(ctx, cand, priorSameCell)) {
            seen.add(key);
            // Declared, never silent (adversarial review finding): a
            // semantic suppression is the one outcome the fail-open doctrine
            // calls "permanently loses a finding nothing downstream can
            // resurrect" — it must be as visible as a killed candidate.
            suppressed += 1;
            log?.substep?.(`suppressed [${dim.id}] "${cand.title}" — judged a semantic duplicate in ${cand.file}`);
            continue;
          }
        }
        seen.add(key);
        pool.push(cand);
        newCands.push(cand);
        newCount += 1;
      }
    }
    dryStreak = newCount === 0 ? dryStreak + 1 : 0;
  }
  return { passes: pass, dry: dryStreak >= K_DRY, newCands, suppressed };
}

// ---------------------------------------------------------------------------
// Phase entry point
// ---------------------------------------------------------------------------
export async function run(ctx) {
  const { root, dotdir, llm, log, exec } = ctx;
  const flags = ctx.flags ?? {};
  const now = ctx.now;
  let state = ctx.state;
  try {
    if (!state?.gates?.comprehend?.passed) {
      throw new OpError("Comprehension gate not passed — `do-better audit` runs D1 before D2; resolve the comprehend gate first.");
    }
    const charterArt = readArtifact(dotdir, LAYOUT.charter);
    if (!charterArt) throw new OpError("Missing .dobetter/charter.md — run `do-better charter` first.");
    const headSha = gitHeadSha(root, exec);
    const head7 = headSha.slice(0, 7);
    const offline = llm.offline === true;

    const dims = orderedDimensions(charterArt.meta ?? {});
    const { base: refuteBase, lenses } = parseLenses(loadRef("refute-charter.md", FALLBACK_REFUTE), log);
    const poolMax = charterPoolMax(flags.n);
    const taxonomyDoc = loadRef("taxonomy.md", "");
    const declaredFiles = deepReadFileList(dotdir, state);
    const slices = loadSlices(root, declaredFiles);
    const examinedFiles = slices.map((s) => s.file);
    const unreadableFiles = declaredFiles.filter((f) => !examinedFiles.includes(f));
    const truncatedFiles = slices.filter((s) => renderSlice(s).length > PACKET_BYTES).map((s) => s.file);
    const dryCellsFingerprint = packetSetFingerprint(slices);

    // Partition the whole readable set into packets (online only); offline runs
    // a single deterministic static pass and does not consume packets.
    const packets = offline ? [] : partitionSlices(slices);

    // Starvation is a gate failure, never a silent zero-finding pass: an online
    // run with no readable deep-read files has nothing to examine (F4).
    if (!offline && packets.length === 0) {
      state = addSpend(state, PHASE_ID, llm.drainSpend());
      state = setGate(state, "identify", { passed: false, dryPassesByDimension: {}, packetsByDimension: {}, unverified: 0 });
      state = recordPhase(state, PHASE_ID, { status: "failed", sha: headSha, now: now() });
      const detail =
        `deep-read set is empty or unreadable — no packets to examine online ` +
        `(${declaredFiles.length} declared, ${examinedFiles.length} readable); ` +
        "re-run D1 comprehend so D2 has code to refute, or use --offline for a static-only pass.";
      const err = makeGateError(`Gate failed: identify — ${detail}`, "identify", detail);
      err.state = state;
      throw err;
    }

    // Persisted per-cell dry state: on a re-run against the SAME headSha
    // (resuming after a BudgetError before the next phase pins a new sha),
    // packets already recorded dry are skipped — zero finder calls reissued. A
    // sha change discards this entirely (full re-examination).
    //
    // Completion guard, keyed on a DEDICATED marker, not phase `status`
    // (adversarial review finding, round 2 — a `status`-keyed guard has its
    // own bug): dry-cell state is only honored when the prior run's
    // `dryCellsComplete` flag is not true — i.e. this is a genuine resume
    // after a BudgetError or a not-dry gate failure, never a run that
    // actually finished. `status` is unsuitable for this because a
    // BudgetError never calls recordPhase — it propagates straight through
    // the outer catch, which only attaches spend, so `status` keeps
    // whatever value it had BEFORE this run started. A guard keyed on
    // `status === "done"` therefore breaks exactly the case it exists to
    // protect: complete a run (status "done") → deliberately re-audit
    // (correctly discards stale dry state) → that re-audit hits a
    // BudgetError mid-loop → `status` is STILL "done" (never touched by the
    // interruption) → the next resume wrongly discards the dry-cell
    // progress THIS interrupted run just persisted, restarting from zero
    // forever under a tight budget. `dryCellsComplete` avoids this: it is
    // explicitly reset to false at the top of every run (below) and is set
    // true ONLY at the actual successful-completion point, so an
    // interrupted run's incremental patches always persist it as false.
    const priorIdentify = state?.phases?.identify ?? {};
    const priorComplete = priorIdentify.dryCellsComplete === true;
    // Honored only when the commit sha, the content fingerprint, AND the
    // search width all match (round-5 adversarial review finding, extending
    // round 4): sha+fingerprint alone are not enough — a cell recorded dry
    // at a NARROWER pool width (fewer lenses fanned over it) was never
    // actually searched as hard as a WIDER --n on resume intends. This is
    // the exact "dry only verified at the OLD width" loss the completion
    // guard exists to prevent, which round 1 closed only for the
    // dryCellsComplete===true (successfully-completed) path — the
    // interrupted/failed-run resume path is equally a case where a user
    // legitimately widens --n between attempts. A recorded width that is
    // >= the current poolMax is still safe to trust (more lenses can only
    // find MORE, never less, so a wider-verified dry cell is also
    // narrower-verified-dry); only a genuine increase invalidates. poolMax
    // is the shared ceiling (not per-dimension), so comparing it once here
    // is equivalent to comparing every dimension's own effective width —
    // whole-cache invalidation on any increase, same simplicity tradeoff as
    // the content fingerprint.
    const priorDry = !priorComplete
      && priorIdentify.dryCellsSha === headSha
      && priorIdentify.dryCellsFingerprint === dryCellsFingerprint
      && (priorIdentify.dryCellsPoolMax ?? 1) >= poolMax
      ? (priorIdentify.dryCellsByDimension ?? {})
      : {};
    // Reset for THIS run — and this must clear the PERSISTED dry-cell data
    // too, not just the in-memory `priorDry` computed above (round-3
    // adversarial review finding: clearing only `dryCellsComplete` left a
    // window between here and the first per-dimension patchPhase call,
    // below, where `state.phases.identify.dryCellsByDimension` still held
    // the PRIOR completed run's stale set. A BudgetError firing inside that
    // window — realistic: it can fire on the very first finder call, before
    // any dimension's loop iteration completes — persisted exactly that
    // stale set alongside dryCellsComplete:false, and the next resume
    // honored it as if it were THIS run's own progress, silently skipping
    // cells the re-audit existed to re-examine). Clearing
    // dryCellsByDimension/dryCellsSha/dryCellsFingerprint/dryCellsPoolMax
    // here, in the SAME patch, means an early interruption's persisted state
    // truthfully shows "nothing recorded yet for this attempt" rather than
    // resurrecting stale data. When priorComplete is false (a genuine
    // resume) and sha/fingerprint/width all match, this is a no-op in
    // effect — the existing values are either what priorDry already
    // captured (resume case) or already stale (discarded either way by the
    // read above).
    state = patchPhase(state, PHASE_ID, { dryCellsComplete: false, dryCellsByDimension: priorDry, dryCellsSha: headSha, dryCellsFingerprint, dryCellsPoolMax: poolMax });

    const passesByDimension = {};
    const packetsByDimension = {};
    // Seeded with priorDry (not started empty): each per-dimension patchPhase
    // call below persists this WHOLE object, overwriting the persisted key
    // entirely — a dimension not yet reached by the loop would otherwise
    // vanish from the persisted snapshot the moment an EARLIER dimension's
    // own persist fires, even though its resumed data is still valid and
    // sitting correctly in priorDry. Seeding preserves it until (and unless)
    // that dimension's own turn genuinely overwrites its entry.
    const dryCellsByDimension = { ...priorDry };
    const notDry = []; // [{ dim, packet }] — starvation detail names dimension AND packet
    const counts = {};
    // D6 idempotency: seed the dedupe set from already-verified findings so
    // re-runs reconcile against .dobetter/findings/ instead of duplicating
    // finding files and burning new IDs for identical claims. The same findings
    // seed each dimension's prior-conclusions, so a resumed cell picks up from
    // its recorded pool instead of a blank slate.
    const seen = new Set();
    const priorByDim = {};
    for (const prior of readFindings(dotdir)) {
      const file = prior.evidence?.[0]?.file ?? "";
      seen.add(dedupeKey({ dimension: prior.dimension, file, claim: prior.claim ?? prior.title }));
      seen.add(dedupeKey({ dimension: prior.dimension, file, claim: prior.title }));
      // dimension + claim ride along (beyond title/file) so the T3 semantic
      // filter can offer prior verified findings as same-cell comparison
      // entries — a paraphrase of a finding verified in a PREVIOUS run is caught
      // too, not just repeats within this run.
      (priorByDim[prior.dimension] ??= []).push({
        dimension: prior.dimension, title: prior.title, claim: prior.claim ?? prior.title, file,
      });
    }
    let killed = 0;
    let verifiedCount = 0;

    // reproduce-or-kill — unverified findings never reach output (D8/F4).
    const verifyAndRecord = async (dimId, candidates) => {
      for (const cand of candidates) {
        const verdict = await verifyCandidate(ctx, cand, head7);
        if (verdict.verified) {
          const next = nextFindingId(state, dimId);
          state = next.state;
          writeFinding(dotdir, {
            id: next.id, dimension: dimId, title: cand.title, claim: cand.claim, severity: cand.severity,
            confidence: cand.confidence, evidence: verdict.evidence, reproduction: verdict.reproduction,
            status: "verified", foundAt: now(), headSha, stale: false,
          });
          verifiedCount += 1;
          counts[dimId].verified += 1;
        } else {
          killed += 1;
          counts[dimId].killed += 1;
          log?.substep?.(`killed [${dimId}] ${cand.title} — ${verdict.reason}`);
        }
      }
    };

    for (const dim of dims) {
      counts[dim.id] = { verified: 0, killed: 0, suppressed: 0 };

      if (offline) {
        const pool = [];
        for (const raw of staticFinderPass(dim.id, root, slices)) {
          const cand = validateCandidate(raw, dim.id, log);
          if (!cand) continue;
          cand.method = "static";
          cand.check = raw.check;
          const key = dedupeKey(cand);
          if (!seen.has(key)) { seen.add(key); pool.push(cand); }
        }
        passesByDimension[dim.id] = 1; // single deterministic pass, dry by construction (declared degradation)
        packetsByDimension[dim.id] = 0; // offline: no packetization
        await verifyAndRecord(dim.id, pool);
        continue;
      }

      const pool = [];
      const priorFixed = priorByDim[dim.id] ?? [];
      const priorDryForDim = priorDry[dim.id] ?? [];
      // Clamp to the lens catalog size (adversarial review finding): beyond
      // lenses.length, pool member i and i+lenses.length receive the SAME
      // lens (rotation wraps) and thus an IDENTICAL prompt — a fully
      // redundant call that cannot add coverage but still spends budget.
      const poolWidth = Math.min(charterPoolWidth(dim.weight, poolMax), lenses.length);
      const dryCells = [];
      let totalPasses = 0;
      for (let pi = 0; pi < packets.length; pi++) {
        if (priorDryForDim.includes(pi)) {
          dryCells.push(pi); // recorded dry on a prior same-sha run — skip, no finder calls
          continue;
        }
        const cell = await finderCell(ctx, {
          dim, packetText: packets[pi].packet, pool, priorFixed, seen, base: refuteBase, lenses, poolWidth, taxonomyDoc,
        });
        totalPasses += cell.passes;
        counts[dim.id].suppressed += cell.suppressed;
        if (cell.dry) dryCells.push(pi);
        else notDry.push({ dim: dim.id, packet: pi });
        await verifyAndRecord(dim.id, cell.newCands);
        // Persist incrementally so a BudgetError mid-loop leaves the dry-cell
        // state (and verified findings, already on disk) recoverable on re-run.
        passesByDimension[dim.id] = totalPasses;
        packetsByDimension[dim.id] = packets.length;
        dryCellsByDimension[dim.id] = dryCells.slice();
        state = patchPhase(state, PHASE_ID, { passesByDimension, packetsByDimension, dryCellsByDimension, dryCellsSha: headSha, dryCellsFingerprint, dryCellsPoolMax: poolMax });
      }
      passesByDimension[dim.id] = totalPasses;
      packetsByDimension[dim.id] = packets.length;
      dryCellsByDimension[dim.id] = dryCells;
      state = patchPhase(state, PHASE_ID, { passesByDimension, packetsByDimension, dryCellsByDimension, dryCellsSha: headSha, dryCellsFingerprint, dryCellsPoolMax: poolMax });
    }

    const suppressedByDimension = {};
    for (const dim of dims) suppressedByDimension[dim.id] = counts[dim.id]?.suppressed ?? 0;
    writeD2Coverage(dotdir, {
      dims, offline, passesByDimension, packetsByDimension, suppressedByDimension, examinedFiles, truncatedFiles, unreadableFiles,
    });

    state = patchPhase(state, PHASE_ID, {
      passesByDimension, packetsByDimension, dryCellsByDimension, dryCellsSha: headSha, dryCellsFingerprint, dryCellsPoolMax: poolMax,
      killed, verified: verifiedCount,
    });
    state = addSpend(state, PHASE_ID, llm.drainSpend());

    if (notDry.length > 0) {
      state = setGate(state, "identify", { passed: false, dryPassesByDimension: passesByDimension, packetsByDimension, unverified: 0 });
      state = recordPhase(state, PHASE_ID, { status: "failed", sha: headSha, now: now() });
      const cellList = notDry.map(({ dim, packet }) => `${dim}[packet ${packet}]`).join(", ");
      const detail = `cell(s) not dry after ${MAX_PASSES} passes: ${cellList} — finders kept producing new candidates; re-run audit (verified findings so far are preserved in .dobetter/findings/)`;
      const err = makeGateError(`Gate failed: identify — ${detail}`, "identify", detail);
      err.state = state;
      throw err;
    }

    state = setGate(state, "identify", { passed: true, dryPassesByDimension: passesByDimension, packetsByDimension, unverified: 0 });
    state = recordPhase(state, PHASE_ID, { status: "done", sha: headSha, now: now() });
    state = pinSha(state, PHASE_ID, headSha);
    // Mark dry-cell state complete ONLY here, at genuine successful
    // completion — this is what the completion guard above checks, not
    // `status` (see the comment there for why `status` alone is unsafe).
    state = patchPhase(state, PHASE_ID, { dryCellsComplete: true });

    const perDim = dims
      .map((d) => `${d.id}: ${counts[d.id].verified} verified / ${counts[d.id].killed} killed / ${counts[d.id].suppressed} suppressed (${passesByDimension[d.id]} pass${passesByDimension[d.id] === 1 ? "" : "es"})`)
      .join("; ");
    const summary =
      `Identify complete @ ${head7}: every (dimension × packet) cell ran dry (K=${K_DRY}); ${verifiedCount} finding(s) verified, ${killed} killed, 0 unverified written. ` +
      (offline ? "DEGRADED: offline static-analysis pass only — re-run online for LLM finders. " : "") +
      `Per dimension — ${perDim}. (Finding counts are not a success metric; ticket quality is.)`;
    return {
      state,
      gate: { name: "identify", passed: true, human: false, detail: `all dimensions dry, ${verifiedCount} verified, 0 unverified` },
      summary,
    };
  } catch (err) {
    if (!err.state) {
      try { err.state = addSpend(state, PHASE_ID, llm.drainSpend()); } catch { err.state = state; }
    }
    throw err;
  }
}
