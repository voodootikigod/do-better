#!/usr/bin/env node
// do-better CLI — parse → configure → dispatch → exit codes.
// Exit codes: 0 success or clean human-gate pause; 1 operational error;
// 2 deterministic gate failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GateError,
  HELP_TEXT,
  OpError,
  colors,
  gitHeadSha,
  log,
  stderrLog,
  makeExec,
  nowIso,
  parseArgs,
} from "../src/utils.js";
import {
  beginRun,
  defaultState,
  finishRun,
  loadState,
  nextIncompletePhase,
  saveState,
} from "../src/state.js";

const VERSION = "0.1.0";

// Printed when a human gate pauses the pipeline (D8) and the phase module did
// not supply its own instruction text in gate.detail.
const HUMAN_GATE_INSTRUCTIONS = {
  charter:
    "Charter drafted at .dobetter/charter.md — review/edit, then run: do-better charter --approve",
  roadmap:
    "Roadmap drafted — review .dobetter/ROADMAP.md + backlog/, then run: do-better roadmap --approve",
};

function importPhase(name) {
  return import(new URL(`../src/${name}.js`, import.meta.url));
}

// Machine-readable run stats for the --json envelope (H17): spend and the
// identify verified/killed counts, all already sitting in state at emit time.
function stateStats(state) {
  const identify = state?.phases?.identify ?? {};
  return {
    spendUSD: Number.isFinite(state?.budget?.spentUSD) ? state.budget.spentUSD : 0,
    verified: Number.isInteger(identify.verified) ? identify.verified : null,
    killed: Number.isInteger(identify.killed) ? identify.killed : null,
  };
}

function makeAsk(env) {
  if (env.DOBETTER_ANSWERS) {
    const answersPath = path.resolve(env.DOBETTER_ANSWERS);
    if (!fs.existsSync(answersPath)) {
      throw new OpError(`DOBETTER_ANSWERS file not found: ${answersPath}`);
    }
    let answers;
    try {
      answers = JSON.parse(fs.readFileSync(answersPath, "utf8"));
    } catch (e) {
      throw new OpError(`DOBETTER_ANSWERS is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(answers) || answers.some((a) => typeof a !== "string")) {
      throw new OpError("DOBETTER_ANSWERS must be a JSON array of strings");
    }
    let i = 0;
    // Exhausted answers → empty string (accept the recommendation).
    return { ask: async () => answers[i++] ?? "", close: () => {} };
  }
  if (process.stdin.isTTY) {
    let rl = null;
    const getRl = async () => {
      if (!rl) {
        const { createInterface } = await import("node:readline/promises");
        rl = createInterface({ input: process.stdin, output: process.stdout });
      }
      return rl;
    };
    return {
      ask: async (question) => (await getRl()).question(question),
      close: () => rl?.close(),
    };
  }
  return { ask: null, close: () => {} };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(HELP_TEXT);
    return 0;
  }
  if (!flags.command) {
    if (flags.target !== ".") log.error(`Unknown command: ${flags.target}`);
    console.log(HELP_TEXT);
    return 1;
  }

  const root = path.resolve(flags.target);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new OpError(`Target directory not found: ${root}`);
  }
  const dotdir = path.join(root, ".dobetter");
  const exec = makeExec();

  let headSha = null;
  try {
    headSha = gitHeadSha(root, exec);
  } catch {
    headSha = null; // scan enforces the git-repo requirement with a clear message
  }

  let { state } = loadState(dotdir);
  if (!state) state = defaultState({ headSha, now: nowIso() });

  // Service layers (dynamic so --help / usage errors never need them).
  const { createLLM } = await importPhase("llm");
  const { locateAdlc } = await importPhase("adlc");
  const llm = createLLM({ flags, state, env: process.env });
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const adlc = locateAdlc({ env: process.env, packageRoot, targetRoot: root });
  const { ask, close: closeAsk } = makeAsk(process.env);

  if (!flags.json) console.log(colors.dim(`do-better v${VERSION} · ${flags.command} · ${root}`));

  // Under --json, stdout must carry ONLY the final JSON envelope — route all
  // phase-module progress (ctx.log.phase/step/…) to stderr (H17).
  const activeLog = flags.json ? stderrLog : log;
  let ctx = { root, dotdir, state, llm, adlc, flags, log: activeLog, now: nowIso, exec, ask };
  let runId = null;
  let paused = false;
  let lastSummary = "";

  const runPhase = async (name, fnName = "run") => {
    const mod = await importPhase(name);
    const fn = mod[fnName];
    if (typeof fn !== "function") {
      throw new OpError(`Phase module "${name}" does not export ${fnName}()`);
    }
    const res = await fn(ctx);
    state = res.state;
    ctx = { ...ctx, state };
    saveState(dotdir, state);
    if (res.summary) {
      lastSummary = res.summary;
      if (!flags.json) log.info(res.summary);
    }
    if (res.gate && res.gate.human && !res.gate.passed) {
      paused = true;
      const instructions = res.gate.detail || HUMAN_GATE_INSTRUCTIONS[res.gate.name] || "";
      if (!flags.json && instructions) log.warn(instructions);
    }
    return res;
  };

  try {
    ({ state, runId } = beginRun(state, {
      command: flags.command,
      provider: llm.provider ?? null,
      headSha,
      now: nowIso(),
    }));
    ctx = { ...ctx, state };

    switch (flags.command) {
      case "scan":
        await runPhase("scan");
        break;
      case "charter":
        await runPhase("charter", flags.approve ? "approve" : "run");
        break;
      case "audit":
        await runPhase("comprehend");
        if (!paused) await runPhase("identify");
        break;
      case "roadmap":
        await runPhase("roadmap", flags.approve ? "approve" : "run");
        break;
      case "rail":
        await runPhase("rail");
        break;
      case "refresh":
        await runPhase("refresh");
        break;
      case "run": {
        let next;
        while (!paused && (next = nextIncompletePhase(state)) !== null) {
          await runPhase(next);
          if (paused) break;
          if (nextIncompletePhase(state) === next) {
            throw new OpError(`Phase "${next}" did not complete; cannot continue the pipeline.`);
          }
        }
        if (!paused && nextIncompletePhase(state) === null && !flags.json) {
          log.success(
            "All phases complete. Each ticket in .dobetter/backlog/ is ready for ADLC P3/P4 intake.",
          );
        }
        break;
      }
      default:
        throw new OpError(`Unknown command: ${flags.command}`);
    }

    state = finishRun(state, runId, { now: nowIso(), ok: true });
    saveState(dotdir, state);
    if (flags.json) {
      console.log(JSON.stringify({
        command: flags.command, ok: true, paused, summary: lastSummary,
        artifactsDir: path.relative(process.cwd(), dotdir) || ".dobetter",
        ...stateStats(state),
      }));
    }
    return 0;
  } catch (err) {
    if (err && err.state) state = err.state;
    if (runId) {
      try {
        state = finishRun(state, runId, { now: nowIso(), ok: false });
      } catch {
        /* keep the original error */
      }
    }
    try {
      saveState(dotdir, state);
    } catch {
      /* never mask the original error with a save failure */
    }
    // A CI wrapper gets a parseable failure envelope on stdout (H17); the human
    // message still prints to stderr via the top-level handler. Exit code is set
    // there too, so the two stay consistent.
    if (flags.json) {
      const error = err instanceof GateError
        ? { kind: "gate", gate: err.gate, detail: err.detail }
        : { kind: err instanceof OpError ? "operational" : "error", message: err instanceof Error ? err.message : String(err) };
      console.log(JSON.stringify({ command: flags.command, ok: false, error, ...stateStats(state) }));
    }
    throw err;
  } finally {
    closeAsk();
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof GateError) {
    log.error(`Gate failed: ${err.gate} — ${err.detail}`);
    if (process.env.DOBETTER_DEBUG) log.errorTrace(err);
    process.exitCode = 2;
  } else {
    log.error(err instanceof Error ? err.message : String(err));
    if (process.env.DOBETTER_DEBUG) log.errorTrace(err);
    process.exitCode = typeof err?.exitCode === "number" ? err.exitCode : 1;
  }
}
