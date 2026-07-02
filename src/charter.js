// src/charter.js — D0: grill-me-style stakeholder interview seeded by D-1 scan
// facts. Enforces the fixed taxonomy floor (D5), writes .dobetter/charter.md,
// and ends at HUMAN GATE 1 (charter approval, D8). Frontier tier for question
// synthesis + charter synthesis (§6); the markdown itself is assembled in code
// so the frontmatter contract is always exact.
import fs from "node:fs";
import { OpError, TAXONOMY, gitHeadSha, sha256Hex } from "./utils.js";
import { addSpend, pinSha, recordPhase, setGate } from "./state.js";
import {
  LAYOUT,
  parseFrontmatter,
  readArtifact,
  serializeFrontmatter,
  writeArtifact,
} from "./artifacts.js";
import { cleanJsonResponse, withFallback } from "./llm.js";

export const PHASE_ID = "charter";

const INTENTS = ["stabilize", "scale", "extend", "handoff"];
const MAX_QUESTIONS = 12;
const MIN_LLM_QUESTIONS = 4; // fewer valid LLM questions than this → static plan
const DEFAULT_WEIGHT = 3;
const WEIGHT_MAX = 5;
const APPROVE_HINT =
  "Charter drafted at .dobetter/charter.md — review/edit, then run: do-better charter --approve";
const OFFLINE_MARKER = Symbol("charter-offline");

// ---------------------------------------------------------------- questions

function listOr(arr, empty = "none") {
  return arr && arr.length ? arr.join(", ") : empty;
}

function dimensionFact(dimId, facts) {
  const scripts = Object.keys(facts.incantations?.scripts ?? {});
  switch (dimId) {
    case "correctness":
      return `scan found ${facts.todoCount} TODO/FIXME/HACK markers across ${facts.fileCount} files`;
    case "security":
      return `${facts.depCounts?.prod ?? 0} production dependencies; manifests: ${listOr(facts.manifests)}`;
    case "maintainability": {
      const top = facts.largestFiles?.[0];
      return top ? `largest file is ${top.file} at ${top.loc} LOC` : `${facts.locTotal} LOC total`;
    }
    case "performance":
      return `${facts.locTotal} LOC across ${facts.fileCount} files`;
    case "operability":
      return facts.incantations?.ci?.length
        ? `CI config present: ${listOr(facts.incantations.ci)}`
        : "no CI configuration detected";
    case "test-quality":
      return facts.testDirs?.length
        ? `test dirs present: ${listOr(facts.testDirs)}`
        : "no test directories detected";
    case "dependency-health":
      return `${facts.depCounts?.prod ?? 0} prod / ${facts.depCounts?.dev ?? 0} dev dependencies`;
    case "dx":
      return scripts.length
        ? `${scripts.length} script(s)/target(s): ${listOr(scripts.slice(0, 6))}`
        : "no package scripts or Make targets detected";
    default:
      return `${facts.fileCount} tracked files`;
  }
}

function recommendedWeight(dimId, facts) {
  if (dimId === "test-quality" && !(facts.testDirs?.length)) return "5";
  if (dimId === "operability" && !(facts.incantations?.ci?.length)) return "4";
  if (dimId === "dependency-health" && !(facts.manifests?.length)) return "1";
  return String(DEFAULT_WEIGHT);
}

// Offline/static fallback plan. Always covers pain, 12-month intent,
// constraints, and one weight question per taxonomy dimension — every
// question cites a concrete scan fact (grill-me, seeded by D-1).
export function buildStaticQuestionPlan(facts) {
  const questions = [
    {
      id: "pain",
      text:
        `What hurts most about this codebase today? ` +
        `(scan: ${facts.fileCount} files, ${facts.locTotal} LOC, ${facts.todoCount} TODO/FIXME/HACK markers)`,
      recommended:
        facts.todoCount > 0
          ? `Accumulated debt — ${facts.todoCount} TODO/FIXME/HACK markers in the tree`
          : "General maintainability",
      dimension: null,
    },
    {
      id: "intent",
      text: "What is the 12-month intent for this codebase? (stabilize / scale / extend / handoff)",
      recommended: "stabilize",
      dimension: null,
    },
    {
      id: "constraints",
      text: "Any constraints? (compliance regimes, freeze windows, team capacity, no-touch areas)",
      recommended: "None",
      dimension: null,
    },
    ...TAXONOMY.map((dim) => ({
      id: `weight-${dim.id}`,
      text: `How much should "${dim.label}" weigh in this engagement, 0-5? (${dimensionFact(dim.id, facts)})`,
      recommended: recommendedWeight(dim.id, facts),
      dimension: dim.id,
    })),
  ];
  return questions.slice(0, MAX_QUESTIONS);
}

function isValidQuestion(q) {
  return (
    q &&
    typeof q === "object" &&
    (typeof q.id === "string" || typeof q.id === "number") &&
    typeof q.text === "string" &&
    q.text.trim().length > 0 &&
    q.recommended != null &&
    (q.dimension == null || typeof q.dimension === "string")
  );
}

function normalizeQuestionPlan(value, staticPlan) {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(cleanJsonResponse(candidate));
    } catch {
      return staticPlan; // documented fallback: bad plan → static plan
    }
  }
  const list = Array.isArray(candidate)
    ? candidate
    : Array.isArray(candidate?.questions)
      ? candidate.questions
      : null;
  if (!list) return staticPlan;
  const valid = list
    .filter(isValidQuestion)
    .map((q) => ({
      id: String(q.id),
      text: String(q.text).trim(),
      recommended: String(q.recommended),
      dimension: q.dimension == null ? null : String(q.dimension),
    }))
    .slice(0, MAX_QUESTIONS);
  return valid.length >= MIN_LLM_QUESTIONS ? valid : staticPlan;
}

function buildQuestionPrompt(facts) {
  return [
    "You are preparing a grill-me-style stakeholder interview for a brownfield codebase engagement.",
    `Produce at most ${MAX_QUESTIONS} interview questions. Each question MUST cite a concrete scan fact`,
    "from the data below and MUST carry a recommended answer the stakeholder can accept as-is.",
    "Always include: the stakeholder's pain, the 12-month intent (stabilize/scale/extend/handoff),",
    "constraints, and weight questions (0-5) for the quality taxonomy dimensions:",
    TAXONOMY.map((d) => `${d.id} (${d.label})`).join(", ") + ".",
    'Return ONLY JSON: {"questions":[{"id":"...","text":"...","recommended":"...","dimension":"<taxonomy id or null>"}]}',
    "",
    "Scan facts:",
    JSON.stringify(facts, null, 2),
  ].join("\n");
}

async function buildQuestionPlan(ctx, facts) {
  const staticPlan = buildStaticQuestionPlan(facts);
  const value = await withFallback(
    ctx.llm,
    {
      prompt: buildQuestionPrompt(facts),
      system: "You design sharp, fact-grounded stakeholder interviews. JSON only.",
      tier: "frontier",
      label: "charter-questions",
      jsonMode: true,
    },
    () => OFFLINE_MARKER
  );
  if (value === OFFLINE_MARKER) return staticPlan;
  return normalizeQuestionPlan(value, staticPlan);
}

// ------------------------------------------------- codebase-check + answers

// Grill-me codebase-check clause: answer deterministically from scan facts
// when the evidence is decisive; such questions are never asked.
function establishFromFacts(question, facts) {
  if (question.dimension === "test-quality" && !(facts.testDirs?.length)) {
    return { answer: "5", evidence: `no test directories among ${facts.fileCount} tracked files` };
  }
  if (question.dimension === "dependency-health" && !(facts.manifests?.length)) {
    return { answer: "1", evidence: "no dependency manifests found in the repository" };
  }
  return null;
}

function loadScriptedAnswers(answersPath) {
  let raw;
  try {
    raw = fs.readFileSync(answersPath, "utf8");
  } catch (err) {
    throw new OpError(`DOBETTER_ANSWERS file not readable: ${answersPath} (${err.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpError(`DOBETTER_ANSWERS must be a JSON array of answer strings: ${answersPath}`);
  }
  if (!Array.isArray(parsed)) {
    throw new OpError(`DOBETTER_ANSWERS must be a JSON array of answer strings: ${answersPath}`);
  }
  return parsed.map((a) => String(a));
}

// Answerer seam: DOBETTER_ANSWERS (scripted, in order; exhausted → "" which
// accepts the recommended answer) beats interactive ctx.ask. Neither → OpError.
function createAnswerer(ctx, env) {
  if (env.DOBETTER_ANSWERS) {
    const answers = loadScriptedAnswers(env.DOBETTER_ANSWERS);
    let i = 0;
    return async () => (i < answers.length ? answers[i++] : "");
  }
  if (typeof ctx.ask === "function") {
    return async (prompt) => String((await ctx.ask(prompt)) ?? "");
  }
  throw new OpError(
    "Charter interview needs answers: run interactively in a TTY, or set " +
      "DOBETTER_ANSWERS=<path to a JSON array of answer strings>."
  );
}

async function conductInterview(ctx, answerer, plan, facts) {
  const answers = [];
  const established = [];
  for (const question of plan) {
    const auto = establishFromFacts(question, facts);
    if (auto) {
      ctx.log.substep(`Established from codebase: ${question.id} → ${auto.answer} (${auto.evidence})`);
      established.push({ question, answer: auto.answer, evidence: auto.evidence });
      continue;
    }
    ctx.log.step(question.text);
    const raw = (await answerer(`${question.text}\n  [recommended: ${question.recommended}] > `)).trim();
    answers.push({ question, answer: raw === "" ? question.recommended : raw });
  }
  return { answers, established };
}

// ---------------------------------------------------------------- synthesis

function parseWeightAnswer(text) {
  const m = /-?\d+/.exec(String(text ?? ""));
  return m ? Number.parseInt(m[0], 10) : null;
}

function clampWeight(n) {
  return Math.max(0, Math.min(WEIGHT_MAX, Math.round(n)));
}

// Deterministic synthesis from raw answers (offline path and reconciliation
// baseline). Template fill only — no prose invention.
function offlineSynthesis({ answers, established }) {
  const find = (id) => answers.find((a) => a.question.id === id)?.answer ?? null;
  const weights = {};
  const rationale = {};
  for (const dim of TAXONOMY) {
    const asked = answers.find((a) => a.question.dimension === dim.id);
    const auto = established.find((e) => e.question.dimension === dim.id);
    const source = asked ?? auto;
    const parsed = parseWeightAnswer(source?.answer);
    weights[dim.id] = parsed == null ? DEFAULT_WEIGHT : clampWeight(parsed);
    rationale[dim.id] = asked
      ? `stakeholder: ${asked.answer}`
      : auto
        ? `established from codebase: ${auto.evidence}`
        : "default weight (no answer recorded)";
  }
  const intentRaw = (find("intent") ?? "stabilize").toLowerCase();
  const intent =
    INTENTS.find((i) => intentRaw.includes(i)) ?? (intentRaw.includes("hand") ? "handoff" : "stabilize");
  const pain = find("pain") ? [find("pain")] : [];
  const constraintsRaw = find("constraints");
  const constraints =
    !constraintsRaw || /^none\.?$/i.test(constraintsRaw.trim()) ? [] : [constraintsRaw];
  return { intent, weights, extraDimensions: [], pain, constraints, rationale };
}

function toStringList(value) {
  if (Array.isArray(value)) {
    return value.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return null;
}

function normalizeExtraDimension(d) {
  if (!d || typeof d !== "object") return null;
  const id = String(d.id ?? d.label ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  if (TAXONOMY.some((t) => t.id === id)) return null; // taxonomy dims live in weights
  const label = String(d.label ?? d.id).replace(/[|,\n]/g, "/").trim() || id;
  const parsed = parseWeightAnswer(d.weight);
  const weight = parsed == null ? DEFAULT_WEIGHT : Math.max(1, clampWeight(parsed));
  return { id, label, weight };
}

// Field-by-field reconciliation of frontier synthesis JSON against the
// deterministic baseline. When the LLM supplies a weights map it is
// authoritative — missing taxonomy dims are floor-corrected later (D5).
function reconcileSynthesis(parsed, baseline) {
  const out = { ...baseline };
  if (typeof parsed.intent === "string" && INTENTS.includes(parsed.intent.toLowerCase().trim())) {
    out.intent = parsed.intent.toLowerCase().trim();
  }
  if (parsed.weights && typeof parsed.weights === "object" && !Array.isArray(parsed.weights)) {
    const coerced = {};
    for (const dim of TAXONOMY) {
      const n = parseWeightAnswer(parsed.weights[dim.id]);
      if (n != null) coerced[dim.id] = clampWeight(n);
    }
    out.weights = coerced;
  }
  const pain = toStringList(parsed.pain);
  if (pain) out.pain = pain;
  if (Array.isArray(parsed.constraints)) {
    out.constraints = toStringList(parsed.constraints) ?? []; // explicit [] = "no constraints"
  } else {
    const constraints = toStringList(parsed.constraints);
    if (constraints) out.constraints = constraints;
  }
  if (Array.isArray(parsed.extraDimensions)) {
    out.extraDimensions = parsed.extraDimensions.map(normalizeExtraDimension).filter(Boolean);
  }
  if (parsed.rationale && typeof parsed.rationale === "object" && !Array.isArray(parsed.rationale)) {
    const merged = { ...baseline.rationale };
    for (const [k, v] of Object.entries(parsed.rationale)) {
      if (typeof v === "string" && v.trim()) merged[k] = v.trim();
    }
    out.rationale = merged;
  }
  return out;
}

function buildSynthesisPrompt({ facts, answers, established }) {
  const transcript = answers.map((a) => `Q (${a.question.id}): ${a.question.text}\nA: ${a.answer}`);
  const auto = established.map(
    (e) => `Q (${e.question.id}): ${e.question.text}\nA (from codebase): ${e.answer} — ${e.evidence}`
  );
  return [
    "Synthesize a quality charter for a brownfield engagement from this stakeholder interview.",
    "The fixed taxonomy floor (all dimensions MUST be weighted 1-5):",
    TAXONOMY.map((d) => `${d.id} (${d.label})`).join(", ") + ".",
    "Return ONLY JSON:",
    '{"intent":"stabilize|scale|extend|handoff","weights":{"<taxonomy id>":1-5,...},',
    '"extraDimensions":[{"id":"slug","label":"...","weight":1-5}],"pain":["..."],',
    '"constraints":["..."],"rationale":{"<taxonomy id>":"why this weight"}}',
    "",
    "Interview transcript:",
    ...transcript,
    "",
    "Established from the codebase (deterministic, not asked):",
    ...(auto.length ? auto : ["(nothing auto-established)"]),
    "",
    "Scan headline facts:",
    JSON.stringify(
      {
        fileCount: facts.fileCount,
        locTotal: facts.locTotal,
        todoCount: facts.todoCount,
        testDirs: facts.testDirs,
        manifests: facts.manifests,
        incantations: facts.incantations,
      },
      null,
      2
    ),
  ].join("\n");
}

async function synthesizeCharter(ctx, data) {
  const baseline = offlineSynthesis(data);
  const value = await withFallback(
    ctx.llm,
    {
      prompt: buildSynthesisPrompt(data),
      system: "You synthesize engagement quality charters. JSON only.",
      tier: "frontier",
      label: "charter-synthesis",
      jsonMode: true,
    },
    () => OFFLINE_MARKER
  );
  if (value === OFFLINE_MARKER) return baseline;
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(cleanJsonResponse(parsed));
    } catch {
      throw new OpError("[charter-synthesis] returned unparseable JSON"); // fail closed
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OpError("[charter-synthesis] returned unparseable JSON");
  }
  return reconcileSynthesis(parsed, baseline);
}

// Taxonomy floor (D5): every taxonomy id appears with weight ≥1. Missing or
// sub-floor weights are corrected to 1 with a "(floor)" note — never dropped.
function applyTaxonomyFloor(rawWeights) {
  const weights = {};
  const floored = [];
  for (const dim of TAXONOMY) {
    const n = Number(rawWeights?.[dim.id]);
    if (Number.isFinite(n) && Math.round(n) >= 1) {
      weights[dim.id] = Math.min(Math.round(n), WEIGHT_MAX);
    } else {
      weights[dim.id] = 1;
      floored.push(dim.id);
    }
  }
  return { weights, floored };
}

// ----------------------------------------------------------------- assembly

function tableCell(text) {
  return String(text ?? "").replace(/\|/g, "/").replace(/\n/g, " ");
}

function assembleCharter({ synthesis, floored, established, headSha, generatedAt }) {
  const meta = {
    approved: false,
    headSha,
    generatedAt,
    intent: synthesis.intent,
    weights: Object.fromEntries(TAXONOMY.map((dim) => [dim.id, synthesis.weights[dim.id]])),
  };
  if (synthesis.extraDimensions.length) {
    // Frontmatter codec supports scalar arrays only — encode as id|label|weight.
    meta.extraDimensions = synthesis.extraDimensions.map((d) => `${d.id}|${d.label}|${d.weight}`);
  }
  const lines = [
    "# Quality Charter",
    "",
    `_Seeded by \`do-better scan\` facts @ ${headSha.slice(0, 7)}; drafted by \`do-better charter\` (D0)._`,
    "",
    "## Pain",
  ];
  if (synthesis.pain.length) for (const p of synthesis.pain) lines.push(`- ${p}`);
  else lines.push("_None recorded._");
  lines.push("", "## Intent", `Twelve-month intent: **${synthesis.intent}**.`, "", "## Constraints");
  if (synthesis.constraints.length) for (const c of synthesis.constraints) lines.push(`- ${c}`);
  else lines.push("_None recorded._");
  lines.push("", "## Dimension weights", "| Dimension | Weight | Rationale |", "| --- | --- | --- |");
  for (const dim of TAXONOMY) {
    const w = synthesis.weights[dim.id];
    const isFloored = floored.includes(dim.id);
    const weightCell = isFloored ? `${w} (floor)` : String(w);
    const why = isFloored
      ? "not weighted by synthesis — taxonomy floor applied (D5)"
      : synthesis.rationale?.[dim.id] ?? "";
    lines.push(`| ${dim.label} | ${weightCell} | ${tableCell(why)} |`);
  }
  lines.push("", "## Established from the codebase");
  if (established.length) {
    for (const e of established) {
      lines.push(`- ${e.question.text} → **${e.answer}** (evidence: ${e.evidence})`);
    }
  } else {
    lines.push("_Nothing auto-established — every question was asked._");
  }
  lines.push("", "## Engagement dimensions");
  if (synthesis.extraDimensions.length) {
    for (const d of synthesis.extraDimensions) lines.push(`- **${d.label}** (\`${d.id}\`) — weight ${d.weight}`);
  } else {
    lines.push("_None — fixed taxonomy only._");
  }
  lines.push("");
  return { meta, body: lines.join("\n") };
}

// ------------------------------------------------------------------ parsing

function parseBulletSection(body, heading) {
  const out = [];
  let inSection = false;
  for (const line of String(body).split("\n")) {
    if (/^##\s+/.test(line)) {
      inSection = line.replace(/^##\s+/, "").trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (inSection && line.startsWith("- ")) out.push(line.slice(2).trim());
  }
  return out;
}

function parseExtraDimensions(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const entry of list) {
    const [id, label, weight] = String(entry).split("|");
    if (!id || !id.trim()) continue;
    const parsed = parseWeightAnswer(weight);
    out.push({
      id: id.trim(),
      label: (label ?? id).trim() || id.trim(),
      weight: parsed == null ? 1 : Math.max(1, clampWeight(parsed)),
    });
  }
  return out;
}

// Strict charter validation — used by approve() and downstream phases' tests.
// Throws OpError on any missing taxonomy weight (fixed taxonomy floor, D5).
export function parseCharter(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new OpError("Charter is empty or unreadable — run `do-better charter` to regenerate it.");
  }
  const { meta, body } = parseFrontmatter(text);
  const weightsRaw = meta.weights;
  if (!weightsRaw || typeof weightsRaw !== "object" || Array.isArray(weightsRaw)) {
    throw new OpError(
      "Charter frontmatter is missing the `weights` map — regenerate with `do-better charter`."
    );
  }
  const weights = {};
  for (const dim of TAXONOMY) {
    const n = Number(weightsRaw[dim.id]);
    if (!Number.isFinite(n) || Math.round(n) < 1) {
      throw new OpError(
        `Charter is missing taxonomy weight for "${dim.id}" (fixed taxonomy floor, D5). ` +
          `Add \`${dim.id}: <1-5>\` under \`weights:\` in .dobetter/charter.md.`
      );
    }
    weights[dim.id] = Math.min(Math.round(n), WEIGHT_MAX);
  }
  const intent = typeof meta.intent === "string" ? meta.intent.toLowerCase().trim() : null;
  if (!INTENTS.includes(intent)) {
    throw new OpError(
      `Charter intent must be one of ${INTENTS.join("/")} (got ${JSON.stringify(meta.intent ?? null)}).`
    );
  }
  return {
    weights,
    extraDimensions: parseExtraDimensions(meta.extraDimensions),
    intent,
    constraints: parseBulletSection(body, "Constraints"),
    pain: parseBulletSection(body, "Pain"),
    approved: meta.approved === true,
  };
}

// ----------------------------------------------------------------- approval

function approveCharterFile(ctx, state) {
  const existing = readArtifact(ctx.dotdir, LAYOUT.charter);
  if (!existing) {
    throw new OpError("No charter found at .dobetter/charter.md — run `do-better charter` first.");
  }
  // Validate the floor before approving (humans may have edited the file).
  parseCharter(serializeFrontmatter(existing.meta, existing.body));
  const meta = { ...existing.meta, approved: true };
  const content = serializeFrontmatter(meta, existing.body);
  writeArtifact(ctx.dotdir, LAYOUT.charter, { meta, body: existing.body });
  const charterSha256 = sha256Hex(content);
  const approvedAt = ctx.now();
  const next = setGate(state, "charter", { approved: true, approvedAt, charterSha256 });
  return { state: next, charterSha256 };
}

// `do-better charter --approve` path: re-read charter.md, validate the
// taxonomy floor, hash it, set HUMAN GATE 1.
export async function approve(ctx) {
  const headSha = gitHeadSha(ctx.root, ctx.exec);
  let state = ctx.state;
  const approved = approveCharterFile(ctx, state);
  state = approved.state;
  state = recordPhase(state, PHASE_ID, { status: "done", sha: headSha, now: ctx.now() });
  state = pinSha(state, PHASE_ID, headSha);
  const summary =
    `Charter approved (sha256 ${approved.charterSha256.slice(0, 12)}…). ` +
    "HUMAN GATE 1 passed — next: do-better audit.";
  return {
    state,
    gate: { name: "charter", passed: true, human: true, detail: "Charter approved." },
    summary,
  };
}

// --------------------------------------------------------------------- run

export async function run(ctx) {
  const facts = ctx.state?.phases?.scan?.facts;
  if (!facts) {
    throw new OpError(
      "No scan facts found — run `do-better scan` first (charter questions cite scan facts, D8)."
    );
  }
  ctx.log.phase("D0", "Charter");
  const headSha = gitHeadSha(ctx.root, ctx.exec);
  const answerer = createAnswerer(ctx, process.env); // fail fast before spending tokens
  let state = ctx.state;
  try {
    ctx.log.step("Building interview question plan (frontier tier)");
    const plan = await buildQuestionPlan(ctx, facts);

    const { answers, established } = await conductInterview(ctx, answerer, plan, facts);

    ctx.log.step("Synthesizing charter (frontier tier)");
    const synthesis = await synthesizeCharter(ctx, { facts, answers, established });
    const { weights, floored } = applyTaxonomyFloor(synthesis.weights);
    for (const dimId of floored) {
      ctx.log.warn(`Taxonomy floor applied: ${dimId} weight corrected to 1 (D5)`);
    }
    const { meta, body } = assembleCharter({
      synthesis: { ...synthesis, weights },
      floored,
      established,
      headSha,
      generatedAt: ctx.now(),
    });
    writeArtifact(ctx.dotdir, LAYOUT.charter, { meta, body });
    parseCharter(serializeFrontmatter(meta, body)); // round-trip guard: floor must hold

    state = addSpend(state, PHASE_ID, ctx.llm.drainSpend());
    state = recordPhase(state, PHASE_ID, { status: "done", sha: headSha, now: ctx.now() });
    state = pinSha(state, PHASE_ID, headSha);

    const decision = (await answerer("Approve charter now? [y/N] > ")).trim().toLowerCase();
    if (decision === "y" || decision === "yes") {
      const approved = approveCharterFile(ctx, state);
      state = approved.state;
      return {
        state,
        gate: { name: "charter", passed: true, human: true, detail: "Charter approved." },
        summary:
          `Charter written to .dobetter/${LAYOUT.charter} and approved ` +
          `(sha256 ${approved.charterSha256.slice(0, 12)}…). Next: do-better audit.`,
      };
    }
    return {
      state,
      gate: { name: "charter", passed: false, human: true, detail: APPROVE_HINT },
      summary: APPROVE_HINT,
    };
  } catch (err) {
    err.state = addSpend(state, PHASE_ID, ctx.llm.drainSpend());
    throw err;
  }
}
