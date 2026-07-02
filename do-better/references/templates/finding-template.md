# Finding Template — `.dobetter/findings/F-<DIM>-NNNN.md` (D2 output)

One file per **verified** finding. Unverified candidates are killed, never
written — if a file exists in `findings/`, it survived reproduce-or-kill
([../verification.md](../verification.md)). The id embeds the dimension
(first 4 letters, uppercase) and a zero-padded sequence: `F-SEC-0003`,
`F-CORR-0012`.

Frontmatter shapes are a contract (`readFindings` parses them). `evidence` is
an inline array of canonical citation strings `path:line@sha`; `reproduction`
is one level of nesting; `stale` is written `false` here and only ever flipped
by `refresh`, never by identify.

```markdown
---
id: F-<DIM>-NNNN
dimension: <correctness|security|maintainability|performance|operability|test-quality|dependency-health|dx|<extra-dimension-id>>
title: <short imperative summary>
severity: <critical|high|medium|low>
confidence: <0..1>
evidence: [<path/to/file.js:123@a1b2c3d>, ...]
reproduction:
  method: <command|reread|static>
  record: <command + captured output, or blind-reread verdict rationale; single line, escaped>
  exitCode: <integer or null>
status: verified
foundAt: <ISO 8601 timestamp>
headSha: <40-hex repo HEAD at verification time>
stale: false
---

# <title>

## Claim

<One paragraph: what is wrong, why it matters on this dimension, what triggers
it. Plain language a stakeholder can read.>

## Evidence

<One bullet per citation: the citation (`path/to/file.js:123@a1b2c3d`) plus a
one-line quote or description of what that location shows. Every bullet's
citation must verify deterministically — file exists, line in range.>

## Reproduction record

<The full reproduction: for `command`, the exact command, its stdout/stderr,
and exit code; for `reread`, the blind verifier's CONFIRM rationale; for
`static`, the deterministic check and its result. This record is what refresh
re-runs to decide resolved-vs-still-present.>

## Impact

<What happens if nothing is done — the risk-of-inaction in concrete terms.
Feeds the roadmap's risk-of-inaction line.>
```
