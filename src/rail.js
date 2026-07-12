// src/rail.js — D4: preflight env check, characterization rails for Phase-Now
// behaviors, hollow-test audit gate, rails/manifest.md. See SPEC §2 (D4/D7),
// blueprint §7 D4.
import fs from "node:fs";
import path from "node:path";
import {
  OpError, gateError, gitHeadSha, git, readJsonSafe, readPackageFile, writeFileAtomic, sha256Hex,
} from "./utils.js";
import { recordPhase, addSpend, setGate, pinSha, recordRoadmapHash } from "./state.js";
import {
  LAYOUT, ensureLayout, readArtifact, writeArtifact, parseCitations,
  readTickets, writeTickets, validateTicket,
} from "./artifacts.js";
import { withFallback } from "./llm.js";
import { runPreflight, runHollowTest, runColdstart } from "./adlc.js";

export const PHASE_ID = "rail";
const FIX_ROUNDS = 2;
const SPOT_CHECK_COUNT = 3;
const RUNNABILITY_TITLE = "Make the environment runnable";
const HANDOFF_LINE = "Each ticket in .dobetter/backlog/ is ready for ADLC P3/P4 intake.";

// ---------- pure helpers ----------

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(pattern, file) {
  if (globToRegExp(pattern).test(file)) return true;
  if (!pattern.includes("/")) return globToRegExp(pattern).test(file.split("/").pop());
  return false;
}

export function parseBehaviorInventory(body) {
  const out = [];
  for (const line of String(body ?? "").split("\n")) {
    if (!/^\s*[-*]\s/.test(line)) continue;
    const m = line.match(/\b(B-\d{3,})\b/);
    if (!m) continue;
    const citations = parseCitations(line);
    out.push({
      id: m[1],
      summary: line.replace(/^\s*[-*]\s*/, "").trim(),
      entry: citations[0] ?? null,
      files: [...new Set(citations.map((c) => c.file))],
    });
  }
  return out;
}

export function mapBehaviorsToTickets(behaviors, tickets) {
  return behaviors.map((b) => {
    const files = b.files ?? (b.entry ? [b.entry.file] : b.file ? [b.file] : []);
    const ticketIds = tickets
      .filter((t) => (t.scope ?? []).some((g) => files.some((f) => globMatch(g, f))))
      .map((t) => t.id);
    return { behaviorId: b.id, ticketIds };
  });
}

export function basicEnvProbe(root, exec) {
  const checks = [];
  const tryExec = (cmd, args, opts) => {
    try { return exec(cmd, args, opts); } catch { return { status: 1, stdout: "", stderr: "exec failed" }; }
  };
  const gitVersion = tryExec("git", ["--version"], {});
  checks.push({ name: "git-present", status: gitVersion.status === 0 ? "pass" : "fail", detail: gitVersion.stdout.trim() || gitVersion.stderr.trim() });
  const inRepo = tryExec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
  checks.push({ name: "git-repo", status: inRepo.status === 0 ? "pass" : "fail", detail: root });
  const porcelain = tryExec("git", ["status", "--porcelain"], { cwd: root });
  const clean = porcelain.status === 0 && porcelain.stdout.trim() === "";
  checks.push({ name: "repo-clean", status: clean ? "pass" : "warn", detail: clean ? "" : "uncommitted changes present" });
  let writable = true; let detail = "";
  try {
    const tmpDir = path.join(root, ".dobetter", "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const probe = path.join(tmpDir, `probe-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe);
  } catch (err) { writable = false; detail = err.message; }
  checks.push({ name: "write-test", status: writable ? "pass" : "fail", detail });
  return { checks, verdict: checks.some((c) => c.status === "fail") ? "fail" : "pass" };
}

function detectTestCmd(root) {
  const pkg = readJsonSafe(path.join(root, "package.json"));
  return pkg?.scripts?.test ? "npm test" : "node --test";
}

function detectRailsDir(root) {
  for (const d of ["test", "tests", "spec"]) {
    if (fs.existsSync(path.join(root, d))) return path.posix.join(d, "dobetter-rails");
  }
  return path.posix.join("test", "dobetter-rails");
}

function refText(rel) {
  try { return readPackageFile(`do-better/references/${rel}`); } catch { return ""; }
}

function stripFences(text) {
  let s = String(text ?? "").trim();
  const m = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```\s*$/);
  if (m) s = m[1];
  return s;
}

function gateFail(state, gate, detail) {
  return gateError(gate, detail, state); // H15 — shared, well-formed message
}

function patchPhase(state, patch) {
  return { ...state, phases: { ...state.phases, [PHASE_ID]: { ...state.phases[PHASE_ID], ...patch } } };
}

// ---------- preflight red → Phase-0 injection (D7) ----------

function insertPhase0Item(body, line) {
  if (body.includes(RUNNABILITY_TITLE)) return body;
  const lines = body.split("\n");
  const idx = lines.findIndex((l) => /^## Phase 0/.test(l));
  if (idx === -1) return `## Phase 0 — Rails & runnability\n\n${line}\n\n${body}`;
  // drop a "_None._" placeholder directly under the heading
  let insertAt = idx + 1;
  while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
  if (lines[insertAt]?.trim() === "_None._") lines.splice(insertAt, 1);
  lines.splice(idx + 1, 0, "", line);
  return lines.join("\n");
}

function runnabilityTicket(id, preState) {
  const failed = (preState.failedNames ?? preState.checks?.filter((c) => c.status === "fail").map((c) => c.name) ?? []).join(", ");
  return {
    id,
    title: RUNNABILITY_TITLE,
    body: [
      "## Motivation",
      `The environment preflight check is red (failed: ${failed || "unknown"}); no characterization rails can be authored or run until the repo is runnable (SPEC D7).`,
      "",
      "## Acceptance Criteria",
      "- [ ] `do-better rail` preflight reports verdict pass — verification: a command whose output is asserted (preflight exit code 0).",
      "- [ ] The project test command runs to completion — verification: a command whose output is asserted.",
      "",
      "## Partition hints",
      "- Environment/bootstrap work only; no behavior changes.",
    ].join("\n"),
    scope: ["package.json"],
    rails: [],
    edges: [],
    duration: 4,
    category: "operability",
  };
}

async function injectRunnabilityItem(ctx, state, preState, headSha) {
  const { dotdir, log } = ctx;
  const roadmap = readArtifact(dotdir, LAYOUT.roadmap)
    ?? { meta: { generatedAt: ctx.now(), headSha, approved: false }, body: "# Technical Roadmap\n\n## Phase 0 — Rails & runnability\n\n_None._\n" };
  const already = roadmap.body.includes(RUNNABILITY_TITLE);
  const line = `- **${RUNNABILITY_TITLE}** — preflight red; injected by \`do-better rail\` (D7). Risk of inaction: no behavior can be pinned or safely changed.`;
  if (!already) {
    const body = insertPhase0Item(roadmap.body, line);
    writeArtifact(dotdir, LAYOUT.roadmap, { meta: roadmap.meta, body });
    const raw = fs.readFileSync(path.join(dotdir, LAYOUT.roadmap), "utf8");
    state = recordRoadmapHash(state, { sha256: sha256Hex(raw), headSha, now: ctx.now() });
  }
  const tickets = readTickets(dotdir);
  if (!tickets.some((t) => t.title === RUNNABILITY_TITLE)) {
    const counter = (state.counters?.tickets ?? 0) + 1;
    const ticket = runnabilityTicket(`T${counter}`, preState);
    const errs = validateTicket(ticket, [...tickets.map((t) => t.id), ticket.id]);
    if (errs.length) log.warn(`Runnability ticket lint: ${errs.join("; ")}`);
    writeTickets(dotdir, [...tickets, ticket]);
    state = { ...state, counters: { ...state.counters, tickets: counter } };
    // re-test coldstart on just this ticket (declared degradation when absent)
    const cs = runColdstart(ctx.adlc, {
      ticketsPath: path.join(dotdir, LAYOUT.backlogJson),
      all: false, ticketId: ticket.id, cwd: ctx.root, exec: ctx.exec,
    });
    if (cs.skipped) log.warn("coldstart unavailable — runnability ticket not cold-start tested (declared degradation).");
    else if (cs.results?.some((r) => r.pass === false)) log.warn(`Runnability ticket has coldstart gaps: ${JSON.stringify(cs.results)}`);
  }
  return state;
}

// ---------- rail authoring + auditing ----------

async function authorRail(ctx, behavior, template, railsDirRel) {
  const prompt = [
    "Author ONE boundary-level characterization rail (golden-master/approval style) for this behavior.",
    "Pin CURRENT actual behavior, even if it looks like a bug (bug-compatible pinning) — comment such",
    "assertions with `// pinned current behavior, possibly a bug`. Use node:test + node:assert/strict.",
    `The file will be written to ${railsDirRel}/${behavior.id}.rail.test.js inside the target repo —`,
    "use relative imports from that location. Return ONLY the JavaScript file content.",
    "Behavior inventory entry (your ONLY view of the system — do not invent internals):",
    behavior.summary,
    behavior.entry ? `Entry point: ${behavior.entry.file}:${behavior.entry.line}` : "",
  ].join("\n");
  const raw = await withFallback(
    ctx.llm,
    { prompt, system: template, tier: "mid", label: `rail:${behavior.id}` },
    () => null,
  );
  if (!raw) return null;
  const content = stripFences(raw).trim();
  if (!content || !/test/.test(content)) return null;
  return `${content}\n`;
}

function runRail(ctx, relFile) {
  // Scrub test-runner context vars: an inherited NODE_TEST_CONTEXT makes the child
  // `node --test` report to a parent runner and exit 0 even when rails are red.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  return ctx.exec(process.execPath, ["--test", relFile], { cwd: ctx.root, timeout: 120000, env });
}

async function greenLoop(ctx, behavior, relFile) {
  const abs = path.join(ctx.root, relFile);
  let res = runRail(ctx, relFile);
  for (let round = 1; res.status !== 0 && round <= FIX_ROUNDS; round++) {
    const fixed = await withFallback(ctx.llm, {
      prompt: [
        `This characterization rail is red against CURRENT code. Fix the rail (never the code) so it`,
        "pins current actual behavior. Return ONLY the corrected JavaScript file content.",
        `Rail file (${relFile}):`, fs.readFileSync(abs, "utf8"),
        "Failure output:", `${res.stdout}\n${res.stderr}`.slice(0, 8000),
      ].join("\n"),
      tier: "mid",
      label: "rail-fix",
    }, () => null);
    if (!fixed) break;
    const content = stripFences(fixed).trim();
    if (!content) break;
    writeFileAtomic(abs, `${content}\n`);
    res = runRail(ctx, relFile);
  }
  return res.status === 0;
}

function implicatedRows(mutants, rows) {
  const survivors = (mutants ?? []).filter((m) => m && (m.survived === true || m.status === "survived"));
  return rows.filter((row) => survivors.some((m) => {
    const f = String(m.file ?? "");
    return f && (f === row.file || f.endsWith(`/${path.posix.basename(row.file)}`) || row.file.endsWith(`/${path.posix.basename(f)}`));
  }));
}

function spotCheckRow(ctx, row, behavior) {
  const cit = behavior?.entry;
  if (!cit) return { vacuous: false, audit: "spot-check skipped (no citation)" };
  const abs = path.join(ctx.root, cit.file);
  let original;
  try { original = fs.readFileSync(abs, "utf8"); } catch { return { vacuous: false, audit: "spot-check skipped (cited file unreadable)" }; }
  const lines = original.split("\n");
  if (cit.line < 1 || cit.line > lines.length) return { vacuous: false, audit: "spot-check skipped (citation out of range)" };
  lines[cit.line - 1] = `// dobetter spot-check: ${lines[cit.line - 1]}`;
  try {
    fs.writeFileSync(abs, lines.join("\n"));
    const res = runRail(ctx, row.file);
    return res.status === 0
      ? { vacuous: true, audit: "spot-check: VACUOUS (stayed green with entry deleted)" }
      : { vacuous: false, audit: "spot-check: ok (went red with entry deleted)" };
  } finally {
    fs.writeFileSync(abs, original);
  }
}

function writeManifest(ctx, { rows, gaps, headSha, degradation }) {
  const lines = [
    "# Characterization Rails Manifest", "",
    "Rails are FROZEN once written (ADLC P3 doctrine, F5): they may be deleted with",
    "a recorded reason, never weakened. Rail paths are appended to backlog tickets'",
    "`rails` arrays so the ADLC rails-guard freezes them mechanically.", "",
    "| behavior | rail file | style | pinned-at | audit | frozen |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.behaviorId} | ${r.file} | ${r.style} | ${String(r.pinnedAt).slice(0, 7)} | ${r.audit} | yes |`),
    "",
    "## Gaps", "",
    ...(gaps.length ? gaps.map((g) => `- ${g.behaviorId}: ${g.reason}`) : ["_None._"]),
    "",
    ...(degradation ? [`> Degradation: ${degradation}`, ""] : []),
  ];
  writeArtifact(ctx.dotdir, LAYOUT.railsManifest, {
    meta: { generatedAt: ctx.now(), headSha },
    body: lines.join("\n"),
  });
}

function updateRailsMap(ctx, mapping, rows, gaps) {
  const art = readArtifact(ctx.dotdir, LAYOUT.comprehension.railsMap);
  if (!art) return;
  const marker = "## Rail coverage (do-better D4)";
  const section = [
    marker, "",
    ...mapping.map((m) => {
      const row = rows.find((r) => r.behaviorId === m.behaviorId);
      const gap = gaps.find((g) => g.behaviorId === m.behaviorId);
      const status = row ? `railed (${row.file})` : gap ? `GAP — ${gap.reason}` : m.ticketIds.length ? "GAP — pending" : "out of roadmap scope (no Now/Next ticket touches it)";
      return `- ${m.behaviorId}: ${status}`;
    }),
    "",
  ].join("\n");
  const base = art.body.includes(marker) ? art.body.slice(0, art.body.indexOf(marker)).replace(/\n+$/, "\n") : `${art.body.replace(/\n+$/, "")}\n`;
  writeArtifact(ctx.dotdir, LAYOUT.comprehension.railsMap, { meta: art.meta, body: `${base}\n${section}` });
}

function finishState(state, ctx, { headSha, status, railsAuthored, behaviorsCovered, behaviorsGapped }) {
  let next = addSpend(state, PHASE_ID, ctx.llm.drainSpend());
  next = recordPhase(next, PHASE_ID, { status, sha: headSha, now: ctx.now() });
  next = patchPhase(next, { railsAuthored, behaviorsCovered, behaviorsGapped });
  if (status === "done") next = pinSha(next, PHASE_ID, headSha);
  return next;
}

// ---------- phase entrypoint ----------

export async function run(ctx) {
  const { root, dotdir, log, flags } = ctx;
  let state = ctx.state;
  const gate = state?.gates?.roadmap;
  if (!gate?.approved || !gate?.coldstartClean) {
    throw new OpError("Roadmap is not approved — run `do-better roadmap` and `do-better roadmap --approve` first.");
  }
  ensureLayout(dotdir);
  const headSha = gitHeadSha(root, ctx.exec);
  const testCmd = detectTestCmd(root);

  // 2. preflight env check FIRST (red does not exit 2 — it becomes a Phase-0 item, D7)
  let preState;
  const pf = runPreflight(ctx.adlc, { testCmd, cwd: root, exec: ctx.exec });
  if (pf.skipped) {
    const probe = basicEnvProbe(root, ctx.exec);
    preState = { degraded: "basic-probe", verdict: probe.verdict, checks: probe.checks, failedNames: probe.checks.filter((c) => c.status === "fail").map((c) => c.name) };
  } else {
    preState = { degraded: null, verdict: pf.ok ? "pass" : "fail", checks: pf.checks, failedNames: pf.failedNames };
  }
  if (preState.verdict !== "pass") {
    state = await injectRunnabilityItem(ctx, state, preState, headSha);
    writeManifest(ctx, {
      rows: [],
      gaps: [{ behaviorId: "*", reason: `environment not runnable — preflight red (${(preState.failedNames ?? []).join(", ") || "see checks"}); "${RUNNABILITY_TITLE}" added to Phase 0` }],
      headSha,
      degradation: preState.degraded ? `preflight degraded to ${preState.degraded}` : null,
    });
    state = setGate(state, "rail", { passed: false, railsGreen: false, hollowAudited: false, hollowSurvivors: 0, preflight: preState });
    state = finishState(state, ctx, { headSha, status: "done", railsAuthored: 0, behaviorsCovered: 0, behaviorsGapped: 0 });
    return {
      state,
      gate: { name: "rail-preflight", passed: false, human: false, detail: `Environment not runnable — "${RUNNABILITY_TITLE}" injected as a Phase 0 roadmap item. Fix it, then re-run \`do-better rail\`.` },
      summary: `Preflight red (${(preState.failedNames ?? []).join(", ") || "env checks failed"}). "${RUNNABILITY_TITLE}" added to ROADMAP Phase 0 and backlog; rails scoped to nothing runnable.`,
    };
  }

  // 3. roadmap-scoped targets (D7)
  const inv = readArtifact(dotdir, LAYOUT.comprehension.behaviorInventory);
  if (!inv) throw new OpError("behavior-inventory.md missing — run `do-better audit` first.");
  const behaviors = parseBehaviorInventory(inv.body);
  const tickets = readTickets(dotdir);
  const mapping = mapBehaviorsToTickets(behaviors, tickets);
  const targetIds = new Set(mapping.filter((m) => m.ticketIds.length).map((m) => m.behaviorId));
  const targets = behaviors.filter((b) => targetIds.has(b.id));
  const railsDirRel = detectRailsDir(root);
  const template = refText("templates/rail-template.md");

  // 4-5. author rails (fresh context, mid tier) + rails-green gate with fix loop
  let rows = [];
  const gaps = [];
  for (const behavior of targets) {
    const content = await authorRail(ctx, behavior, template, railsDirRel);
    if (!content) {
      gaps.push({ behaviorId: behavior.id, reason: ctx.llm.offline ? "rail not authored (offline)" : "rail not authored (empty draft)" });
      continue;
    }
    const relFile = path.posix.join(railsDirRel, `${behavior.id}.rail.test.js`);
    writeFileAtomic(path.join(root, relFile), content);
    const green = await greenLoop(ctx, behavior, relFile);
    if (!green) {
      fs.rmSync(path.join(root, relFile), { force: true });
      gaps.push({ behaviorId: behavior.id, reason: `could not pin — rail red after ${FIX_ROUNDS} fix rounds (deleted, fail closed)` });
      continue;
    }
    rows.push({ behaviorId: behavior.id, file: relFile, style: "boundary golden-master", pinnedAt: headSha, audit: "pending" });
  }
  if (targets.length && !rows.length) {
    writeManifest(ctx, { rows, gaps, headSha, degradation: null });
    state = finishState(state, ctx, { headSha, status: "failed", railsAuthored: 0, behaviorsCovered: 0, behaviorsGapped: gaps.length });
    throw gateFail(state, "rail", `no green rails could be authored for ${targets.length} target behaviors`);
  }

  // 6. commit boundary — only with --yes or interactive confirmation; else rails stay staged
  if (rows.length) {
    git(root, ["add", ...rows.map((r) => r.file)], ctx.exec);
    let doCommit = Boolean(flags?.yes);
    if (!doCommit && ctx.ask) {
      doCommit = /^y/i.test((await ctx.ask("Commit characterization rails now? [y/N] ")).trim());
    }
    if (doCommit) git(root, ["commit", "-m", "test: add do-better characterization rails"], ctx.exec);
  }

  // 7. hollow-test audit (or 7b native deletion spot-check when absent)
  let hollowAudited = false;
  let hollowSurvivors = 0;
  let degradation = null;
  const base = state.pins?.roadmap ?? headSha;
  const deleteRow = (row, reason) => {
    fs.rmSync(path.join(root, row.file), { force: true });
    rows = rows.filter((r) => r !== row);
    gaps.push({ behaviorId: row.behaviorId, reason });
  };
  // A hollow-test run that errored (exit 1 / unparseable --json output) produced
  // no mutants: it is NOT an audit. Treat it like absence — degrade to the
  // mandatory native deletion spot-check with a declared degradation. Never
  // record "hollow: killed 0/0" for a run that demonstrably did not run (D4/F5).
  const hollowUsable = (r) => !r.skipped && !r.opError;
  if (rows.length) {
    let ht = runHollowTest(ctx.adlc, { testCmd: `node --test ${railsDirRel}`, base, max: 20, cwd: root, exec: ctx.exec });
    if (hollowUsable(ht)) {
      hollowAudited = true;
      if ((ht.summary?.survived ?? 0) > 0) {
        const implicated = implicatedRows(ht.mutants, rows);
        if (!implicated.length) {
          state = finishState(state, ctx, { headSha, status: "failed", railsAuthored: rows.length, behaviorsCovered: rows.length, behaviorsGapped: gaps.length });
          throw gateFail(state, "rail", `hollow-test reported ${ht.summary.survived} survivors that could not be mapped to rails (fail closed)`);
        }
        for (const row of implicated) {
          // one explicit rail-fix round: strengthen the vacuous assertions, then re-verify green
          const abs = path.join(root, row.file);
          const fixed = await withFallback(ctx.llm, {
            prompt: [
              "A hollow-test mutant of this rail SURVIVED — its assertions are vacuous fog.",
              "Strengthen the assertions so any mutation of them turns the rail red, still pinning",
              "current actual behavior. Return ONLY the corrected JavaScript file content.",
              `Rail file (${row.file}):`, fs.readFileSync(abs, "utf8"),
              "Survived mutants:", JSON.stringify(ht.mutants ?? []),
            ].join("\n"),
            tier: "mid",
            label: "rail-fix",
          }, () => null);
          if (fixed) {
            const content = stripFences(fixed).trim();
            if (content) {
              writeFileAtomic(abs, `${content}\n`);
              if (runRail(ctx, row.file).status !== 0) {
                deleteRow(row, "rail red after hollow fix round (deleted, fail closed)");
              }
            }
          }
        }
        if (rows.length) {
          ht = runHollowTest(ctx.adlc, { testCmd: `node --test ${railsDirRel}`, base, max: 20, cwd: root, exec: ctx.exec });
          if (hollowUsable(ht) && (ht.summary?.survived ?? 0) > 0) {
            hollowSurvivors = ht.summary.survived;
            for (const row of implicatedRows(ht.mutants, rows)) {
              deleteRow(row, "hollow-test survivor after fix loop — vacuous assertions (deleted, fail closed)");
            }
          }
        }
      }
      if (hollowUsable(ht)) {
        const k = ht.summary?.killed ?? 0;
        const t = ht.summary?.total ?? 0;
        rows = rows.map((r) => ({ ...r, audit: `hollow: killed ${k}/${t}` }));
      } else {
        // the re-audit after the fix round errored — never claim clean numbers
        rows = rows.map((r) => ({ ...r, audit: "hollow: re-audit failed (operational error)" }));
      }
    } else {
      // 7b. mandatory native deletion spot-check for the top behaviors —
      // applies both when hollow-test is absent and when its run errored.
      degradation = ht.skipped
        ? "hollow-test absent — native deletion spot-check applied to top behaviors"
        : "hollow-test failed to run (operational error) — native deletion spot-check applied to top behaviors";
      const checked = rows.slice(0, SPOT_CHECK_COUNT);
      for (const row of checked) {
        const behavior = targets.find((b) => b.id === row.behaviorId);
        const res = spotCheckRow(ctx, row, behavior);
        if (res.vacuous) deleteRow(row, "vacuous rail — stayed green with cited entry deleted (deleted, fail closed)");
        else row.audit = res.audit;
      }
      const unauditedLabel = ht.skipped ? "unaudited (hollow-test absent)" : "unaudited (hollow-test errored)";
      rows = rows.map((r) => (r.audit === "pending" ? { ...r, audit: unauditedLabel } : r));
    }
  }
  if (targets.length && !rows.length) {
    writeManifest(ctx, { rows, gaps, headSha, degradation });
    state = finishState(state, ctx, { headSha, status: "failed", railsAuthored: 0, behaviorsCovered: 0, behaviorsGapped: gaps.length });
    throw gateFail(state, "rail", "every authored rail failed its audit — no behavior could be pinned");
  }

  // 8. manifest + freeze: rail paths ride along on tickets for ADLC rails-guard (F5)
  writeManifest(ctx, { rows, gaps, headSha, degradation });
  updateRailsMap(ctx, mapping, rows, gaps);
  if (rows.length) {
    const updated = tickets.map((t) => {
      const railPaths = mapping
        .filter((m) => m.ticketIds.includes(t.id))
        .flatMap((m) => rows.filter((r) => r.behaviorId === m.behaviorId).map((r) => r.file));
      return railPaths.length ? { ...t, rails: [...new Set([...(t.rails ?? []), ...railPaths])] } : t;
    });
    writeTickets(dotdir, updated);
  }

  // 9. gate
  state = setGate(state, "rail", {
    passed: true,
    railsGreen: rows.length > 0 || targets.length === 0,
    hollowAudited,
    hollowSurvivors,
    preflight: preState,
  });
  state = finishState(state, ctx, {
    headSha, status: "done",
    railsAuthored: rows.length, behaviorsCovered: rows.length, behaviorsGapped: gaps.length,
  });
  const audit = hollowAudited ? "hollow-test audited" : degradation ?? "no rails to audit";
  return {
    state,
    gate: { name: "rail", passed: true, human: false, detail: `rails green; ${audit}` },
    summary: `${rows.length}/${targets.length} target behaviors pinned (${gaps.length} gaps recorded in rails/manifest.md; ${audit}). ${HANDOFF_LINE}`,
  };
}
