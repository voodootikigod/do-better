// src/roadmap.js — D3: score, sequence, phase; ROADMAP.md + backlog tickets;
// coldstart gate; human approval gate 2. See SPEC §2 (D3), blueprint §7 D3.
import fs from "node:fs";
import path from "node:path";
import { OpError, GateError, sha256Hex, gitHeadSha, readPackageFile, truncate } from "./utils.js";
import { recordPhase, addSpend, setGate, pinSha, recordRoadmapHash } from "./state.js";
import {
  LAYOUT, ensureLayout, readArtifact, writeArtifact, readFindings,
  writeTickets, validateTicket, formatCitation, runReproCheck,
} from "./artifacts.js";
import { withFallback } from "./llm.js";
import { runColdstart } from "./adlc.js";

export const PHASE_ID = "roadmap";
export const COLDSTART_FIX_ROUNDS = 2;

const TSHIRT = { S: 1, M: 2, L: 3, XL: 5 };
const SEVERITY_IMPACT = { critical: "XL", high: "L", medium: "M", low: "S" };
const QUICK_WIN_SCORE = 1.5;
const NOW_SCORE = 1.0;
const NEXT_SCORE = 0.5;
const DECLINE_SCORE = 0.3;
const PHASE_ORDER = ["phase0", "now", "next", "later"];
const EFFORT_HOURS = { S: 2, M: 4, L: 8, XL: 16 };
const APPROVE_HINT = "Roadmap drafted — review .dobetter/ROADMAP.md + backlog/, then run: do-better roadmap --approve";

// ---------- pure scoring / sequencing ----------

export function scoreItem({ impact, confidence, effort }) {
  const i = TSHIRT[impact];
  const e = TSHIRT[effort];
  const c = Number(confidence);
  if (!i) throw new OpError(`Invalid impact t-shirt size: ${impact}`);
  if (!e) throw new OpError(`Invalid effort t-shirt size: ${effort}`);
  if (!Number.isFinite(c) || c < 0 || c > 1) throw new OpError(`Invalid confidence: ${confidence}`);
  return (i * c) / e;
}

export function applyCharterWeight(score, dimension, weights) {
  const w = Number(weights?.[dimension]);
  return score * ((Number.isFinite(w) && w > 0 ? w : 3) / 3);
}

// Dependency-ordered, rails-first Phase 0, quick wins front-loaded. Pure —
// returns new item objects with `phase`, `quickWin` and (when a dependency
// cycle had to be broken at this item) `cycleBroken: true`.
export function sequence(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const deps = new Map(items.map((i) => [i.id, (i.dependsOn ?? []).filter((d) => byId.has(d) && d !== i.id)]));
  const broken = new Set();
  const order = [];
  const placed = new Set();
  let remaining = items.map((i) => i.id);
  while (remaining.length) {
    const ready = remaining.filter((id) => deps.get(id).every((d) => placed.has(d)));
    if (!ready.length) {
      const victim = remaining
        .slice()
        .sort((a, b) => (byId.get(a).score - byId.get(b).score) || a.localeCompare(b))[0];
      const unmet = deps.get(victim).filter((d) => !placed.has(d));
      deps.set(victim, deps.get(victim).filter((d) => d !== unmet[0]));
      broken.add(victim);
      continue;
    }
    ready.sort((a, b) => (byId.get(b).score - byId.get(a).score) || a.localeCompare(b));
    for (const id of ready) { placed.add(id); order.push(id); }
    remaining = remaining.filter((id) => !placed.has(id));
  }
  const topoIndex = new Map(order.map((id, i) => [id, i]));
  const phaseIdx = new Map();
  for (const id of order) {
    const it = byId.get(id);
    let idx = it.phase0 ? 0 : it.score >= NOW_SCORE ? 1 : it.score >= NEXT_SCORE ? 2 : 3;
    for (const d of deps.get(id)) idx = Math.max(idx, phaseIdx.get(d) ?? 0);
    phaseIdx.set(id, idx);
  }
  const result = order.map((id) => {
    const it = byId.get(id);
    const idx = phaseIdx.get(id);
    const quickWin = idx === 1 && it.effort === "S" && it.score >= QUICK_WIN_SCORE
      && deps.get(id).every((d) => phaseIdx.get(d) < 1);
    return {
      ...it,
      dependsOn: deps.get(id),
      phase: PHASE_ORDER[idx],
      quickWin,
      ...(broken.has(id) ? { cycleBroken: true } : {}),
    };
  });
  result.sort((a, b) =>
    (PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase))
    || ((a.quickWin === b.quickWin) ? 0 : (a.quickWin ? -1 : 1))
    || (topoIndex.get(a.id) - topoIndex.get(b.id)));
  return result;
}

// ---------- shared helpers (also used by refresh.js) ----------

export function shellSplit(command) {
  const out = []; let cur = ""; let quote = null; let pending = false;
  for (const ch of String(command ?? "")) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; pending = true; continue; }
    if (/\s/.test(ch)) { if (cur || pending) { out.push(cur); cur = ""; pending = false; } continue; }
    cur += ch;
  }
  if (quote) throw new OpError(`Unbalanced quote in command: ${command}`);
  if (cur || pending) out.push(cur);
  return out;
}

// Re-run a finding's recorded reproduction. reproduced: true | false | null —
// null means UNKNOWABLE here, and callers must never treat it as resolved
// (D6/D9: falsely marking a still-reproducing finding "done" silently
// falsifies the living document). Re-runs prefer the machine-re-runnable
// fields identify persists (`reproduction.check` spec / `reproduction.cmd`
// argv); the human-readable `record` string is only attempted when it is a
// single-line runnable command, and a spawn failure is never "resolved".
export function rerunReproduction(root, finding, exec) {
  const rep = finding?.reproduction;
  if (!rep || rep.method === "reread") return { reproduced: null, exitCode: null };
  // 1. deterministic check spec (static checks + native-grep reproductions)
  if (rep.check && typeof rep.check === "object") {
    const res = runReproCheck(root, rep.check);
    return { reproduced: res.ok, exitCode: null };
  }
  // 2. persisted argv (command reproductions)
  let argv = Array.isArray(rep.cmd) && rep.cmd.length > 0 ? rep.cmd.map(String) : null;
  // 3. legacy fallback: only a single-line record whose argv[0] is a plausible
  //    executable. Human-readable records ("$ node …", "native grep …",
  //    "static-check …") are not re-runnable → unknowable, never resolved.
  if (!argv) {
    const record = String(rep.record ?? "");
    if (!record || record.includes("\n")) return { reproduced: null, exitCode: null };
    try { argv = shellSplit(record); } catch { return { reproduced: null, exitCode: null }; }
    if (!argv.length || !/^[A-Za-z0-9_.\/-]+$/.test(argv[0]) || argv[0] === "native" || argv[0] === "static-check") {
      return { reproduced: null, exitCode: null };
    }
  }
  if (!argv.length) return { reproduced: null, exitCode: null };
  let res;
  try { res = exec(argv[0], argv.slice(1), { cwd: root, timeout: 30000 }); }
  catch { return { reproduced: null, exitCode: null }; }
  // Spawn failure (ENOENT → status -1/null) means the check never ran.
  if (!Number.isInteger(res.status) || res.status < 0) return { reproduced: null, exitCode: null };
  const expected = rep.exitCode ?? 0;
  return { reproduced: res.status === expected, exitCode: res.status };
}

function appendDoneRegressed(body, line) {
  if (body.includes(line)) return body;
  const lines = body.split("\n");
  const idx = lines.findIndex((l) => /^## Done \/ Regressed/.test(l));
  if (idx === -1) return `${body}\n\n## Done / Regressed\n\n${line}\n`;
  lines.splice(idx + 1, 0, "", line);
  return lines.join("\n");
}

export function markRoadmapResolved(body, findingId, sha) {
  const tag = ` (resolved @ ${String(sha).slice(0, 7)})`;
  if (body.split("\n").some((l) => l.includes(findingId) && l.includes("✅ done"))) return body; // idempotent
  let hit = false;
  const out = body.split("\n").map((line) => {
    if (!line.includes(findingId) || line.includes("✅ done") || !/^\s*- /.test(line)) return line;
    hit = true;
    return `${line.replace(/^(\s*)- /, "$1- ✅ done: ")}${tag}`;
  }).join("\n");
  if (hit) return out;
  return appendDoneRegressed(body, `- ✅ done: ${findingId}${tag}`);
}

export function markRoadmapRegressed(body, label, note) {
  return appendDoneRegressed(body, `- ⚠ regressed: ${label}${note ? ` — ${note}` : ""}`);
}

function refText(rel) {
  try { return readPackageFile(`do-better/references/${rel}`); } catch { return ""; }
}

function coerceJson(raw, label) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
  const a = s.indexOf("{"); const b = s.lastIndexOf("}");
  const c = s.indexOf("["); const d = s.lastIndexOf("]");
  if (a !== -1 && b > a && (c === -1 || a < c)) s = s.slice(a, b + 1);
  else if (c !== -1 && d > c) s = s.slice(c, d + 1);
  try { return JSON.parse(s); } catch { throw new OpError(`[${label}] returned unparseable JSON`); }
}

function gateFail(state, gate, detail) {
  const err = new GateError(`${gate}: ${detail}`, detail);
  err.gate = gate;
  err.detail = detail;
  err.state = state;
  return err;
}

// ---------- living-document reconciliation (D6) ----------

export function reconcilePrior({ priorBody, findings, root, exec }) {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const done = []; const regressed = []; const seen = new Set();
  for (const line of String(priorBody ?? "").split("\n")) {
    if (!/^\s*- /.test(line)) continue;
    const m = line.match(/\bF-[A-Z0-9]+-\d{4}\b/);
    if (!m || seen.has(m[0])) continue;
    seen.add(m[0]);
    const id = m[0];
    const title = (line.match(/\*\*(.+?)\*\*/) ?? [, id])[1];
    const finding = byId.get(id);
    if (/✅/.test(line)) {
      // previously done; finding re-verified → regressed, else carry done forward
      if (finding && rerunReproduction(root, finding, exec).reproduced === true) regressed.push({ id, title });
      else done.push({ id, title });
      continue;
    }
    if (!finding) { done.push({ id, title }); continue; }
    if (rerunReproduction(root, finding, exec).reproduced === false) done.push({ id, title });
  }
  return { done, regressed };
}

// ---------- scoring (frontier proposes, code computes) ----------

// deterministic offline-fallback proposal (severity-derived)
function defaultProposal(finding) {
  return {
    impact: SEVERITY_IMPACT[finding.severity] ?? "M",
    effort: "M",
    confidence: Number.isFinite(Number(finding.confidence)) ? Number(finding.confidence) : 0.5,
    dependsOn: [],
    railsNeeded: false,
    phase0: false,
    declineReason: null,
    riskOfInaction: null,
  };
}

// conservative default for findings the LLM omitted (by-id reconciliation: M/M/0.5, never dropped)
function conservativeProposal() {
  return {
    impact: "M", effort: "M", confidence: 0.5,
    dependsOn: [], railsNeeded: false, phase0: false,
    declineReason: null, riskOfInaction: null,
  };
}

function normalizeProposal(raw, finding, knownIds) {
  if (!raw || typeof raw !== "object") return conservativeProposal();
  const d = defaultProposal(finding);
  const conf = Number(raw.confidence);
  return {
    impact: TSHIRT[raw.impact] ? raw.impact : d.impact,
    effort: TSHIRT[raw.effort] ? raw.effort : d.effort,
    confidence: Number.isFinite(conf) && conf >= 0 && conf <= 1 ? conf : 0.5,
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((x) => knownIds.has(x) && x !== finding.id) : [],
    railsNeeded: Boolean(raw.railsNeeded),
    phase0: Boolean(raw.phase0),
    declineReason: typeof raw.declineReason === "string" && raw.declineReason ? raw.declineReason : null,
    riskOfInaction: typeof raw.riskOfInaction === "string" && raw.riskOfInaction ? raw.riskOfInaction : null,
  };
}

async function proposeScores(ctx, findings) {
  const knownIds = new Set(findings.map((f) => f.id));
  const brief = findings.map((f) => ({
    id: f.id, dimension: f.dimension, title: f.title, severity: f.severity,
    confidence: f.confidence, evidence: (f.evidence ?? []).map(formatCitation),
  }));
  const prompt = [
    "Assign roadmap scoring fields per verified finding. Return ONLY JSON:",
    '{"items":[{"id","impact":"S|M|L|XL","effort":"S|M|L|XL","confidence":0..1,',
    '"dependsOn":["F-..."],"railsNeeded":bool,"phase0":bool,"declineReason"?,"riskOfInaction"?}]}',
    "Findings:", JSON.stringify(brief, null, 2),
  ].join("\n");
  const raw = await withFallback(
    ctx.llm,
    { prompt, system: refText("scoring.md"), tier: "frontier", label: "score", jsonMode: true },
    () => ({ items: findings.map((f) => ({ id: f.id, ...defaultProposal(f) })) }),
  );
  const obj = coerceJson(raw, "score") ?? { items: [] };
  const list = Array.isArray(obj) ? obj : Array.isArray(obj.items) ? obj.items : [];
  const map = new Map();
  for (const entry of list) {
    if (entry && knownIds.has(entry.id)) map.set(entry.id, entry);
  }
  // by-id reconciliation: omitted findings get conservative defaults, never dropped
  return new Map(findings.map((f) => [f.id, normalizeProposal(map.get(f.id), f, knownIds)]));
}

function buildItem(finding, proposal, weights) {
  const base = scoreItem({ impact: proposal.impact, confidence: proposal.confidence, effort: proposal.effort });
  const score = applyCharterWeight(base, finding.dimension, weights);
  const declined = Boolean(proposal.declineReason) || score < DECLINE_SCORE;
  return {
    id: finding.id,
    title: finding.title,
    dimension: finding.dimension,
    severity: finding.severity,
    impact: proposal.impact,
    effort: proposal.effort,
    confidence: proposal.confidence,
    dependsOn: proposal.dependsOn,
    railsNeeded: proposal.railsNeeded,
    phase0: proposal.phase0,
    score,
    declined,
    declineReason: proposal.declineReason ?? (declined ? `score ${score.toFixed(2)} below ${DECLINE_SCORE}` : null),
    riskOfInaction: proposal.riskOfInaction
      ?? `unaddressed ${finding.severity} ${finding.dimension} issue persists (confidence ${proposal.confidence})`,
    evidence: finding.evidence ?? [],
  };
}

// ---------- document rendering ----------

function renderItemLines(it) {
  const cites = (it.evidence ?? []).map(formatCitation).join(", ");
  return [
    `- **${it.title}** (${it.id}, score ${it.score.toFixed(2)}, impact ${it.impact}, effort ${it.effort}, confidence ${it.confidence})${it.quickWin ? " ⚡ quick win" : ""}`,
    `  - Evidence: [${it.id}](findings/${it.id}.md)${cites ? ` — ${cites}` : ""}`,
    `  - Risk of inaction: ${it.riskOfInaction}`,
    ...(it.dependsOn?.length ? [`  - Depends on: ${it.dependsOn.join(", ")}`] : []),
  ];
}

export function renderRoadmap({ items, declined, recon, headSha, now, findingsCount }) {
  const meta = { generatedAt: now, headSha, basedOnFindings: findingsCount, approved: false };
  const byPhase = (p) => items.filter((i) => i.phase === p);
  const counts = PHASE_ORDER.map((p) => `${byPhase(p).length} ${p}`).join(", ");
  const lines = [
    "# Technical Roadmap", "",
    "## Executive summary", "",
    `Generated from ${findingsCount} verified findings at \`${String(headSha).slice(0, 7)}\`: ${counts}; ${declined.length} declined. Every item cites verified evidence in \`findings/\`; unverified claims never reach this document.`, "",
  ];
  const sections = [
    ["phase0", "Phase 0 — Rails & runnability"],
    ["now", "Now"], ["next", "Next"], ["later", "Later"],
  ];
  for (const [p, heading] of sections) {
    lines.push(`## ${heading}`, "");
    const list = byPhase(p);
    if (!list.length) lines.push("_None._");
    else for (const it of list) lines.push(...renderItemLines(it));
    lines.push("");
  }
  lines.push("## Done / Regressed", "");
  if (!recon.done.length && !recon.regressed.length) lines.push("_None._");
  for (const d of recon.done) lines.push(`- ✅ done: **${d.title}** (${d.id}) — resolved @ ${String(headSha).slice(0, 7)}`);
  for (const r of recon.regressed) lines.push(`- ⚠ regressed: **${r.title}** (${r.id}) — finding re-verified against current code`);
  lines.push("", "## Declined", "");
  if (!declined.length) lines.push("_None._");
  for (const it of declined) {
    lines.push(`- **${it.title}** (${it.id}) — declined: ${it.declineReason}. Risk of inaction: ${it.riskOfInaction}`);
  }
  lines.push("");
  return { meta, body: lines.join("\n") };
}

// ---------- tickets (ADLC P2 shape) ----------

function deterministicTicket(item, id, finding) {
  const repro = finding?.reproduction?.record;
  const scope = [...new Set((finding?.evidence ?? []).map((c) => c.file))];
  return {
    id,
    title: item.title,
    body: [
      "## Motivation",
      `Addresses [${item.id}](../findings/${item.id}.md): ${item.title} (${item.severity} ${item.dimension}).`,
      `Evidence: ${(finding?.evidence ?? []).map(formatCitation).join(", ") || "see finding file"}.`,
      "",
      "## Acceptance Criteria",
      `- [ ] The finding no longer reproduces — verification: a command whose output is asserted (\`${repro || "re-read of the cited code slice"}\`).`,
      "- [ ] Characterization rails covering touched behaviors stay green — verification: a test to be written/run.",
      "",
      "## Partition hints",
      "- Scope is limited to the cited files; contracts live at module boundaries.",
    ].join("\n"),
    scope: scope.length ? scope : ["package.json"],
    rails: [],
    edges: [],
    duration: EFFORT_HOURS[item.effort] ?? 4,
    category: item.dimension,
  };
}

function normalizeTicket(raw, item, id, finding) {
  const base = deterministicTicket(item, id, finding);
  if (!raw || typeof raw !== "object") return base;
  return {
    id,
    title: typeof raw.title === "string" && raw.title ? raw.title : base.title,
    body: typeof raw.body === "string" && raw.body.length >= 20 ? raw.body : base.body,
    scope: Array.isArray(raw.scope) && raw.scope.length ? raw.scope.map(String) : base.scope,
    rails: Array.isArray(raw.rails) ? raw.rails.map(String) : base.rails,
    edges: Array.isArray(raw.edges) ? raw.edges.filter((e) => e && e.to && e.contract) : base.edges,
    duration: typeof raw.duration === "number" && raw.duration > 0 ? raw.duration : base.duration,
    category: typeof raw.category === "string" && raw.category ? raw.category : base.category,
    ...(typeof raw.budget === "number" ? { budget: raw.budget } : {}),
  };
}

async function draftTicket(ctx, item, id, finding) {
  const prompt = [
    `Write an ADLC P2 ticket (id ${id}) for this roadmap item. Return ONLY JSON`,
    '{"title","body","scope":[globs],"rails":[],"edges":[{"to","contract"}],"duration":hours,"category"}.',
    "The body must be self-contained: Motivation linking the finding file, machine-verifiable",
    "Acceptance Criteria each naming its verification method, and Partition hints.",
    "Item:", JSON.stringify({ ...item, evidence: (item.evidence ?? []).map(formatCitation) }, null, 2),
    "Finding reproduction:", JSON.stringify(finding?.reproduction ?? null),
    refText("templates/ticket-template.md"),
  ].join("\n");
  const raw = await withFallback(
    ctx.llm,
    { prompt, tier: "frontier", label: `ticket:${id}`, jsonMode: true },
    () => deterministicTicket(item, id, finding),
  );
  return normalizeTicket(coerceJson(raw, `ticket:${id}`), item, id, finding);
}

async function repairTicket(ctx, ticket, problems, item, finding) {
  const prompt = [
    `Repair this ticket so it is fresh-agent executable. Problems:`,
    ...problems.map((p) => `- ${typeof p === "string" ? p : `${p.what}: ${p.why_blocking ?? ""}`}`),
    "Embed the missing data shapes / contracts / concrete acceptance criteria directly in the body.",
    "Return ONLY JSON with the full ticket fields.",
    "Ticket:", JSON.stringify(ticket, null, 2),
  ].join("\n");
  const raw = await withFallback(
    ctx.llm,
    { prompt, tier: "frontier", label: "ticket-repair", jsonMode: true },
    () => ticket,
  );
  const patch = coerceJson(raw, "ticket-repair");
  const merged = patch && typeof patch === "object" ? { ...ticket, ...patch } : ticket;
  return normalizeTicket(merged, item, ticket.id, finding);
}

// ---------- coldstart gate (D6) ----------

const PROBE_GAPS = "missing data shapes, absent contracts, unverifiable acceptance criteria, vague scope, unstated files";

async function coldstartCheck(ctx, tickets) {
  const ticketsPath = path.join(ctx.dotdir, LAYOUT.backlogJson);
  const res = runColdstart(ctx.adlc, { ticketsPath, all: true, cwd: ctx.root, exec: ctx.exec });
  if (!res.skipped) {
    const gapsById = new Map();
    for (const r of res.results ?? []) {
      if (r && r.pass === false) gapsById.set(r.id, Array.isArray(r.gaps) ? r.gaps : []);
    }
    return { degraded: null, gapsById };
  }
  const allIds = tickets.map((t) => t.id);
  if (ctx.llm.offline) {
    const gapsById = new Map();
    for (const t of tickets) {
      const errs = validateTicket(t, allIds);
      if (errs.length) gapsById.set(t.id, errs.map((e) => ({ what: e, why_blocking: "static lint failure" })));
    }
    return { degraded: "static-lint", gapsById };
  }
  const gapsById = new Map();
  for (const t of tickets) {
    const prompt = [
      "You are a fresh agent cold-starting this ticket with no other context.",
      `Report blocking gaps in these categories: ${PROBE_GAPS}.`,
      'Return ONLY JSON {"pass":bool,"gaps":[{"what","why_blocking"}]}.',
      "Ticket:", JSON.stringify(t, null, 2),
    ].join("\n");
    const raw = await withFallback(
      ctx.llm,
      { prompt, tier: "cheap", label: "coldstart-probe", jsonMode: true },
      () => ({ pass: true, gaps: [] }),
    );
    const obj = coerceJson(raw, "coldstart-probe");
    if (obj && obj.pass === false) gapsById.set(t.id, Array.isArray(obj.gaps) ? obj.gaps : []);
  }
  return { degraded: "native-probe", gapsById };
}

// ---------- phase entrypoints ----------

export async function run(ctx) {
  const { root, dotdir, log } = ctx;
  let state = ctx.state;
  if (!state?.gates?.identify?.passed) {
    throw new OpError("Identify gate has not passed — run `do-better audit` first.");
  }
  ensureLayout(dotdir);
  const headSha = gitHeadSha(root, ctx.exec);
  const findings = readFindings(dotdir);
  if (!findings.length) log.warn("No verified findings — the roadmap will be empty.");
  const weights = readArtifact(dotdir, LAYOUT.charter)?.meta?.weights ?? {};

  // 2. living-document reconciliation
  const prior = readArtifact(dotdir, LAYOUT.roadmap);
  const recon = prior
    ? reconcilePrior({ priorBody: prior.body, findings, root, exec: ctx.exec })
    : { done: [], regressed: [] };

  // 3-4. score + sequence
  const proposals = await proposeScores(ctx, findings);
  const allItems = findings.map((f) => buildItem(f, proposals.get(f.id), weights));
  const declined = allItems.filter((i) => i.declined);
  let items = sequence(allItems.filter((i) => !i.declined));
  for (const it of items) if (it.cycleBroken) log.warn(`Dependency cycle broken at ${it.id} (lowest score in cycle).`);

  // 7. tickets for Phase 0 + Now + Next items
  const findingById = new Map(findings.map((f) => [f.id, f]));
  let counter = state.counters?.tickets ?? 0;
  let tickets = [];
  const demotedIds = new Set();
  for (const item of items.filter((i) => i.phase !== "later")) {
    counter += 1;
    const id = `T${counter}`;
    let ticket = await draftTicket(ctx, item, id, findingById.get(item.id));
    let errs = validateTicket(ticket, [...tickets.map((t) => t.id), id]);
    if (errs.length) {
      ticket = await repairTicket(ctx, ticket, errs, item, findingById.get(item.id));
      errs = validateTicket(ticket, [...tickets.map((t) => t.id), id]);
    }
    if (errs.length) {
      log.warn(`Ticket ${id} invalid after repair (${errs.join("; ")}) — demoting ${item.id} to Later.`);
      demotedIds.add(item.id);
      continue;
    }
    tickets.push({ ...ticket, findingId: item.id });
  }
  items = items.map((i) => (demotedIds.has(i.id) ? { ...i, phase: "later" } : i));
  state = { ...state, counters: { ...state.counters, tickets: counter } };
  const persistTickets = (list) => writeTickets(dotdir, list.map(({ findingId, ...t }) => t));
  persistTickets(tickets);

  // 8. coldstart gate with repair loop
  let coldstart = { degraded: null, gapsById: new Map() };
  let clean = tickets.length === 0;
  if (tickets.length) {
    for (let round = 0; round <= COLDSTART_FIX_ROUNDS; round++) {
      coldstart = await coldstartCheck(ctx, tickets);
      if (!coldstart.gapsById.size) { clean = true; break; }
      if (round === COLDSTART_FIX_ROUNDS) break;
      tickets = await Promise.all(tickets.map(async (t) => {
        const gaps = coldstart.gapsById.get(t.id);
        if (!gaps) return t;
        const item = items.find((i) => i.id === t.findingId) ?? { id: t.findingId, severity: "medium", dimension: t.category, title: t.title, effort: "M" };
        const repaired = await repairTicket(ctx, t, gaps, item, findingById.get(t.findingId));
        return { ...repaired, findingId: t.findingId };
      }));
      persistTickets(tickets);
    }
  }

  if (!clean) {
    // demote gapped items + flag tickets, persist everything, then fail the gate (exit 2)
    const gappedTicketIds = [...coldstart.gapsById.keys()];
    const gappedFindingIds = new Set(tickets.filter((t) => gappedTicketIds.includes(t.id)).map((t) => t.findingId));
    items = items.map((i) => (gappedFindingIds.has(i.id) ? { ...i, phase: "later" } : i));
    tickets = tickets.map((t) => (gappedTicketIds.includes(t.id)
      ? { ...t, body: `> coldstart: failed — demoted to Later after ${COLDSTART_FIX_ROUNDS} repair rounds.\n\n${t.body}` }
      : t));
    persistTickets(tickets);
    state = writeRoadmapDoc(state, ctx, { items, declined, recon, headSha });
    state = setGate(state, "roadmap", { coldstartClean: false, coldstartDegraded: coldstart.degraded, approved: false, approvedAt: null });
    state = finishState(state, ctx, { headSha, status: "failed", ticketCount: tickets.length, declinedCount: declined.length });
    throw gateFail(state, "roadmap", `coldstart gaps persist after ${COLDSTART_FIX_ROUNDS} repair rounds in: ${gappedTicketIds.join(", ")}`);
  }

  // 6. final document + hash, gate state, human gate 2
  state = writeRoadmapDoc(state, ctx, { items, declined, recon, headSha });
  state = setGate(state, "roadmap", {
    coldstartClean: true,
    coldstartDegraded: coldstart.degraded,
    approved: false,
    approvedAt: null,
  });
  state = finishState(state, ctx, { headSha, status: "done", ticketCount: tickets.length, declinedCount: declined.length });
  const degradedNote = coldstart.degraded ? ` (coldstart degraded: ${coldstart.degraded})` : "";
  return {
    state,
    gate: { name: "roadmap-approval", passed: false, human: true, detail: APPROVE_HINT },
    summary: `Roadmap drafted from ${findings.length} findings: ${tickets.length} tickets, ${declined.length} declined, ${recon.done.length} done, ${recon.regressed.length} regressed${degradedNote}. ${APPROVE_HINT}`,
  };
}

function writeRoadmapDoc(state, ctx, { items, declined, recon, headSha }) {
  const doc = renderRoadmap({
    items, declined, recon, headSha,
    now: ctx.now(),
    findingsCount: items.length + declined.length,
  });
  writeArtifact(ctx.dotdir, LAYOUT.roadmap, doc);
  const raw = fs.readFileSync(path.join(ctx.dotdir, LAYOUT.roadmap), "utf8");
  return recordRoadmapHash(state, { sha256: sha256Hex(raw), headSha, now: ctx.now() });
}

function finishState(state, ctx, { headSha, status, ticketCount, declinedCount }) {
  let next = addSpend(state, PHASE_ID, ctx.llm.drainSpend());
  next = recordPhase(next, PHASE_ID, { status, sha: headSha, now: ctx.now() });
  next = {
    ...next,
    phases: { ...next.phases, [PHASE_ID]: { ...next.phases[PHASE_ID], ticketCount, declinedCount } },
  };
  if (status === "done") next = pinSha(next, PHASE_ID, headSha);
  return next;
}

export async function approve(ctx) {
  const { dotdir, log } = ctx;
  let state = ctx.state;
  const abs = path.join(dotdir, LAYOUT.roadmap);
  if (!fs.existsSync(abs)) throw new OpError("No .dobetter/ROADMAP.md found — run `do-better roadmap` first.");
  if (!state?.gates?.roadmap?.coldstartClean) {
    throw new OpError("Roadmap coldstart gate is not clean — run `do-better roadmap` first.");
  }
  const hash = sha256Hex(fs.readFileSync(abs, "utf8"));
  const hist = state.roadmapHistory ?? [];
  const last = hist[hist.length - 1];
  if (last && last.sha256 !== hash) {
    log.warn("ROADMAP.md changed since generation (human edits are fine) — recording the new hash.");
  }
  if (!last || last.sha256 !== hash) {
    state = recordRoadmapHash(state, { sha256: hash, headSha: gitHeadSha(ctx.root, ctx.exec), now: ctx.now() });
  }
  state = setGate(state, "roadmap", { approved: true, approvedAt: ctx.now(), roadmapSha256: hash });
  return {
    state,
    gate: { name: "roadmap-approval", passed: true, human: true, detail: "Roadmap approved." },
    summary: `Roadmap approved (${truncate(hash, 12)}). Next: do-better rail`,
  };
}
