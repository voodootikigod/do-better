# Roadmap Template — `.dobetter/ROADMAP.md` (D3 output)

The executive deliverable. Dual artifact, one source of truth: every item here
maps to verified findings (`findings/F-*.md`) and Now/Next items map to backlog
tickets. It is a **living document** — idempotent re-runs reconcile prior state
and move items into Done / Regressed rather than regenerating from scratch.

```markdown
---
generatedAt: <ISO 8601 timestamp>
headSha: <40-hex repo HEAD this roadmap was generated against>
basedOnFindings: <count of verified findings consumed>
approved: false
---

# Technical Roadmap — <repo name>

## Executive summary

<3–6 sentences: the state of the codebase against the charter, the top risks,
what Now buys, and what was consciously declined. No item lists here —
judgment, written for a stakeholder who reads nothing else.>

## Phase 0 — Rails & runnability

<Items that must precede all change: environment fixes (preflight red →
"Make the environment runnable"), and characterization-rail prerequisites.
Empty phase must say "None required — environment runnable, rails in place.">

<!-- Item shape, used in every phase section: -->
- **<title>** (T<id> · score <weighted score> · <severity>)
  - Evidence: <links to findings files, e.g. [F-SEC-0003](findings/F-SEC-0003.md)>
  - Risk of inaction: <one concrete sentence>

## Now

<Quick wins first (score ≥ 1.5, effort S), then highest-scored
dependency-feasible items. Each item: title, finding links, score,
risk-of-inaction.>

## Next

<Same item shape. Items here have tickets too; items demoted by coldstart
failures land in Later, flagged.>

## Later

<Same item shape, lighter detail allowed. Includes coldstart-demoted tickets,
flagged `coldstart: failed`.>

## Done / Regressed

<Living-document ledger. `✅ done — <title> (resolved @ <sha>)` for items whose
findings no longer reproduce; `⚠ regressed — <title> (re-verified @ <sha>)` for
previously-done items whose finding came back, and for retained behaviors that
changed with no roadmap item claiming the change. Empty on first run.>

## Declined

<Every finding that did not become a roadmap item: title, finding link, reason
(explicit declineReason or score < 0.3), and a risk-of-inaction line. Nothing
is silently dropped — an empty section must state "Nothing declined.">
```

Approval: human gate 2. Review this file and `backlog/`, edit freely (edits are
re-hashed, not rejected), then `do-better roadmap --approve`. Approval requires
the coldstart gate clean.
