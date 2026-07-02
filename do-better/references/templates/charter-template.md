# Charter Template — `.dobetter/charter.md` (D0 output)

Fill every placeholder. The frontmatter keys and shapes below are a contract:
`parseCharter` validates them, and the taxonomy floor (D5) requires **all 8
dimension ids present with weight 1–5** — a dimension the interview didn't
prioritize gets weight 1 with a `(floor)` note in the rationale, never removed.

Frontmatter uses the zero-dependency subset: flat scalars, inline arrays of
scalars, one level of nesting. Each `extraDimensions` entry is a single
pipe-delimited scalar string `id|Label|weight` (e.g. `ci-reliability|CI
reliability|4`); the list is empty when the engagement adds none.

```markdown
---
approved: false
headSha: <40-hex sha the interview facts were drawn from>
generatedAt: <ISO 8601 timestamp>
intent: <stabilize | scale | extend | handoff>
weights:
  correctness: <1-5>
  security: <1-5>
  maintainability: <1-5>
  performance: <1-5>
  operability: <1-5>
  test-quality: <1-5>
  dependency-health: <1-5>
  dx: <1-5>
extraDimensions: [<id|Label|weight>, ...]
---

# Engagement Charter — <repo name>

## Pain

<What hurts today, in the stakeholder's words. One bullet per pain point, each
tied where possible to a scan fact that evidences it
(`path/to/file.js:123@a1b2c3d`).>

## Intent

<The 12-month intent — stabilize, scale, extend, or hand off — and what that
implies for prioritization. One short paragraph.>

## Constraints

<Hard constraints the roadmap must respect: freeze windows, compliance,
budgets, no-touch areas, team capacity. One bullet each. "None stated" is a
valid entry — absence must be explicit.>

## Dimension weights

<One bullet per taxonomy dimension, in canonical order: the weight, and one
sentence of rationale citing the interview answer or scan fact that justifies
it. Floor-corrected dimensions read: "1 (floor) — not prioritized by
stakeholder; retained per taxonomy floor.">

## Established from the codebase

<Questions answered deterministically from D-1 scan facts instead of asked —
each as "Q → answer, evidence: <citation or scan fact>". Empty section allowed
but must be present.>

## Engagement dimensions

<One bullet per extra dimension: id, label, weight, and why this engagement
needs it beyond the fixed taxonomy. "None" if extraDimensions is empty.>
```

Approval: a human reviews and edits this file, then approves (interactively at
the end of the interview, or later via `do-better charter --approve`). Approval
hashes the file; the hash is the anchor every downstream phase trusts.
