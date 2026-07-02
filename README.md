# do-better

> Point an agent at an existing codebase and ask: *what should be better here,
> in what order, and how do we prove we didn't break anything?* Then produce a
> defensible technical roadmap — not vibes, **verified findings**.

**do-better** is comprehension → fault/improvement identification → technical
roadmap, for existing codebases — the "just do better" work, not new-feature
build. It is a sibling to
[skill-mining](https://github.com/voodootikigod/skill-mining) (extracts latent
*knowledge* from a repo) and [aidlc](https://github.com/voodootikigod/aidlc)
(executes builds): do-better produces *judgment + plan*, and is the
**brownfield front-end to the ADLC**. It never executes fixes — each roadmap
item hands off to ADLC P3/P4 as a cold-start-tested ticket.

What makes the output defensible:

- Every claim carries a `file:line@sha` citation, verified deterministically
  and pinned to a commit SHA. Stale claims are flagged, never trusted.
- Every finding survived **reproduce-or-kill** adversarial verification —
  unverified findings never reach output.
- Sampling is **declared, never silent** — the coverage manifest states what
  was deep-read, scanned, and skipped.
- The roadmap lists what was **declined** and the risk of inaction, not just
  what made the cut.

Dual mode, like skill-mining: a cross-harness skill
([`do-better/SKILL.md`](do-better/SKILL.md)) any agent harness can run
manually, plus an `npx do-better` CLI that automates the same lifecycle with
the same gates.

## Install

```bash
# Zero-install (recommended)
npx do-better run

# Or as a cross-harness agent skill
npx skills add voodootikigod/do-better
```

Set an LLM key (Anthropic default; Gemini, OpenAI, and local endpoints supported):

```bash
export ANTHROPIC_API_KEY="..."      # default, detected first
# or: export GEMINI_API_KEY="..."   # with --provider gemini
# or: export OPENAI_API_KEY="..."   # with --provider openai
# or (data-governance / air-gapped): any OpenAI-compatible local server
#   export DOBETTER_LOCAL_BASE_URL="http://localhost:11434/v1"   # e.g. Ollama
#   export DOBETTER_LOCAL_MODEL="qwen2.5-coder"                  # with --provider local
```

No key at all? `--offline` degrades to static analysis and structure-only
artifacts — every degradation declared, never silent.

Requires Node >= 18 and a **git repository** as the target (claims are
SHA-pinned; no git, no run). Zero runtime dependencies.

## The loop

```
D-1 Scan ──▶ D0 Charter ──▶ D1 Comprehend ──▶ D2 Identify ──▶ D3 Roadmap ──▶ D4 Rail ──▶ Handoff
 cheap facts   interview +     7 artifacts,      refute-chartered  score/sequence/  pin behavior   tickets →
 + codemap     weights         parallax-checked  finders + verify  ticket           with rails     ADLC P3/P4
               [HUMAN GATE 1]  divergence gate   dry + 0-unverified coldstart gate + rails green +
                                                                    [HUMAN GATE 2]   hollow audit

                        ↻ refresh — idempotent living-document re-run (only changed files)
```

Exactly **two human gates**: charter approval and roadmap approval. Everything
else is deterministic or threshold-based. Enterprise engagements pause for days
at human gates; `state.json` makes every phase resumable, so a pause costs
nothing.

## Usage

```bash
npx do-better scan        # D-1  — cheap repo scan: facts, incantations, codemap draft
npx do-better charter     # D0   — interactive stakeholder interview, seeded by scan facts
npx do-better charter --approve   # approve the (possibly edited) charter   [HUMAN GATE 1]
npx do-better audit       # D1+D2 — comprehend (7 artifacts) + identify (verified findings)
npx do-better roadmap     # D3   — score, sequence, tickets, coldstart gate
npx do-better roadmap --approve   # approve the (possibly edited) roadmap   [HUMAN GATE 2]
npx do-better rail        # D4   — characterization rails + hollow-test audit
npx do-better run         # full pipeline; stops cleanly at human gates, resumes after --approve
npx do-better refresh     # idempotent re-run; diffs vs pinned SHA; only changed files
```

### Flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--provider anthropic\|gemini\|openai\|local` | all | Force the LLM provider. Default: env autodetect, Anthropic first (a configured `DOBETTER_LOCAL_BASE_URL` is detected last). `local` targets any OpenAI-compatible endpoint (`DOBETTER_LOCAL_BASE_URL` + `DOBETTER_LOCAL_MODEL`). A named provider without its key/URL is an error — never a silent fallback. |
| `--budget <usd>` | all | Hard USD ceiling. A call that would exceed it refuses and stops with resume instructions; per-phase spend lives in `state.json`. |
| `--offline` | all | No LLM calls — static analysis + structure-only artifacts, every degradation declared. |
| `--model-cheap <id>` / `--model-mid <id>` / `--model-frontier <id>` | all | Override the model for one tier (see Model tiering). |
| `--target <dir>` | all | Target repo (also the second positional). Default `.`. |
| `--approve` | `charter`, `roadmap` | Approve the human-gated artifact as it stands on disk (post-edit hashes are recorded, not rejected). |
| `--n <N>` / `--threshold <t>` | `audit` | D1 parallax fan width (default 3) **and** the D2 finder-pool ceiling / divergence threshold (default 0.25). In D2, `--n` caps a charter-weighted pool of distinct-lens finders (table below); unset, the D2 pool ceiling is 1 (pooling opt-in). |
| `--yes` | `rail`, others | Skip confirmations (e.g. the rails commit). Never skips the two human gates. |
| `--json` | all | Machine-readable summary on stdout. |
| `-h`, `--help` | all | Help. |

**D2 charter-weighted finder-pool width.** `--n` is the ceiling; each pass fans
that many finders, each under a distinct lens, so "dry" means the codebase is
exhausted rather than that a single context converged:

| Charter weight | Effective pool width |
|---|---|
| 4–5 | `--n` (full width) |
| 2–3 | `max(1, floor(--n / 2))` |
| 1 | `1` (no pooling) |

`--n 1` reproduces the pre-pool single-finder call counts exactly (every
dimension is width 1). Unset, the D2 ceiling is 1; lens rotation across passes
is always on, while the within-pass fan-out is opt-in via `--n`.

### Exit codes

The adlc-universal contract:

| Code | Meaning |
|---|---|
| `0` | Success — **including a clean human-gate pause** with printed resume instructions. |
| `1` | Operational error: bad input, missing file, no provider/key, network or LLM failure after retries, budget exceeded. |
| `2` | Deterministic gate failure: divergence over threshold, a `(dimension × packet)` cell not dry / unverified findings, coldstart gaps unrepaired, rails red, hollow-audit survivor. |

### D2 coverage & sizing `--budget`

D2 no longer rotates a single ≤30 KB window over the deep-read set — it
**partitions the whole set into packets** (every deep-read file lands in exactly
one packet; an oversized file becomes its own truncated singleton) and loops
each `(dimension × packet)` cell until dry. That guarantees every deep-read byte
is actually shown to a finder, but it also means finder calls scale with the
number of packets. After a run, `.dobetter/comprehension/coverage-manifest.md`
gains a **`## D2 finder coverage`** section recording, per dimension, the files
examined, packet count, total passes, and any truncated slices (unreadable
files land under `### Unexamined`).

Finder calls scale as **`dimensions × packets × passes × N`**, so size
`--budget` before a run. For a reference repo of ~8 dimensions and ~5 packets,
with the dry loop settling near its `K_DRY = 2` floor (best case) and its
`MAX_PASSES = 8` cap (worst case):

| Term | Value | Notes |
|---|---|---|
| dimensions | 8 | taxonomy floor (+ any charter extras) |
| packets | ~5 | reference shape; grows with deep-read size / file size |
| passes per cell | 2 – 8 | `K_DRY = 2` when a cell settles immediately; `MAX_PASSES = 8` cap |
| N | `poolN` | finder pool width per pass — a variable here; charter-weighted pooling lands in T2 |
| **finder calls** | **80·N – 320·N** | `8 × 5 × {2‥8} × N`; verification adds ≤1 repro + ≤1 verdict per surviving candidate |

`--budget` is the hard ceiling: a call that would exceed it refuses and stops
with resume instructions, and every finding verified so far is already on disk
(findings are written per candidate, not batched). A same-sha resume skips the
packets already recorded dry — zero re-issued finder calls for them.

### Environment variables

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `OPENAI_API_KEY` | Provider credentials (autodetected in that order). |
| `DOBETTER_ADLC_DIR` | Path to an aidlc checkout for the composed tools (else sibling-dir probe, else `npx @adlc/<tool>`). |
| `DOBETTER_SKILL_MINING_DIR` | Path to a skill-mining checkout (else sibling probe, else `npx skill-mining`). |
| `DOBETTER_ANSWERS` | Path to a JSON `string[]` of scripted charter answers (non-interactive runs, CI, tests). |
| `DOBETTER_DEBUG` | Print stack traces on error. |

## Artifact layout

Everything is committed to the target repo under `.dobetter/`:

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
  findings/             # one file per VERIFIED finding; file:line + commit-SHA evidence,
                        # dimension, severity, reproduction record
  ROADMAP.md            # executive deliverable (Now/Next/Later, declined, risk-of-inaction)
  backlog/              # ADLC-shaped tickets; tickets.json is coldstart-consumable as-is
  rails/manifest.md     # pointers — actual tests live in the repo's test tree
  state.json            # run history, SHA pins, per-phase spend, prior-roadmap hashes
```

The **behavior inventory is the keystone**: it is the denominator for "retain
existing functionality," the scope source for rails, and the baseline for
regression detection on refresh.

## Composition contracts

- **skill-mining** — invoked as a D1 comprehension sub-step; mined skills are
  comprehension artifacts and ride along for the execution phase.
- **aidlc** — `backlog/tickets.json` conforms to the ADLC P2 ticket schema
  (atomic, fresh-agent executable, explicit contracts, coldstart-tested) and is
  consumable by `coldstart --tickets .dobetter/backlog/tickets.json`
  unmodified. Rails conform to P3 doctrine (separate context, frozen,
  hollow-audited). Reused packages: `parallax` (D1 divergence gate),
  `coldstart` (D3 gate), `hollow-test` (D4 audit), `preflight` (D4 env check),
  `behavior-diff` (refresh regression detection).
- **grill-me** — the D0 charter interview is grill-me with a codebase-check
  clause, seeded by D-1 facts: questions cite real scan facts, and anything the
  codebase already answers is established, not asked.

Every composed tool **degrades gracefully and loudly** when absent: parallax →
declared single-reading mode + mandatory human skim; coldstart → native
cheap-tier probe; hollow-test → deletion spot-check; preflight → basic env
probe; behavior-diff → SHA/file-diff staleness only; skill-mining → sub-step
skipped. Each degradation is recorded in `coverage-manifest.md` and the gate
records — weaker is acceptable, silent is not.

## Model tiering

Tiered by **cost of detecting error**, not prestige (override per tier with
`--model-cheap/--model-mid/--model-frontier`):

| Tier | Phases | Why safe |
|---|---|---|
| cheap (Haiku-class) | D-1 scan, codemap draft, dependency inventory, coldstart probes | Mechanical; errors caught instantly and deterministically |
| mid (Sonnet-class) | D1 readers, D2 finders, D4 rail drafting | Adversarial verification + hollow-test catch their errors |
| frontier | D0 charter synthesis, D2 finding verdicts, D3 roadmap judgment | Errors here sail through every gate undetected |

## Success metrics

1. **Ticket survival rate** — % of backlog items accepted into execution
   without reworking the ticket itself.
2. **Zero retained-functionality regressions** traced to rails gaps.

**Refused vanity metrics**: findings count, roadmap length, artifact volume.
A hundred plausible findings are worth less than ten verified ones; do-better's
verification stage exists to kill, and the kill count is diagnostic, not
shameful. If a do-better report impresses by sheer volume, it has failed.

## What's in here

```
do-better/
├── bin/cli.js                    # the CLI (npx do-better)
├── src/                          # phase modules: scan, charter, comprehend, identify,
│                                 # roadmap, rail, refresh + llm/adlc/state/artifacts
├── do-better/
│   ├── SKILL.md                  # the cross-harness skill (the lifecycle itself)
│   └── references/
│       ├── taxonomy.md           # the 8-dimension fixed floor + per-dimension finder charters
│       ├── refute-charter.md     # D2 finder doctrine: adversarial refutation
│       ├── verification.md       # reproduce-or-kill protocol + citation rules
│       ├── scoring.md            # impact × confidence ÷ effort, sequencing rules
│       └── templates/            # charter, finding, roadmap, ticket, rail shapes
└── test/                         # node --test; no network, fake LLM + fake adlc fixtures
```

## License

MIT © 2026 Chris Williams ([@voodootikigod](https://github.com/voodootikigod)).
See [LICENSE](LICENSE).
