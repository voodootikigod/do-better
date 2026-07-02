// src/state.js — state.json schema v1: load/save, run history, spend, gates,
// SHA pins. All functions are pure (return new objects); loadState/saveState
// are the only I/O.

import fs from "node:fs";
import path from "node:path";
import { OpError, TAXONOMY, nowIso, writeFileAtomic } from "./utils.js";

export const STATE_VERSION = 1;
export const PHASES = ["scan", "charter", "comprehend", "identify", "roadmap", "rail", "refresh"];

const MAX_RUNS = 50;
const TOOL_VERSION = "0.1.0";

const round6 = (v) => Math.round(v * 1e6) / 1e6;
const clone = (s) => structuredClone(s);

function baseSpend() {
  return { calls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0 };
}

function basePhase(extra = {}) {
  return { status: "pending", completedAt: null, sha: null, spend: baseSpend(), ...extra };
}

export function defaultState({ headSha = null, now = nowIso() } = {}) {
  return {
    version: STATE_VERSION,
    createdAt: now,
    tool: { name: "do-better", version: TOOL_VERSION },
    target: { root: ".", headSha },
    pins: {
      scan: null,
      charter: null,
      comprehend: null,
      identify: null,
      roadmap: null,
      rail: null,
      refresh: null,
    },
    phases: {
      scan: basePhase({ facts: null }),
      charter: basePhase(),
      comprehend: basePhase({ divergence: null, readings: null }),
      identify: basePhase({ passesByDimension: {}, killed: 0, verified: 0 }),
      roadmap: basePhase({ ticketCount: 0, declinedCount: 0 }),
      rail: basePhase({ railsAuthored: 0, behaviorsCovered: 0, behaviorsGapped: 0 }),
      refresh: basePhase({ changedFiles: 0, staleClaims: 0 }),
    },
    gates: {
      charter: { approved: false, approvedAt: null, charterSha256: null },
      comprehend: { passed: false, divergence: null, threshold: 0.25, degraded: null },
      identify: { passed: false, dryPassesByDimension: {}, unverified: 0 },
      roadmap: {
        approved: false,
        approvedAt: null,
        coldstartClean: false,
        coldstartDegraded: null,
        roadmapSha256: null,
      },
      rail: {
        passed: false,
        railsGreen: false,
        hollowAudited: false,
        hollowSurvivors: 0,
        preflight: null,
      },
    },
    budget: { limitUSD: null, spentUSD: 0 },
    runs: [],
    roadmapHistory: [],
    counters: {
      findings: Object.fromEntries(TAXONOMY.map((d) => [d.id, 0])),
      tickets: 0,
    },
    adlc: {
      mode: null,
      dir: null,
      probedAt: null,
      available: {
        parallax: false,
        coldstart: false,
        "hollow-test": false,
        "behavior-diff": false,
        preflight: false,
        "skill-mining": false,
      },
    },
  };
}

export function loadState(dotdir) {
  const p = path.join(dotdir, "state.json");
  if (!fs.existsSync(p)) return { state: null, existed: false };
  let raw;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    throw new OpError(`Cannot read state file at ${p}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpError(
      `Corrupt state file at ${p} — repair it by hand or delete .dobetter/state.json to start fresh (artifacts are kept).`,
    );
  }
  if (parsed.version !== STATE_VERSION) {
    throw new OpError(
      `Unsupported state.json version ${JSON.stringify(parsed.version)} at ${p} (this build expects ${STATE_VERSION}). ` +
        `Delete .dobetter/state.json to re-initialize (artifacts are kept).`,
    );
  }
  return { state: parsed, existed: true };
}

export function saveState(dotdir, state) {
  writeFileAtomic(path.join(dotdir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function assertPhase(phase) {
  if (!PHASES.includes(phase)) throw new OpError(`Unknown phase: ${JSON.stringify(phase)}`);
}

export function beginRun(state, { command, provider = null, headSha = null, now = nowIso() } = {}) {
  const s = clone(state);
  const base = `run-${String(now).slice(0, 19).replace(/:/g, "-")}`;
  let id = base;
  let n = 2;
  while (s.runs.some((r) => r.id === id)) id = `${base}-${n++}`;
  s.runs.push({
    id,
    command,
    provider,
    startedAt: now,
    finishedAt: null,
    headSha,
    ok: null,
    spendUSD: 0,
  });
  while (s.runs.length > MAX_RUNS) s.runs.shift();
  return { state: s, runId: id };
}

export function finishRun(state, runId, { now = nowIso(), ok } = {}) {
  const s = clone(state);
  const run = s.runs.find((r) => r.id === runId);
  if (!run) throw new OpError(`Unknown run id: ${runId}`);
  const otherSpend = s.runs
    .filter((r) => r.id !== runId)
    .reduce((acc, r) => acc + (r.spendUSD || 0), 0);
  run.finishedAt = now;
  run.ok = ok === true;
  run.spendUSD = round6(Math.max(0, s.budget.spentUSD - otherSpend));
  return s;
}

export function recordPhase(state, phase, { status, sha = null, now = nowIso(), facts } = {}) {
  assertPhase(phase);
  if (!["done", "failed", "stale"].includes(status)) {
    throw new OpError(`Invalid phase status: ${JSON.stringify(status)} (expected done|failed|stale)`);
  }
  const s = clone(state);
  const p = s.phases[phase];
  p.status = status;
  if (status === "done") p.completedAt = now;
  if (sha != null) p.sha = sha;
  if (status === "done" && sha != null) s.target.headSha = sha;
  if (phase === "scan" && facts !== undefined) p.facts = facts;
  return s;
}

export function addSpend(state, phase, { calls = 0, tokensIn = 0, tokensOut = 0, costUSD = 0 } = {}) {
  assertPhase(phase);
  const s = clone(state);
  const sp = s.phases[phase].spend;
  sp.calls += Number(calls) || 0;
  sp.tokensIn += Number(tokensIn) || 0;
  sp.tokensOut += Number(tokensOut) || 0;
  sp.costUSD += Number(costUSD) || 0;
  s.budget.spentUSD += Number(costUSD) || 0;
  return s;
}

export function setGate(state, gateName, patch) {
  if (!state.gates || !(gateName in state.gates)) {
    throw new OpError(`Unknown gate: ${JSON.stringify(gateName)}`);
  }
  const s = clone(state);
  Object.assign(s.gates[gateName], patch);
  return s;
}

export function pinSha(state, phase, sha) {
  assertPhase(phase);
  const s = clone(state);
  s.pins[phase] = sha;
  return s;
}

export function nextFindingId(state, dimensionId) {
  if (typeof dimensionId !== "string" || dimensionId.length === 0) {
    throw new OpError(`Invalid dimension id: ${JSON.stringify(dimensionId)}`);
  }
  const s = clone(state);
  const current = s.counters.findings[dimensionId] ?? 0;
  const n = current + 1;
  s.counters.findings[dimensionId] = n;
  const abbr = dimensionId.replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "GEN";
  const id = `F-${abbr}-${String(n).padStart(4, "0")}`;
  return { state: s, id };
}

export function recordRoadmapHash(state, { sha256, headSha = null, now = nowIso() } = {}) {
  const s = clone(state);
  const last = s.roadmapHistory[s.roadmapHistory.length - 1];
  if (last && last.sha256 === sha256) return s; // dedupe consecutive
  s.roadmapHistory.push({ sha256, headSha, generatedAt: now });
  return s;
}

export function remainingBudgetUSD(state) {
  const limit = state.budget?.limitUSD;
  if (limit === null || limit === undefined) return null;
  return round6(limit - (state.budget.spentUSD || 0));
}

// Resume pointer for `do-better run` (D8/D9). Single source of truth.
// A phase is complete when status === "done" AND its gate (if any) passed /
// approved; charter complete ⇔ gates.charter.approved; roadmap complete ⇔
// gates.roadmap.approved && gates.roadmap.coldstartClean.
const RUN_ORDER = ["scan", "charter", "comprehend", "identify", "roadmap", "rail"];

function phaseComplete(state, phase) {
  const done = state.phases[phase]?.status === "done";
  switch (phase) {
    case "scan":
      return done;
    case "charter":
      return state.gates.charter.approved === true;
    case "comprehend":
      return done && state.gates.comprehend.passed === true;
    case "identify":
      return done && state.gates.identify.passed === true;
    case "roadmap":
      return state.gates.roadmap.approved === true && state.gates.roadmap.coldstartClean === true;
    case "rail":
      return done && state.gates.rail.passed === true;
    default:
      return false;
  }
}

export function nextIncompletePhase(state) {
  for (const phase of RUN_ORDER) {
    if (!phaseComplete(state, phase)) return phase;
  }
  return null;
}
