# Roadmap Scoring & Sequencing — D3 Rubric

The frontier model **proposes** per-finding attributes; deterministic code
**computes** scores and order. Judgment supplies inputs; arithmetic is never
delegated to a model.

## Per-finding attributes (frontier proposes)

For every verified finding, the model assigns:

| Attribute | Values | Meaning |
|---|---|---|
| `impact` | S / M / L / XL | how much better the system gets if addressed |
| `effort` | S / M / L / XL | cost to address, including verification |
| `confidence` | 0..1 | how sure we are the fix delivers the impact |
| `dependsOn` | finding ids | what must land first |
| `railsNeeded` | true/false | whether characterization rails must exist before touching it |
| `declineReason` | string (optional) | why this should NOT be done (conflicts with charter intent/constraints) |

Reconciliation is **by id**: findings the model omits get conservative defaults
`impact: M, effort: M, confidence: 0.5` — never dropped. Nothing silently
disappears between findings and roadmap.

## T-shirt tables

| Size | Impact value | Effort value |
|---|---|---|
| S | 1 | 1 |
| M | 2 | 2 |
| L | 3 | 3 |
| XL | 5 | 5 |

## The score

```
score = impact × confidence ÷ effort
```

then weighted by the approved charter (D0):

```
weighted = score × (charterWeight[dimension] / 3)
```

A weight of 3 is neutral; the floor guarantees every dimension has weight ≥ 1,
so no dimension can be zeroed out of the roadmap — only de-emphasized.

Worked example: a `high` security finding, impact L (3), confidence 0.8,
effort M (2), security charter weight 5:
`3 × 0.8 ÷ 2 = 1.2`, weighted `1.2 × (5/3) = 2.0`.

## Thresholds (deterministic)

| Rule | Threshold |
|---|---|
| Quick win (front-loaded into Now) | weighted score ≥ 1.5 AND effort = S |
| Declined (listed, never silently dropped) | weighted score < 0.3, or explicit `declineReason` |
| Phase bands | Now / Next / Later by descending score, subject to dependency feasibility |

## Sequencing rules (deterministic)

1. **Topological order** on `dependsOn` — an item never appears before its
   prerequisites.
2. **Rails-first Phase 0**: environment-fix items (preflight red → "make it
   runnable") and rail-prerequisite items (`railsNeeded` ancestors) come before
   everything. You don't refactor what you can't run, and you don't change what
   you can't pin.
3. **Quick wins forward**: qualifying items lead the Now phase — early visible
   value buys trust for the long items.
4. **Score bands** fill Now → Next → Later, demoting items whose dependencies
   sit in a later band.
5. **Cycles**: break the lowest-weighted-score edge in the cycle and warn. A
   cycle is a planning bug, not a reason to halt.

## Declined items (D6)

Every finding that does not become a roadmap item appears in the roadmap's
`## Declined` section with its reason **and a risk-of-inaction line**. A
stakeholder must be able to see what was consciously not done and what that
choice costs. Silent omission is the failure mode this section exists to kill.

## Ticket derivation

Each Now and Next item becomes one ADLC-P2-shaped ticket
([templates/ticket-template.md](./templates/ticket-template.md)): self-contained
body, motivation linking back to `findings/F-*.md`, machine-verifiable
acceptance criteria each naming its verification method, scope globs, rails
paths, dependency edges with contract files. Tickets are **cold-start tested**
(D6 gate): a fresh agent with only the ticket must be able to execute it. Gaps
are repaired up to 2 rounds; a ticket still gapped is demoted to Later — and if
any Now/Next ticket remains gapped, the roadmap gate fails (exit 2).

## What scoring refuses to optimize

Findings count, roadmap length, and artifact volume are vanity metrics (D11).
The score exists to maximize **ticket survival rate** — items accepted into
execution without rework — and to keep retained functionality intact. A shorter
roadmap with higher ticket survival beats a longer one every time.
