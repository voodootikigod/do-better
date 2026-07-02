// src/refresh.js — idempotent re-run (D6/D9/D10): diff vs pinned SHA, touch only
// changed files, flag stale claims (skill-rot doctrine), re-verify findings,
// behavior-diff regression hook, mark roadmap items done/regressed.
import fs from "node:fs";
import path from "node:path";
import { OpError, GateError, git, gitHeadSha, sha256Hex } from "./utils.js";
import { recordPhase, addSpend, pinSha, recordRoadmapHash } from "./state.js";
import {
  LAYOUT, readArtifact, writeArtifact, readFindings, annotateStale, verifyCitations,
} from "./artifacts.js";
import { withFallback } from "./llm.js";
import { runBehaviorDiff } from "./adlc.js";
import { rerunReproduction, markRoadmapResolved, markRoadmapRegressed } from "./roadmap.js";

export const PHASE_ID = "refresh";
const BEHAVIOR_CONFIG = "tmp/behavior.json";
const BEHAVIOR_BEFORE = "tmp/behavior-before.json";
const BEHAVIOR_AFTER = "tmp/behavior-after.json";
const NO_DIFF_NOTE = "behavior-diff unavailable — boundary regressions not checked";

export function changedFilesSince(root, pinnedSha, exec) {
  const diff = git(root, ["diff", "--name-only", `${pinnedSha}..HEAD`], exec);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"], exec);
  const all = [...diff.split("\n"), ...untracked.split("\n")].map((s) => s.trim()).filter(Boolean);
  return [...new Set(all)].sort();
}

function patchPhase(state, patch) {
  return { ...state, phases: { ...state.phases, [PHASE_ID]: { ...state.phases[PHASE_ID], ...patch } } };
}

function finishState(state, ctx, { headSha, status, changedFiles, staleClaims }) {
  let next = addSpend(state, PHASE_ID, ctx.llm.drainSpend());
  next = recordPhase(next, PHASE_ID, { status, sha: headSha, now: ctx.now() });
  next = patchPhase(next, { changedFiles, staleClaims });
  if (status === "done") next = pinSha(next, PHASE_ID, headSha);
  return next;
}

function gateFail(state, gate, detail) {
  const err = new GateError(`${gate}: ${detail}`, detail);
  err.gate = gate;
  err.detail = detail;
  err.state = state;
  return err;
}

function coerceJson(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw).replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim()); }
  catch { return null; }
}

const STALE_SCOPE = (file) => !file.startsWith(".dobetter/");

function repinText(text, changedSet, sha7) {
  return String(text ?? "").replace(
    /([A-Za-z0-9_][A-Za-z0-9_.\/-]*):(\d+)@([0-9a-f]{7,40})/g,
    (full, file, line) => (changedSet.has(file) ? `${file}:${line}@${sha7}` : full),
  );
}

// 3. stale-claim flagging across comprehension artifacts (never trust, always flag)
function flagStaleArtifacts(ctx, changedSet, pinnedSha) {
  let staleCount = 0;
  for (const rel of Object.values(LAYOUT.comprehension)) {
    const art = readArtifact(ctx.dotdir, rel);
    if (!art) continue;
    const res = annotateStale(art.body, { changedFiles: [...changedSet], asOfSha: pinnedSha, now: ctx.now() });
    if (res.staleCount > 0) {
      writeArtifact(ctx.dotdir, rel, { meta: art.meta, body: res.body });
      staleCount += res.staleCount;
    }
  }
  return staleCount;
}

// 4. targeted re-scan: cheap tier, changed files only (D10)
async function refreshCodemap(ctx, changed, pinnedSha) {
  const art = readArtifact(ctx.dotdir, LAYOUT.comprehension.codemap);
  if (!art) return;
  const note = await withFallback(ctx.llm, {
    prompt: [
      "These files changed since the pinned comprehension SHA. For each, give a one-line",
      "purpose update for the codemap. Return plain markdown bullets only.",
      `Pinned: ${pinnedSha}`,
      ...changed.map((f) => `- ${f}`),
    ].join("\n"),
    tier: "cheap",
    label: "codemap",
  }, () => changed.map((f) => `- ${f} (structure-only)`).join("\n"));
  const marker = "## Refresh notes";
  const section = `${marker}\n\nChanged since \`${String(pinnedSha).slice(0, 7)}\` @ ${ctx.now()}:\n\n${String(note).trim()}\n`;
  const base = art.body.includes(marker)
    ? art.body.slice(0, art.body.indexOf(marker)).replace(/\n+$/, "\n")
    : `${art.body.replace(/\n+$/, "")}\n`;
  writeArtifact(ctx.dotdir, LAYOUT.comprehension.codemap, { meta: art.meta, body: `${base}\n${section}` });
}

// 4b. behavior-inventory entries citing changed files: re-verify citations
function reverifyInventory(ctx, changedSet) {
  const art = readArtifact(ctx.dotdir, LAYOUT.comprehension.behaviorInventory);
  if (!art) return 0;
  let broken = 0;
  for (const line of art.body.split("\n")) {
    const cites = (line.match(/[A-Za-z0-9_][A-Za-z0-9_.\/-]*:\d+@[0-9a-f]{7,40}/g) ?? [])
      .map((s) => { const m = s.match(/^(.*):(\d+)@([0-9a-f]+)$/); return { file: m[1], line: Number(m[2]), sha: m[3] }; })
      .filter((c) => changedSet.has(c.file));
    if (!cites.length) continue;
    broken += verifyCitations(ctx.root, cites, ctx.exec).failed.length;
  }
  if (broken) ctx.log.warn(`${broken} behavior-inventory citation(s) no longer verify — entries flagged stale.`);
  return broken;
}

// 5. re-verify stale findings (reproduce again, or kill the claim's staleness)
async function reverifyFindings(ctx, changedSet, headSha) {
  const sha7 = headSha.slice(0, 7);
  const resolvedIds = [];
  let staleFlagged = 0;
  for (const finding of readFindings(ctx.dotdir)) {
    const cited = (finding.evidence ?? []).some((c) => changedSet.has(c.file));
    if (!cited) continue;
    staleFlagged += 1;
    const rel = `${LAYOUT.findingsDir}/${finding.id}.md`;
    const art = readArtifact(ctx.dotdir, rel);
    if (!art) continue;
    const annotated = annotateStale(art.body, { changedFiles: [...changedSet], asOfSha: ctx.state.pins?.[PHASE_ID] ?? headSha, now: ctx.now() }).body;
    let verdict = null; // "resolved" | "verified" | null (stays stale)
    if (finding.reproduction?.method === "reread") {
      const raw = await withFallback(ctx.llm, {
        prompt: [
          "Re-verdict this previously verified finding against the CURRENT cited code slice.",
          'Return ONLY JSON {"verdict":"CONFIRM"|"KILL"|"UNCERTAIN"}.',
          "Claim:", finding.title,
          "Evidence:", JSON.stringify(finding.evidence),
        ].join("\n"),
        tier: "frontier",
        label: "verdict",
        jsonMode: true,
      }, () => null);
      const v = coerceJson(raw)?.verdict;
      if (v === "CONFIRM") verdict = "verified";
      else if (v === "KILL") verdict = "resolved";
    } else {
      const r = rerunReproduction(ctx.root, finding, ctx.exec);
      if (r.reproduced === true) verdict = "verified";
      else if (r.reproduced === false) verdict = "resolved";
    }
    if (verdict === "resolved") {
      const body = `${annotated.replace(/\n+$/, "\n")}\n> RESOLVED @ ${sha7} (${ctx.now()}): reproduction no longer reproduces.\n`;
      writeArtifact(ctx.dotdir, rel, { meta: { ...art.meta, stale: true }, body });
      resolvedIds.push(finding.id);
    } else if (verdict === "verified") {
      const evidence = Array.isArray(art.meta.evidence)
        ? art.meta.evidence.map((e) => (typeof e === "string" ? e.replace(/@[0-9a-f]{7,40}/, `@${sha7}`) : { ...e, sha: sha7 }))
        : art.meta.evidence;
      const body = repinText(annotated, changedSet, sha7);
      writeArtifact(ctx.dotdir, rel, { meta: { ...art.meta, evidence, stale: false, headSha }, body });
    } else {
      writeArtifact(ctx.dotdir, rel, { meta: { ...art.meta, stale: true }, body: annotated });
    }
  }
  return { resolvedIds, staleFlagged };
}

// 6. behavior-diff regression detection (declared degradation when unavailable)
function behaviorDiffStep(ctx) {
  const cfg = path.join(ctx.dotdir, BEHAVIOR_CONFIG);
  const before = path.join(ctx.dotdir, BEHAVIOR_BEFORE);
  if (!fs.existsSync(cfg) || !fs.existsSync(before)) {
    return { note: `${NO_DIFF_NOTE} (no captured baseline)`, regressions: null };
  }
  const after = path.join(ctx.dotdir, BEHAVIOR_AFTER);
  const cap = runBehaviorDiff(ctx.adlc, "capture", ["--config", cfg, "--out", after, "--json"], { cwd: ctx.root, exec: ctx.exec });
  if (cap.skipped) return { note: NO_DIFF_NOTE, regressions: null };
  if (!cap.ok) return { note: "behavior-diff capture failed — boundary regressions not checked", regressions: null };
  const cmp = runBehaviorDiff(ctx.adlc, "compare", [before, after, "--json"], { cwd: ctx.root, exec: ctx.exec });
  if (cmp.skipped) return { note: NO_DIFF_NOTE, regressions: null };
  if (!cmp.gateFailed) return { note: "behavior-diff: no boundary regressions detected", regressions: [] };
  const raw = cmp.json?.changed ?? cmp.json?.differences ?? cmp.json?.regressions ?? [];
  const regressions = (Array.isArray(raw) ? raw : []).map((r) => (typeof r === "string" ? r : r?.id ?? r?.name ?? JSON.stringify(r)));
  return { note: `behavior-diff: ${regressions.length} changed behavior(s)`, regressions };
}

export async function run(ctx) {
  const { root, dotdir, log } = ctx;
  let state = ctx.state;
  const pinned = state?.pins?.comprehend ?? state?.pins?.scan;
  if (!pinned) {
    throw new OpError("Nothing to refresh — no completed phase pins in state.json. Run `do-better scan` first.");
  }
  const headSha = gitHeadSha(root, ctx.exec);
  const changed = changedFilesSince(root, pinned, ctx.exec);
  if (!changed.length) {
    state = finishState(state, ctx, { headSha, status: "done", changedFiles: 0, staleClaims: 0 });
    return {
      state,
      gate: null,
      summary: `Fresh @ ${headSha.slice(0, 7)} — no files changed since pinned ${String(pinned).slice(0, 7)}.`,
    };
  }
  const changedSet = new Set(changed.filter(STALE_SCOPE));

  // 3. flag stale claims
  let staleClaims = flagStaleArtifacts(ctx, changedSet, pinned);
  // 4. targeted re-scan, changed files only
  await refreshCodemap(ctx, [...changedSet], pinned);
  reverifyInventory(ctx, changedSet);
  // 5. re-verify stale findings
  const { resolvedIds, staleFlagged } = await reverifyFindings(ctx, changedSet, headSha);
  staleClaims += staleFlagged;

  // 7. roadmap living-document update
  let roadmap = readArtifact(dotdir, LAYOUT.roadmap);
  if (roadmap) {
    let body = roadmap.body;
    for (const id of resolvedIds) body = markRoadmapResolved(body, id, headSha);
    if (body !== roadmap.body) {
      writeArtifact(dotdir, LAYOUT.roadmap, { meta: roadmap.meta, body });
      roadmap = { ...roadmap, body };
      const raw = fs.readFileSync(path.join(dotdir, LAYOUT.roadmap), "utf8");
      state = recordRoadmapHash(state, { sha256: sha256Hex(raw), headSha, now: ctx.now() });
    }
  }

  // 6. behavior-diff regression hook (may gate-fail → exit 2)
  const diff = behaviorDiffStep(ctx);
  if (diff.regressions && diff.regressions.length) {
    if (roadmap) {
      let body = roadmap.body;
      for (const beh of diff.regressions) {
        if (body.includes(beh)) continue; // a roadmap item already claims this behavior change
        body = markRoadmapRegressed(body, beh, "boundary behavior changed with no roadmap item claiming it");
      }
      if (body !== roadmap.body) {
        writeArtifact(dotdir, LAYOUT.roadmap, { meta: roadmap.meta, body });
        const raw = fs.readFileSync(path.join(dotdir, LAYOUT.roadmap), "utf8");
        state = recordRoadmapHash(state, { sha256: sha256Hex(raw), headSha, now: ctx.now() });
      }
    }
    state = finishState(state, ctx, { headSha, status: "failed", changedFiles: changed.length, staleClaims });
    throw gateFail(state, "refresh", `behavior-diff compare failed: ${diff.regressions.join(", ")} — boundary behavior changed without a claiming roadmap item`);
  }

  state = finishState(state, ctx, { headSha, status: "done", changedFiles: changed.length, staleClaims });
  const resolvedNote = resolvedIds.length ? `; resolved: ${resolvedIds.join(", ")} (marked ✅ done)` : "";
  log.info(diff.note);
  return {
    state,
    gate: null,
    summary: `Refreshed @ ${headSha.slice(0, 7)}: ${changed.length} changed file(s), ${staleClaims} stale claim(s) flagged${resolvedNote}; ${diff.note}.`,
  };
}
