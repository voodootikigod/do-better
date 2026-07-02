// src/adlc.js — locate + spawn the five @adlc package CLIs and skill-mining
// (SPEC §5 composition contracts). The aidlc bins import core via relative
// paths, so they must run in place inside an aidlc checkout — never copied out.
//
// Absence is never an exception: every wrapper returns { skipped: true, reason }
// when its tool is unavailable, and the CALLER applies (and declares) the
// graceful degradation from the blueprint §5 table.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpError, log, makeExec } from "./utils.js";

export const ADLC_TOOLS = ["parallax", "coldstart", "hollow-test", "behavior-diff", "preflight"];

const DEFAULT_TIMEOUT_MS = 600000;
const REASON_NOT_INSTALLED = "not installed";

function defaultPackageRoot() {
  // src/adlc.js → package root is one level up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function isTruthyEnv(v) {
  return v != null && v !== "" && v !== "0" && v !== "false";
}

function adlcBinPath(dir, name) {
  return path.join(dir, "packages", name, "bin", `${name}.mjs`);
}

function probeAdlcDir(dir) {
  const available = {};
  for (const name of ADLC_TOOLS) {
    available[name] = existsSync(adlcBinPath(dir, name));
  }
  return available;
}

function emptyAvailability() {
  const available = {};
  for (const name of ADLC_TOOLS) available[name] = false;
  available["skill-mining"] = false;
  return available;
}

// Locate an aidlc checkout (and a skill-mining checkout, separately).
// Probe order (first hit wins): env.DOBETTER_ADLC_DIR → sibling of the
// do-better package → sibling of the target repo → npx fallback. Setting
// DOBETTER_NO_NPX disables the npx fallback (mode "absent") so air-gapped runs
// and tests degrade deterministically instead of touching the network.
export function locateAdlc({ env = process.env, packageRoot, targetRoot } = {}) {
  const pkgRoot = packageRoot ?? defaultPackageRoot();
  const tgtRoot = targetRoot ?? process.cwd();
  const noNpx = isTruthyEnv(env.DOBETTER_NO_NPX);

  let mode = "absent";
  let dir = null;
  const available = emptyAvailability();

  const candidates = [];
  if (env.DOBETTER_ADLC_DIR) {
    candidates.push({ dir: path.resolve(env.DOBETTER_ADLC_DIR), explicit: true });
  }
  candidates.push({ dir: path.resolve(pkgRoot, "..", "aidlc") });
  candidates.push({ dir: path.resolve(tgtRoot, "..", "aidlc") });

  for (const candidate of candidates) {
    const probed = probeAdlcDir(candidate.dir);
    if (ADLC_TOOLS.some((name) => probed[name])) {
      mode = "dir";
      dir = candidate.dir;
      for (const name of ADLC_TOOLS) available[name] = probed[name];
      break;
    }
    if (candidate.explicit) {
      log.warn(
        `DOBETTER_ADLC_DIR=${candidate.dir} contains no @adlc tool bins ` +
          `(expected packages/<name>/bin/<name>.mjs) — continuing probe.`
      );
    }
  }

  if (mode === "absent" && !noNpx) {
    // npx fallback: each tool is verified lazily on first use; a failed npx
    // resolve flips that tool to unavailable for the session.
    mode = "npx";
    for (const name of ADLC_TOOLS) available[name] = true;
  }

  // skill-mining is located separately (different repo layout: bin/cli.js).
  let smMode = "absent";
  let smDir = null;
  const smCandidates = [];
  if (env.DOBETTER_SKILL_MINING_DIR) {
    smCandidates.push({ dir: path.resolve(env.DOBETTER_SKILL_MINING_DIR), explicit: true });
  }
  smCandidates.push({ dir: path.resolve(pkgRoot, "..", "skill-mining") });
  smCandidates.push({ dir: path.resolve(tgtRoot, "..", "skill-mining") });
  for (const candidate of smCandidates) {
    if (existsSync(path.join(candidate.dir, "bin", "cli.js"))) {
      smMode = "dir";
      smDir = candidate.dir;
      break;
    }
    if (candidate.explicit) {
      log.warn(
        `DOBETTER_SKILL_MINING_DIR=${candidate.dir} does not look like a skill-mining checkout ` +
          `(no bin/cli.js) — continuing probe.`
      );
    }
  }
  if (smMode === "absent" && !noNpx) smMode = "npx";
  available["skill-mining"] = smMode !== "absent";

  return { mode, dir, available, skillMining: { mode: smMode, dir: smDir } };
}

// Heuristic: did the spawn fail because npx could not resolve the package
// (vs the tool itself running and exiting non-zero)?
function npxResolveFailed(result) {
  if (result?.error?.code === "ENOENT") return true; // npx binary itself absent
  if (result?.status === 0) return false;
  const stderr = result?.stderr ?? "";
  return (
    /npm (?:ERR!|error)/i.test(stderr) &&
    /E404|ETARGET|ENOTFOUND|could not determine executable/i.test(stderr)
  );
}

function toToolResult(result, wantJson) {
  const exitCode = Number.isInteger(result.status) ? result.status : null;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  let json = null;
  let parseFailed = false;
  if (wantJson) {
    try {
      json = JSON.parse(stdout.trim());
    } catch {
      json = null;
      parseFailed = true;
    }
  }
  const ok = exitCode === 0;
  const gateFailed = exitCode === 2;
  // Universal adlc exit contract: 0 pass / 1 could-not-run / 2 gate failed.
  // Anything that is neither pass nor gate-fail (incl. spawn failure / timeout
  // → status null) is operational; an unparseable --json stdout is too.
  const opError = (!ok && !gateFailed) || parseFailed;
  return { skipped: false, ok, gateFailed, opError, exitCode, stdout, stderr, json };
}

function truncateForReason(text, max = 300) {
  const t = String(text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Spawn one adlc tool. Never throws for tool ABSENCE ({ skipped: true });
// throws OpError only for caller bugs (unknown tool name, malformed args).
// LLM key env vars pass through to the child via the inherited environment
// (parallax/coldstart autodetect ANTHROPIC → OPENAI → GEMINI themselves).
export function runAdlcTool(loc, name, args = [], { cwd, exec, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!ADLC_TOOLS.includes(name)) {
    throw new OpError(`Unknown adlc tool "${name}" (expected one of: ${ADLC_TOOLS.join(", ")}).`);
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new OpError(`adlc ${name}: args must be an array of strings.`);
  }
  if (!loc || loc.mode === "absent" || !loc.available?.[name]) {
    return { skipped: true, reason: REASON_NOT_INSTALLED };
  }
  const run = exec ?? makeExec();
  let result;
  if (loc.mode === "dir") {
    const binPath = adlcBinPath(loc.dir, name);
    if (!existsSync(binPath)) {
      loc.available[name] = false; // drift since locate — flip for the session
      return { skipped: true, reason: REASON_NOT_INSTALLED };
    }
    result = run(process.execPath, [binPath, ...args], { cwd, timeout: timeoutMs });
  } else if (loc.mode === "npx") {
    result = run("npx", ["--yes", `@adlc/${name}`, ...args], { cwd, timeout: timeoutMs });
    if (npxResolveFailed(result)) {
      loc.available[name] = false; // session flip — sanctioned service-object mutation
      return { skipped: true, reason: `npx could not resolve @adlc/${name}` };
    }
  } else {
    return { skipped: true, reason: REASON_NOT_INSTALLED };
  }
  return toToolResult(result, args.includes("--json"));
}

// LLM-backed tools (parallax, coldstart) exit 1 when they cannot run at all —
// most commonly no API key in env. Blueprint §5: treat as absent for that run
// so callers apply the same declared degradation as for a missing tool.
function couldNotRun(name, r) {
  return {
    skipped: true,
    reason: `${name} could not run (exit 1): ${truncateForReason(r.stderr || r.stdout) || "no output"}`,
  };
}

// D1 divergence gate. gate === true ⇔ exit 0 (divergence below threshold).
export function runParallax(loc, { file, request, n = 3, threshold = 0.25, cwd, exec } = {}) {
  if (!file && !request) {
    throw new OpError("runParallax requires either { file } or { request }.");
  }
  const subject = file ? ["--file", file] : ["--request", request];
  const args = [...subject, "--n", String(n), "--threshold", String(threshold), "--json"];
  const r = runAdlcTool(loc, "parallax", args, { cwd, exec });
  if (r.skipped) return r;
  if (r.exitCode === 1) return couldNotRun("parallax", r);
  const j = r.json ?? {};
  return {
    skipped: false,
    gate: r.exitCode === 0,
    score: typeof j.score === "number" ? j.score : null,
    agreements: Array.isArray(j.agreements) ? j.agreements : [],
    divergences: Array.isArray(j.divergences) ? j.divergences : [],
    raw: r.json,
  };
}

// D3 coldstart gate over .dobetter/backlog/tickets.json (byte-compatible with
// aidlc's .adlc/tickets.json schema).
export function runColdstart(loc, { ticketsPath, all = true, ticketId, cwd, exec } = {}) {
  if (typeof ticketsPath !== "string" || ticketsPath.length === 0) {
    throw new OpError("runColdstart requires { ticketsPath }.");
  }
  if (!all && (typeof ticketId !== "string" || ticketId.length === 0)) {
    throw new OpError("runColdstart requires { ticketId } when all is false.");
  }
  const args = all
    ? ["--all", "--tickets", ticketsPath, "--json"]
    : [ticketId, "--tickets", ticketsPath, "--json"];
  const r = runAdlcTool(loc, "coldstart", args, { cwd, exec });
  if (r.skipped) return r;
  if (r.exitCode === 1) return couldNotRun("coldstart", r);
  const j = r.json ?? {};
  return {
    skipped: false,
    ok: r.exitCode === 0,
    results: Array.isArray(j.results) ? j.results : [],
    raw: r.json,
  };
}

// D4 hollow-test audit. cwd must be the TARGET repo.
export function runHollowTest(loc, { testCmd, base, max = 20, cwd, exec } = {}) {
  if (typeof testCmd !== "string" || testCmd.length === 0) {
    throw new OpError("runHollowTest requires { testCmd }.");
  }
  if (typeof base !== "string" || base.length === 0) {
    throw new OpError("runHollowTest requires { base }.");
  }
  const args = ["--test-cmd", testCmd, "--base", base, "--max", String(max), "--json"];
  const r = runAdlcTool(loc, "hollow-test", args, { cwd, exec });
  if (r.skipped) return r;
  const j = r.json ?? {};
  const summary =
    j.summary && typeof j.summary === "object" ? j.summary : { total: 0, killed: 0, survived: 0 };
  return {
    skipped: false,
    ok: r.ok,
    gateFailed: r.gateFailed,
    opError: r.opError,
    summary,
    mutants: Array.isArray(j.mutants) ? j.mutants : [],
    raw: r.json,
  };
}

// refresh regression detection. verb: "capture" | "compare"; args are the
// verb's own argv (e.g. ["--config", cfg, "--out", out, "--json"]).
export function runBehaviorDiff(loc, verb, args = [], { cwd, exec } = {}) {
  if (verb !== "capture" && verb !== "compare") {
    throw new OpError(`runBehaviorDiff verb must be "capture" or "compare", got "${verb}".`);
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    throw new OpError("runBehaviorDiff: args must be an array of strings.");
  }
  return runAdlcTool(loc, "behavior-diff", [verb, ...args], { cwd, exec });
}

// D4 env check. cwd must be the TARGET repo (preflight requires a git repo).
export function runPreflight(loc, { testCmd, cwd, exec } = {}) {
  const args = ["--json", ...(testCmd ? ["--test-cmd", testCmd] : [])];
  const r = runAdlcTool(loc, "preflight", args, { cwd, exec });
  if (r.skipped) return r;
  const j = r.json ?? {};
  return {
    skipped: false,
    ok: r.ok,
    gateFailed: r.gateFailed,
    opError: r.opError,
    checks: Array.isArray(j.checks) ? j.checks : [],
    verdict: typeof j.verdict === "string" ? j.verdict : r.ok ? "pass" : "fail",
    failedNames: Array.isArray(j.failedNames) ? j.failedNames : [],
    raw: r.json,
  };
}

// D1 sub-step: mine latent skills from the target repo.
export function runSkillMining(loc, { targetDir, offline = false, exec } = {}) {
  if (typeof targetDir !== "string" || targetDir.length === 0) {
    throw new OpError("runSkillMining requires { targetDir }.");
  }
  const sm = loc?.skillMining ?? { mode: "absent", dir: null };
  if (!loc?.available?.["skill-mining"] || sm.mode === "absent") {
    return { skipped: true, reason: REASON_NOT_INSTALLED };
  }
  const run = exec ?? makeExec();
  const tail = ["mine", targetDir, ...(offline ? ["--offline"] : [])];
  let result;
  if (sm.mode === "dir") {
    const binPath = path.join(sm.dir, "bin", "cli.js");
    if (!existsSync(binPath)) {
      loc.available["skill-mining"] = false;
      return { skipped: true, reason: REASON_NOT_INSTALLED };
    }
    result = run(process.execPath, [binPath, ...tail], { timeout: DEFAULT_TIMEOUT_MS });
  } else {
    result = run("npx", ["--yes", "skill-mining", ...tail], { timeout: DEFAULT_TIMEOUT_MS });
    if (npxResolveFailed(result)) {
      loc.available["skill-mining"] = false;
      return { skipped: true, reason: "npx could not resolve skill-mining" };
    }
  }
  return { skipped: false, ok: result.status === 0, stdout: result.stdout ?? "" };
}
