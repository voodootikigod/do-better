# do-better — Specification

> Point an agent at an existing codebase and ask: *what should be better here,
> in what order, and how do we prove we didn't break anything?* Then produce a
> defensible technical roadmap — not vibes, verified findings.

**Charter:** comprehension → fault/improvement identification → technical
roadmap, for existing codebases ("just do better" work, not new-feature build).
Sibling to [skill-mining](../skill-mining) (extracts latent *knowledge*) and
[aidlc](../aidlc) (executes builds). do-better produces *judgment + plan*, and
is the **brownfield front-end to the ADLC**.

Decisions below were resolved by stakeholder interrogation (grill-me, 2026-06-11).

---

## 1. Locked Decisions

| # | Decision | Resolution |
|---|----------|-----------|
| D1 | Charter boundary | **(b) Analysis + roadmap + rails.** No fix execution — that is ADLC's job. Output: comprehension artifacts, verified findings, prioritized roadmap, characterization rails. Each roadmap item hands off to ADLC P3/P4 as a ticket. |
| D2 | Audience | **Design for enterprise deliverable, degrade gracefully to personal use.** Stakeholder-readable roadmap with evidence citations + machine-readable backlog. Provider-pluggable (Anthropic default; Gemini/OpenAI/local) for customer data-governance constraints. |
| D3 | Form factor | **Standalone sibling repo.** Dual mode like skill-mining: `SKILL.md` (cross-harness) + `npx do-better` CLI. Composes with skill-mining (comprehension sub-step) and aidlc (ticket intake + reused packages: `parallax`, `coldstart`, `hollow-test`, `behavior-diff`, `preflight`, skill-rot doctrine). |
| D4 | Comprehension artifacts | **All 7** (codemap, architecture narrative, behavior inventory, dependency surface, test/rails map, domain glossary, mined skills). **Behavior inventory is the keystone** — denominator for "retain existing functionality." Verified via parallax-style N fresh-context readings; divergence = confusion-finding or hallucination; converged claims spot-checked with file:line citations. Gate: divergence below threshold + human skim. |
| D5 | Definition of "better" | **(c) Fixed taxonomy floor + per-engagement quality charter.** Taxonomy: correctness risk, security, maintainability/debt, performance, operability, test quality, dependency health, DX. Charter (stakeholder interview) weights dimensions and adds engagement-specific ones. Taxonomy floor prevents charter blind spots. |
| D6 | Roadmap shape | **Dual artifact, one source of truth.** `ROADMAP.md` (executive: Now/Next/Later phases, evidence-cited, risk-of-inaction, declined-items section) + machine-readable backlog (ADLC-P2-shaped tickets, cold-start tested). Score = impact × confidence ÷ effort (t-shirt + explicit confidence); dependency-sequenced; rails-first Phase 0; quick wins front-loaded. **Living document** — idempotent re-runs diff prior state, mark done/regressed. |
| D7 | Rails | **(b) Roadmap-scoped** — characterization rails only for behaviors Phase-Now/Next items touch; inventory annotated for rail-coverage gaps. Boundary-level golden-master/approval style (HTTP, CLI, DB writes), bug-compatible pinning. Authored fresh-context, `hollow-test` audited, frozen. If env not runnable: preflight gate red → "make it runnable" becomes Phase 0 roadmap item itself. |
| D8 | Pipeline | **D-1 quick scan → D0 charter → D1 comprehend → D2 identify → D3 roadmap → D4 rail.** Thin cheap scan precedes charter so interview questions cite actual code facts. Two human gates only: charter approval (D0) and roadmap approval (D3). All other gates deterministic/threshold. |
| D9 | Artifacts + CLI | Committed `.dobetter/` dir in target repo (see §3). Phase-per-command CLI + orchestrator + `refresh` (see §4). Resumable across multi-day human-gate pauses. |
| D10 | Scale/cost | Model tiering by cost-of-detecting-error (cheap scan / mid finders / frontier judgment). Charter-weighted depth with **explicit coverage manifest** — declared sampling, never silent. `--budget` flag, per-phase spend in state.json, refresh reads only files changed since pinned SHA. |
| D11 | Success metric | **Ticket quality**: % of roadmap items accepted into execution without ticket rework + zero retained-functionality regressions traced to rails gaps. Refused vanity metric: findings count. |
| D12 | Name | `do-better` (npm name available). |

Defaults taken without interrogation: Node/TypeScript (matches skill-mining),
MIT license.

---

## 2. Lifecycle

```
D-1 Scan         cheap model; codemap + incantations + sizes; feeds informed charter questions
D0  Charter      interrogate stakeholder: pain, 12-month intent (stabilize/scale/extend/hand off),
                 constraints; questions cite D-1 facts ("CI takes 40min — pain point?")
                 GATE: human approves charter ............................. [HUMAN GATE 1]
D1  Comprehend   parallax N fresh-context readings → 7 artifacts; skill-mining sub-step;
                 every claim file:line + SHA-pinned
                 GATE: divergence < threshold + human skim
D2  Identify     per-dimension refute-chartered finders, fresh contexts, loop-until-dry
                 (K=2 consecutive dry passes); adversarial verification — every finding
                 reproduced or killed; unverified findings never reach output
                 GATE: dry + zero unverified findings
D3  Roadmap      score, dependency-sequence, phase; quick wins forward; declined items listed;
                 tickets cold-start tested
                 GATE: coldstart clean + human approves roadmap ........... [HUMAN GATE 2]
D4  Rail         characterization rails for Phase-Now items; preflight env check first
                 GATE: rails green against current code + hollow-test audit
→   Handoff      each ticket → ADLC P3/P4. Re-run D1–D3 idempotently as living doc.
```

Model failure modes defended (ADLC flaw inventory): F1 via machine-checkable
ticket acceptance criteria; F2/E4 via fresh-context refute-chartered finders
and verification separated from finding; F3 via parallax partitioning; F4 via
evidence-or-it-didn't-happen citations + reproduce-or-kill; F5 via frozen
hollow-test-audited rails; F6 via loop-until-dry.

---

## 3. Artifact Layout (committed in target repo)

```
.dobetter/
  charter.md            # D0 output, human-approved; dimension weights
  comprehension/
    codemap.md
    architecture.md     # intended design vs actual drift
    behavior-inventory.md   # KEYSTONE — observable behaviors: routes, jobs, CLIs, events
    dependencies.md     # versions, EOL/CVE, coupling hotspots
    rails-map.md        # covered vs load-bearing-but-untested
    glossary.md         # business terms ↔ code terms
    coverage-manifest.md    # deep-read X%, scanned Y% — declared, never silent
  findings/             # one file per verified finding; file:line + commit-SHA evidence,
                        # dimension, severity, reproduction record
  ROADMAP.md            # executive deliverable
  backlog/              # ADLC-shaped tickets: motivation→findings links, acceptance
                        # criteria w/ named verification method, rails deps, partition hints
  rails/manifest.md     # pointers — actual tests live in the repo's test tree
  state.json            # run history, SHA pins, per-phase spend, prior-roadmap hashes
```

All claims pinned to commit SHA. `refresh` detects drift; stale claims are
flagged, not trusted (skill-rot doctrine: a stale claim is misinformation with
the voice of authority).

---

## 4. CLI

```
npx do-better scan        # D-1
npx do-better charter     # D0 — interactive stakeholder interview
npx do-better audit       # D1 + D2
npx do-better roadmap     # D3
npx do-better rail        # D4
npx do-better run         # full pipeline; stops at human gates
npx do-better refresh     # idempotent re-run; diffs vs state.json; only changed files
```

Flags: `--provider anthropic|gemini|openai` (skill-mining pattern), `--budget`,
`--offline` (degrades to static analysis + structure-only artifacts).

Phase-per-command is required, not convenience: enterprise engagements pause
days at human gates; state.json makes every phase resumable.

---

## 5. Composition Contracts

- **skill-mining**: invoked during D1; mined skills are comprehension artifacts
  and ride along for the execution phase.
- **aidlc**: backlog tickets conform to ADLC P2 ticket shape (atomic, fresh-agent
  executable, contracts explicit, coldstart-tested). Rails conform to P3
  doctrine (separate context, frozen, hollow-audited). Reused packages:
  `parallax` (D1 divergence), `coldstart` (D3 gate), `hollow-test` (D4 gate),
  `preflight` (D4 env check), `behavior-diff` (refresh regression detection).
- **grill-me**: D0 charter interview is grill-me with a codebase-check clause,
  seeded by D-1 facts.

---

## 6. Model Tiering (cost of detecting error, not prestige)

| Tier | Phases | Why safe |
|------|--------|----------|
| Cheap (Haiku-class) | D-1 scan, codemap, dependency inventory, coldstart probes | Mechanical; errors caught instantly and deterministically |
| Mid (Sonnet-class) | D2 finders, D1 readers, D4 rail drafting | Adversarial verification + hollow-test catch their errors |
| Frontier | D0 charter synthesis, D2 finding verdicts, D3 roadmap judgment | Errors here sail through every gate undetected |

---

## 7. Success Metrics

1. **Ticket survival rate** — % of backlog items accepted into execution
   without reworking the ticket itself.
2. **Zero retained-functionality regressions** traced to rails gaps.
3. Refused: findings count, roadmap length, artifact volume — all vanity.
