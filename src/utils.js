// src/utils.js — shared utilities: argv parsing, logging, error classes,
// git/exec helpers, guards. Zero runtime dependencies (node builtins only).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Colors + logging (skill-mining style: raw ANSI fns, disabled when not a TTY)
// ---------------------------------------------------------------------------

const colorEnabled = !process.env.NO_COLOR && process.stdout.isTTY === true;
const wrap = (open, close) => (s) =>
  colorEnabled ? `[${open}m${s}[${close}m` : String(s);

export const colors = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  magenta: wrap(35, 39),
};

export const log = {
  info: (m) => console.log(`${colors.blue("ℹ")} ${m}`),
  success: (m) => console.log(`${colors.green("✔")} ${m}`),
  warn: (m) => console.error(`${colors.yellow("⚠")} ${m}`),
  error: (m) => console.error(`${colors.red("✖")} ${m}`),
  phase: (id, name) => console.log(colors.bold(colors.cyan(`\n=== ${id}: ${name} ===`))),
  gate: (name, human) =>
    console.log(colors.bold(colors.magenta(`\n=== ⟂ Gate: ${name}${human ? " (HUMAN)" : ""} ===`))),
  step: (m) => console.log(`  ${m}`),
  substep: (m) => console.log(colors.dim(`    ${m}`)),
  errorTrace: (err) => console.error(colors.dim(String((err && err.stack) || err))),
};

// ---------------------------------------------------------------------------
// Error classes (exit-code contract: 0 success/human pause, 1 operational,
// 2 deterministic gate failure)
// ---------------------------------------------------------------------------

export class OpError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpError";
    this.exitCode = 1;
  }
}

export class BudgetError extends OpError {
  constructor(message) {
    super(message);
    this.name = "BudgetError";
  }
}

export class OfflineError extends OpError {
  constructor(message) {
    super(message);
    this.name = "OfflineError";
  }
}

export class GateError extends Error {
  constructor(gate, detail) {
    super(`Gate failed: ${gate} — ${detail}`);
    this.name = "GateError";
    this.exitCode = 2;
    this.gate = gate;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Commands + fixed taxonomy floor (D5 — order is canonical)
// ---------------------------------------------------------------------------

export const COMMANDS = new Set(["scan", "charter", "audit", "roadmap", "rail", "run", "refresh"]);

export const TAXONOMY = [
  { id: "correctness", label: "Correctness risk" },
  { id: "security", label: "Security" },
  { id: "maintainability", label: "Maintainability / debt" },
  { id: "performance", label: "Performance" },
  { id: "operability", label: "Operability" },
  { id: "test-quality", label: "Test quality" },
  { id: "dependency-health", label: "Dependency health" },
  { id: "dx", label: "Developer experience" },
];

// ---------------------------------------------------------------------------
// Argv parsing — hand-rolled, supports `--flag value` and `--flag=value`;
// warns on unknown flags, never dies. First positional consumed as command
// iff ∈ COMMANDS; second positional → flags.target.
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Map([
  ["--provider", "provider"],
  ["--budget", "budget"],
  ["--target", "target"],
  ["--model-cheap", "modelCheap"],
  ["--model-mid", "modelMid"],
  ["--model-frontier", "modelFrontier"],
  ["--n", "n"],
  ["--threshold", "threshold"],
]);

const BOOL_FLAGS = new Map([
  ["--offline", "offline"],
  ["--approve", "approve"],
  ["--yes", "yes"],
  ["--json", "json"],
  ["--help", "help"],
  ["-h", "help"],
]);

function coerceFlagValue(name, value) {
  if (name === "--budget") {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new OpError(`Invalid --budget: "${value}" (expected a positive number of USD)`);
    return n;
  }
  if (name === "--n") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new OpError(`Invalid --n: "${value}" (expected a positive integer)`);
    return n;
  }
  if (name === "--threshold") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new OpError(`Invalid --threshold: "${value}" (expected a non-negative number)`);
    return n;
  }
  return value;
}

export function parseArgs(argv) {
  const flags = {
    command: null,
    target: ".",
    provider: null,
    budget: null,
    offline: false,
    modelCheap: null,
    modelMid: null,
    modelFrontier: null,
    n: null,
    threshold: null,
    approve: false,
    yes: false,
    json: false,
    help: false,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    let name = arg;
    let value = null;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      name = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    if (BOOL_FLAGS.has(name)) {
      flags[BOOL_FLAGS.get(name)] = true;
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (value === null) {
        value = argv[i + 1];
        if (value === undefined) throw new OpError(`Missing value for ${name}`);
        i++;
      }
      flags[VALUE_FLAGS.get(name)] = coerceFlagValue(name, value);
      continue;
    }
    log.warn(`Unknown flag ignored: ${arg}`);
  }

  if (positionals.length > 0) {
    if (COMMANDS.has(positionals[0])) {
      flags.command = positionals[0];
      if (positionals[1] !== undefined) flags.target = positionals[1];
      for (const extra of positionals.slice(2)) log.warn(`Extra positional ignored: ${extra}`);
    } else {
      flags.target = positionals[0];
      for (const extra of positionals.slice(1)) log.warn(`Extra positional ignored: ${extra}`);
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export const HELP_TEXT = `
${colors.bold("do-better")} — brownfield codebase analysis → verified findings → technical roadmap

${colors.bold("USAGE")}
  do-better <command> [target] [flags]

${colors.bold("COMMANDS")}
  scan       D-1  Cheap repo scan: facts, incantations, draft codemap
  charter    D0   Stakeholder interview → quality charter   [HUMAN GATE 1]
  audit      D1+2 Comprehend (7 artifacts) + identify verified findings
  roadmap    D3   Score, sequence, phase → ROADMAP.md + backlog tickets [HUMAN GATE 2]
  rail       D4   Characterization rails + hollow-test audit
  run        Full pipeline; stops cleanly at human gates; resumable
  refresh    Idempotent re-run: stale-claim flagging, behavior diff

${colors.bold("FLAGS")}
  --provider <anthropic|gemini|openai|local>   LLM provider (default: autodetect, anthropic-first;
                                         local = OpenAI-compatible endpoint via DOBETTER_LOCAL_BASE_URL)
  --budget <usd>                         Hard spend cap; resumable when exceeded
  --offline                              No LLM calls; static analysis + structure-only artifacts
  --model-cheap|--model-mid|--model-frontier <id>   Per-tier model overrides
  --target <dir>                         Target repo (or 2nd positional; default ".")
  --approve                              Approve charter/roadmap (human gates)
  --n <int>                              Parallax fan width override (audit)
  --threshold <num>                      Divergence threshold override (audit)
  --yes                                  Skip confirmations
  --json                                 Machine summary on stdout
  -h, --help                             Show this help

${colors.bold("ENVIRONMENT")}
  ANTHROPIC_API_KEY | GEMINI_API_KEY | OPENAI_API_KEY    provider keys (autodetected in that order)
  DOBETTER_LOCAL_BASE_URL      OpenAI-compatible endpoint for --provider local (e.g. http://localhost:11434/v1)
  DOBETTER_LOCAL_MODEL         default model for --provider local (per-tier --model-* flags override)
  DOBETTER_LOCAL_API_KEY       optional bearer token for --provider local
  DOBETTER_ADLC_DIR            path to an aidlc checkout (parallax, coldstart, hollow-test, …)
  DOBETTER_SKILL_MINING_DIR    path to a skill-mining checkout
  DOBETTER_ANSWERS             path to JSON string[] of scripted charter answers
  DOBETTER_FAKE_LLM            path to a fake-LLM module (test seam; no network)
  DOBETTER_DEBUG               print stack traces on error

${colors.bold("EXIT CODES")}
  0   success, or a clean human-gate pause with printed resume instructions
  1   operational error (bad input, missing provider, network, budget exceeded)
  2   deterministic gate failure (divergence, unverified findings, coldstart gaps,
      rails red, hollow audit survivor)
`;

// ---------------------------------------------------------------------------
// Crypto / time
// ---------------------------------------------------------------------------

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Guards (validate external input: argv, LLM-emitted paths/model names)
// ---------------------------------------------------------------------------

export function assertSafeModelName(name, flagLabel) {
  if (typeof name !== "string" || !/^[\w.:/-]+$/.test(name)) {
    throw new OpError(`Invalid model name for ${flagLabel}: ${JSON.stringify(name)} (allowed: letters, digits, ., :, /, -, _)`);
  }
}

export function isSafeRelPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\0")) return false;
  if (path.isAbsolute(p) || p.startsWith("/") || p.startsWith("\\")) return false;
  if (p.split(/[\\/]/).includes("..")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Exec / git
// ---------------------------------------------------------------------------

export function makeExec() {
  return (cmd, args, opts = {}) => {
    let r;
    try {
      r = spawnSync(cmd, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        shell: false,
        ...opts,
      });
    } catch (e) {
      return { status: -1, stdout: "", stderr: String(e && e.message ? e.message : e) };
    }
    return {
      status: typeof r.status === "number" ? r.status : -1,
      stdout: r.stdout ?? "",
      stderr: r.error ? String(r.error.message) : r.stderr ?? "",
    };
  };
}

export function git(root, args, exec = makeExec()) {
  const r = exec("git", args, { cwd: root });
  if (r.status !== 0) {
    throw new OpError(`git ${args.join(" ")} failed in ${root}: ${(r.stderr || r.stdout || "unknown error").trim()}`);
  }
  return (r.stdout ?? "").trim();
}

export function gitHeadSha(root, exec = makeExec()) {
  return git(root, ["rev-parse", "HEAD"], exec);
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function readJsonSafe(absPath) {
  if (!fs.existsSync(absPath)) return null;
  const raw = fs.readFileSync(absPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new OpError(`Unparseable JSON at ${absPath}: ${e.message}`);
  }
}

export function writeFileAtomic(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmp = `${absPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, absPath);
}

export function truncate(text, maxChars) {
  const s = String(text);
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

// Resolve a file relative to THIS package's root (not the target repo) — used
// to load do-better/SKILL.md and do-better/references/*.md as prompt sources.
export function readPackageFile(relPath) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const abs = path.join(packageRoot, relPath);
  if (!fs.existsSync(abs)) throw new OpError(`Missing package file: ${relPath} (looked in ${packageRoot})`);
  return fs.readFileSync(abs, "utf8");
}
