---
name: do-better
description: >-
  Analyze an existing (brownfield) codebase and produce a defensible technical
  roadmap: comprehension artifacts, verified findings with file:line evidence,
  a prioritized Now/Next/Later roadmap, ADLC-ready backlog tickets, and
  characterization rails. Use for "what should be better here", "audit this
  codebase", "tech-debt roadmap", "modernization plan", "do better",
  "brownfield analysis", or preparing legacy code for safe agentic execution.
license: MIT
user-invocable: true
keywords: [brownfield, codebase-analysis, roadmap, tech-debt, characterization-tests, findings, adlc, audit]
argument-hint: "[path] [--provider anthropic|gemini|openai] [--budget N] [--offline]"
metadata:
  version: 0.1.0
  author: Chris Williams (@voodootikigod)
  homepage: https://github.com/voodootikigod/do-better
---

# Do Better

**do-better** is the practice of pointing an agent at an existing codebase and
asking: *what should be better here, in what order, and how do we prove we
didn't break anything?* The output is judgment + plan — not vibes, **verified
findings**: every claim carries file:line citations pinned to a commit SHA,
every finding survived reproduce-or-kill verification, and every roadmap item
hands off as a cold-start-tested ticket ready for execution.

do-better is the **brownfield front-end to the ADLC**. It is a sibling to
[skill-mining](https://github.com/voodootikigod/skill-mining) (extracts latent
*knowledge*) and [aidlc](https://github.com/voodootikigod/aidlc) (executes
builds): do-better decides *what* to do and *in what order*, and proves the
ground won't shift while you do it. It never executes fixes — that is ADLC's
job (D1 charter boundary).

This skill is **dual-mode**: any harness can run the workflow below manually,
section by section. The automated path is the CLI — `npx do-better run` — which
executes the same lifecycle with the same gates; the CLI loads this file and
the `references/` documents as its prompt sources, so the two modes cannot
drift. Prefer the CLI when available; use the manual workflow when you have a
harness and a repo but no CLI.

## When to use this skill

- "What should we improve in this codebase, and in what order?"
- "Audit this repo" / "find the tech debt" / "is this codebase healthy?"
- Inheriting or acquiring a codebase: due diligence with evidence.
- Before pointing execution agents (ADLC) at legacy code — produce the
  tickets and the rails first.
- "Make me a modernization / stabilization / handoff plan."
- Re-run after work lands: `refresh` keeps the roadmap a living document.

Do NOT use it for greenfield builds (no code to comprehend) or to actually
apply fixes (D1: analysis + roadmap + rails only — handoff to ADLC P3/P4).

## What you produce (output contract)

Everything lands in a committed `.dobetter/` directory in the target repo:

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
  backlog/              # ADLC-shaped tickets + tickets.json (machine mirror)
  rails/manifest.md     # pointers — actual tests live in the repo's test tree
  state.json            # run history, SHA pins, per-phase spend, prior-roadmap hashes
```

All claims are pinned to commit SHA. Stale claims are **flagged, never
trusted** (skill-rot doctrine: a stale claim is misinformation with the voice
of authority). Mined skills (the 7th comprehension artifact) live where
skill-mining puts them (`.agents/skills/`) and ride along into execution.

## Options

CLI flags (manual mode: treat each as an instruction you honor by hand):

| Flag | Semantics | Fail-closed rule |
|---|---|---|
| `--provider anthropic\|gemini\|openai` | Force LLM provider. Default: autodetect from env, Anthropic first (`ANTHROPIC_API_KEY` → `GEMINI_API_KEY` → `OPENAI_API_KEY`). | Named provider without its key is an error, not a silent fallback. No key at all is an error naming the three env vars and `--offline`. |
| `--budget <usd>` | Hard USD ceiling across all phases; per-phase spend recorded in `state.json`. | Projected overrun **refuses the call and stops** with resume instructions — completed work is preserved, never truncated silently. |
| `--offline` | No LLM calls: static analysis + structure-only artifacts. | Degradations are declared in `coverage-manifest.md` and gate records — never silent. Network/parse failures are NOT downgraded to offline; they fail. |
| `--model-cheap / --model-mid / --model-frontier <id>` | Override one tier's model (see Model tiering). | Model names are validated; shell-metacharacter names are rejected. |
| `--target <dir>` (or 2nd positional) | Target repo. Default `.`. | Must be a git repository — claims are SHA-pinned, so no git means no run. |
| `--approve` | (`charter`, `roadmap`) Approve the human-gated artifact as it now stands on disk. | Approval re-validates: charter must satisfy the taxonomy floor; roadmap requires a clean coldstart gate. |
| `--n <N>` / `--threshold <t>` | (`audit`) D1 parallax fan width (default 3) **and** the D2 finder-pool ceiling / divergence threshold (default 0.25). | Divergence ≥ threshold fails the gate (exit 2) — it is a finding about confusion, not noise to ignore. In D2, `--n` is the *maximum* pool width; the effective width is charter-weighted (table below), so a low-weight dimension never over-fans. Unset, the D2 pool ceiling is **1** (pooling is opt-in; lens rotation across passes is always on). |
| `--yes` | Skip confirmations (e.g. the D4 rails commit). | Never skips the two human gates — those have no bypass flag, by design. |
| `--json` | Machine summary on stdout. | — |

**D2 charter-weighted pool width** (fan `N` distinct-lens finders per pass, so
"dry" means the codebase is exhausted, not that one context converged). Given
`--n` as the ceiling:

| Charter weight | Effective pool width |
|---|---|
| 4–5 | `--n` (full width) |
| 2–3 | `max(1, floor(--n / 2))` |
| 1 | `1` (no pooling — identical to the single-finder pre-pool behavior) |

At `--n 1` every dimension is width 1 regardless of weight (`min(1, …) = 1`),
reproducing the pre-pool single-finder call counts exactly. Each pooled call
sees the refute charter plus exactly one lens
([references/refute-charter.md](references/refute-charter.md) `## Lenses`) —
never the catalog, never a sibling lens.

Exit codes (the adlc-universal contract): **0** success or a clean human-gate
pause with printed resume instructions · **1** operational error (bad input,
no provider, network, budget) · **2** deterministic gate failure (divergence,
unverified findings, coldstart gaps, rails red, hollow survivors).

## The lifecycle

```
D-1 Scan ──▶ D0 Charter ──▶ D1 Comprehend ──▶ D2 Identify ──▶ D3 Roadmap ──▶ D4 Rail ──▶ Handoff
 (cheap        (interview      (7 artifacts,      (refute +        (score, seq,     (pin        (tickets →
  facts)        + weights)      parallax)          verify)          tickets)         behavior)    ADLC P3/P4)
                   │                │                  │                │                │
                   ▼                ▼                  ▼                ▼                ▼
            [HUMAN GATE 1]   divergence <        dry (K=2) +     coldstart clean   rails green +
            charter approved  threshold +        zero unverified  + [HUMAN GATE 2]  hollow audit
                              human skim                           roadmap approved
                                          ↻ refresh — idempotent living-document re-run
```

Exactly **two human gates** (D8): charter approval and roadmap approval. Every
other gate is deterministic or threshold-based. The pipeline is resumable
across multi-day pauses: `state.json` is the single source of truth for "what's
next", and every phase reads only `.dobetter/` artifacts — never another
phase's in-memory results.

CLI: `npx do-better run` executes the whole pipeline, stopping cleanly at each
human gate; re-invoking after `--approve` resumes where it left off.
Phase-per-command (`scan`, `charter`, `audit`, `roadmap`, `rail`, `refresh`)
runs any step alone.

## D-1 — Scan (cheap, fast, factual)

Goal: real code facts so the charter interview asks informed questions
("CI takes 40 minutes — pain point?") instead of generic ones.

1. Require a git repo; record HEAD SHA.
2. Collect deterministically (no model needed): file count and LOC, extension
   histogram, biggest files and directories, the **incantations** (package
   scripts, Makefile targets, CI workflows, Dockerfiles), manifests and
   dependency counts, TODO/FIXME/HACK density, test directories, README
   excerpt.
3. Draft `comprehension/codemap.md` (cheap tier): one-line purpose per
   top-level directory and major file, marked `draft: true` — D1 verifies it.
   Offline: structure-only tree, purposes marked `(structure-only)`.

CLI: `npx do-better scan`.

## D0 — Charter (the grill-me interview)

Goal: an approved engagement charter that weights the 8-dimension taxonomy
floor and captures pain, 12-month intent, and constraints. The taxonomy floor
([references/taxonomy.md](references/taxonomy.md)) is non-negotiable: all 8
dimensions appear with weight ≥ 1 — the floor is the defense against charter
blind spots.

1. Synthesize ≤12 interview questions (frontier tier), each citing a concrete
   scan fact and carrying a recommended answer.
2. **Codebase-check clause**: before asking anything, answer what the scan
   facts already answer (empty test dirs speak for themselves). Auto-answered
   questions are recorded under `## Established from the codebase`, with
   citations — never asked.
3. Interview the stakeholder strictly one question at a time; empty answer
   accepts the recommendation.
4. Synthesize `charter.md` per
   [references/templates/charter-template.md](references/templates/charter-template.md):
   intent (stabilize/scale/extend/handoff), per-dimension weights 1–5 with
   rationale, engagement-specific extra dimensions, constraints.
5. **HUMAN GATE 1**: the stakeholder reviews/edits the file and approves. No
   approval, no analysis — every downstream judgment is weighted by this
   document.

CLI: `npx do-better charter`, then `npx do-better charter --approve`.

## D1 — Comprehend (seven artifacts, parallax-verified)

Goal: understand before judging. The **behavior inventory is the keystone** —
it is the denominator for "retain existing functionality."

1. **Coverage plan first (declared sampling, never silent)**: rank files by
   charter-weight relevance × size × centrality; deep-read the top set
   (~40 files / ~150KB), scan the next ~200 (signatures only), skip the rest.
   Write `coverage-manifest.md` with deep/scanned/skipped percentages, the file
   lists, the rationale, and a `## Degradations` section.
2. Produce the seven artifacts (mid-tier readers over chunked packets):
   codemap (verifying the D-1 draft), architecture (intended vs actual drift),
   **behavior-inventory** (`B-NNN` entries: kind route/cli/job/event/db-write,
   surface, entry citation, summary — one bullet per observable behavior, every
   one cited), dependencies, rails-map (behaviors × existing tests), glossary,
   and mined skills (run skill-mining as a sub-step; skipped → declared).
3. **Citation gate (deterministic)**: every claim's `path:line@sha` citation is
   verified against the worktree; claim lines whose citations all fail are
   removed and logged; uncited behavior entries are dropped with a warning.
4. **Divergence gate (parallax)**: N fresh-context readings (default 3) of the
   charter + behavior inventory + architecture narrative. Divergence below
   threshold (default 0.25) passes; residual divergences seed D2
   confusion-findings. Over threshold fails (exit 2) — confusion is a finding,
   not noise. Parallax unavailable → declared single-reading degradation +
   mandatory human skim.

CLI: `npx do-better audit` (runs D1 then D2).

## D2 — Identify (refute, then reproduce-or-kill)

Goal: findings that survive hostile scrutiny. Two separated roles, never the
same context: **finders** propose, **verifiers** kill.

1. **Packetize the whole deep-read set.** The readable deep-read files are
   partitioned into finder **packets** (`partitionSlices`) — every file lands
   in exactly one packet, in order, and a file too large for one packet becomes
   its own hard-truncated singleton. This replaces the old "rotate one shared
   ≤30 KB window" scheme, which could only ever show the finder the head of the
   set (and, with an oversized head slice, nothing at all). For each dimension
   (all 8 + charter extras, descending weight) and each packet, run
   fresh-context finder passes under the refutation charter
   ([references/refute-charter.md](references/refute-charter.md)): chartered to
   REFUTE acceptability, file:line on every claim, low-confidence included.
   Each pass sees one packet's code plus prior passes' **conclusions only**
   (titles + files pool-wide across the dimension's packets, never transcripts —
   a finding from packet 1 is never re-proposed against packet 3).
2. **Loop each (dimension × packet) cell until dry**: a pass with zero new
   candidates is dry; stop at K=2 consecutive dry passes; a cell not dry within
   8 passes fails the gate (the failure detail names the dimension AND the
   packet). Admission is **two-layered**: (a) a free hash filter on
   dimension + file + normalized claim rejects verbatim repeats; (b) online
   only, each hash-survivor then faces a **cheap-tier semantic check** —
   one `dedupe` call comparing it against prior admitted entries (this run's
   pool **and** prior verified findings, D6) that share the same dimension AND
   file, so a re-worded restatement the hash cannot see is suppressed (it does
   not join the pool, does not become a finding, and does not count as "new" for
   the dry streak, but its hash key is recorded so it is not re-litigated). This
   semantic check is the **one sanctioned FAIL-OPEN path** in D2: an
   unparseable response, an out-of-range index, or a network/parse error admits
   the candidate as if new. Every other failure in D2 fails closed; this one
   inverts deliberately, because a false-new costs only one wasted verification
   call (which kills genuine junk anyway) while a false-duplicate permanently
   loses a finding nothing downstream can resurrect. Offline runs skip layer (b)
   entirely — hash-only, unchanged. An empty/unreadable deep-read set online is
   a gate failure too — starvation is never a silent zero-finding pass. Packets that reached K=2 are recorded per head sha, so a
   same-sha resume (after a `--budget` stop) skips them with zero re-issued
   finder calls; a sha change discards that state and re-examines everything.
   After the loop, a **`## D2 finder coverage`** section is written idempotently
   into `comprehension/coverage-manifest.md`: per dimension the files examined,
   packet count, total passes, and truncated slices, with unreadable deep-read
   files under `### Unexamined`. Cost scales as
   dimensions × packets × passes × poolN; `--budget` is the hard ceiling and a
   mid-loop stop preserves every finding verified so far (findings are written
   per candidate, not batched).
3. **Verify every candidate** per
   [references/verification.md](references/verification.md): deterministic
   citation check, then mechanical reproduction (whitelisted command shapes,
   30s timeout) or blind frontier re-read of ONLY the cited slice ± 40 lines —
   the finder's reasoning is withheld. CONFIRM → write the finding
   ([references/templates/finding-template.md](references/templates/finding-template.md))
   with its full reproduction record. KILL / UNCERTAIN / unparseable → killed,
   counted, never written.
4. Gate (deterministic): every dimension dry AND zero unverified findings
   written. The findings count is never celebrated — it is a vanity metric.

## D3 — Roadmap (score, sequence, ticket, coldstart)

Goal: the executive deliverable plus a machine-readable backlog — dual
artifact, one source of truth.

1. **Living-document reconciliation**: on re-runs, findings that no longer
   reproduce flip their items to `✅ done`; resolved items whose finding
   re-verified flip to `⚠ regressed`.
2. **Score** per [references/scoring.md](references/scoring.md): frontier
   proposes impact/effort (t-shirt) + confidence + dependencies; code computes
   `impact × confidence ÷ effort`, charter-weighted. Omitted findings get
   conservative defaults — nothing silently dropped.
3. **Sequence deterministically**: topological on dependencies, rails-first
   Phase 0, quick wins front-loaded, Now/Next/Later by score band. Declined
   items (score < 0.3 or explicit reason) get their own section with
   risk-of-inaction — listed, never hidden.
4. Write `ROADMAP.md`
   ([references/templates/roadmap-template.md](references/templates/roadmap-template.md))
   and one ticket per Now/Next item
   ([references/templates/ticket-template.md](references/templates/ticket-template.md)),
   plus `backlog/tickets.json` in the exact ADLC schema.
5. **Coldstart gate**: every ticket is cold-start tested (a fresh agent with
   only the ticket must be able to execute it). Gaps → repair up to 2 rounds →
   still gapped → demote to Later; any Now/Next ticket still gapped fails the
   gate (exit 2).
6. **HUMAN GATE 2**: stakeholder reviews `ROADMAP.md` + `backlog/`, edits
   freely, approves.

CLI: `npx do-better roadmap`, then `npx do-better roadmap --approve`.

## D4 — Rail (pin behavior before anyone changes it)

Goal: characterization rails for the behaviors Phase-Now/Next items touch —
roadmap-scoped, not exhaustive (D7).

1. **Preflight env check first.** Red does NOT fail the phase: "Make the
   environment runnable" becomes a Phase 0 roadmap item + ticket itself, and
   rails are scoped to whatever is runnable.
2. Map Now/Next ticket scopes onto the behavior inventory → rail targets;
   annotate rail-coverage gaps in rails-map.
3. Author rails per
   [references/templates/rail-template.md](references/templates/rail-template.md):
   fresh context (behavior entry + boundary I/O only — never implementation
   internals), boundary-level golden-master style, **bug-compatible pinning**
   (assert what IS, annotate `possibly a bug: see F-XXX`), into
   `test/dobetter-rails/`.
4. **Rails green gate**: every rail green against current code (2 fix rounds,
   then delete + record the gap — never ship a red rail).
5. **Hollow-test audit**: mutate the rails' assertions; survivors are vacuous
   rails — fix once or delete + gap. Tool absent → deletion spot-check
   (comment the behavior's entry line; the rail must go red).
6. Write `rails/manifest.md` (rows + gaps) and append rail paths to every
   ticket's `rails` array so ADLC rails-guard **freezes them mechanically**.

CLI: `npx do-better rail`. Then handoff: each ticket in `.dobetter/backlog/`
is ready for ADLC P3/P4 intake.

## Refresh (the living document)

Run any time after work lands: `npx do-better refresh`.

1. Diff the repo against the pinned SHA — changed + untracked files only
   (cost-proportional to drift, not repo size).
2. **Flag stale claims** in every artifact and finding citing changed files —
   flagged, never trusted.
3. Re-verify stale findings by re-running their reproduction records: no longer
   reproduces → `RESOLVED`, roadmap item → `✅ done`; still reproduces →
   re-pinned to the new SHA.
4. Behavior-diff regression detection where runnable: a retained behavior that
   changed with no roadmap item claiming the change is `⚠ regressed` — that is
   the one refresh outcome that gate-fails (exit 2).

## Composition contracts

- **skill-mining** — invoked during D1; mined skills are comprehension
  artifacts and ride along for the execution phase.
- **aidlc** — backlog tickets conform to the ADLC P2 ticket shape (atomic,
  fresh-agent executable, explicit contracts, coldstart-tested);
  `backlog/tickets.json` is consumable by `coldstart --tickets` unmodified.
  Rails conform to P3 doctrine (separate context, frozen, hollow-audited).
  Reused packages: `parallax` (D1 divergence), `coldstart` (D3 gate),
  `hollow-test` (D4 audit), `preflight` (D4 env check), `behavior-diff`
  (refresh regression detection).
- **grill-me** — the D0 interview is grill-me with a codebase-check clause,
  seeded by D-1 facts.

Every absent tool degrades **gracefully and loudly**: the fallback is weaker
and says so, in `coverage-manifest.md` and the gate records. A degradation
that doesn't announce itself is a lie about coverage.

## Model tiering (cost of detecting error, not prestige)

| Tier | Used for | Why safe |
|---|---|---|
| cheap | D-1 scan summaries, codemap draft, dependency inventory, coldstart-fallback probes | Mechanical; errors caught instantly and deterministically |
| mid | D1 readers, D2 finders, D4 rail drafting | Adversarial verification + hollow-test catch their errors |
| frontier | D0 charter synthesis, D2 finding verdicts, D3 scoring/sequencing judgment | Errors here sail through every gate undetected |

## Anti-patterns (do not do these)

- **Celebrating findings count.** The refused vanity metric (D11). A hundred
  plausible findings are worth less than ten verified ones; success is ticket
  survival rate and zero retained-functionality regressions.
- **Silent sampling.** Reading 10% of the repo and writing as if you read it
  all. The coverage manifest exists so sampling is *declared*; a bounded pass
  that reads as exhaustive is a lie.
- **Trusting stale claims.** A citation pinned to a SHA the repo has moved past
  is misinformation with the voice of authority. Flag it, re-verify it, never
  quote it as current.
- **Self-verified findings.** The context that proposed a finding confirming
  it. Verification is blind and separate, always.
- **Roadmaps without declined items.** A roadmap that hides what it chose not
  to do hides its judgment. Declined + risk-of-inaction is mandatory.
- **Rails that assert the desired behavior.** Rails pin what IS,
  bug-compatibly. Red-on-arrival rails are wishes, not rails.
- **Fixing things.** do-better analyzes, plans, and pins. Execution is ADLC's
  charter; the moment you patch product code you've left this skill.

## Verification checklist

Before declaring a run done:

- [ ] `charter.md` carries all 8 taxonomy dimensions with weight ≥ 1 and is
      human-approved (gate 1).
- [ ] `coverage-manifest.md` declares deep/scanned/skipped percentages and
      every degradation taken.
- [ ] Behavior inventory exists; every entry has a verified `path:line@sha`
      citation.
- [ ] Divergence gate passed below threshold (or single-reading degradation is
      declared + human skim done).
- [ ] Every dimension ran to dry (K=2); every finding file has status
      `verified` with a reproduction record; killed counts recorded.
- [ ] `ROADMAP.md` has Now/Next/Later, Done/Regressed, and a Declined section
      with risk-of-inaction lines.
- [ ] Every Now/Next ticket passed coldstart (or is demoted + flagged);
      `backlog/tickets.json` validates against the ADLC schema.
- [ ] Roadmap is human-approved (gate 2).
- [ ] Rails are green, hollow-audited (or spot-checked, declared), listed in
      `rails/manifest.md` with gaps, and frozen into ticket `rails` arrays.
- [ ] `state.json` pins every completed phase to a SHA and records per-phase
      spend.
