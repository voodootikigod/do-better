# handoff.md — do-better v0.2.0 build plan

> Handoff package for ADLC / ultracode execution. Scope: harden the D2 identify
> loop against premature dryness, add pooled diverse finders, semantic dedupe,
> cross-file verification, a distillation step, bounded concurrency, and repro
> hardening. Produced 2026-07-02 from a state-of-play review of `main` @ `c2d7a8b`.
>
> **Read this whole document before executing any ticket.** Tickets are atomic
> and fresh-agent executable; contracts between them are explicit in §5.

---

## 0. Context (why this work exists)

do-better v0.1.0 is complete and green (205/205 `node --test`, zero runtime
deps). It implements the ADLC F6 defense — loop-until-dry (K=2) per dimension —
in `src/identify.js`. A review found that the loop as built defends against a
weaker form of premature satisfaction than ADLC F6 describes:

| # | Finding | Evidence | Consequence |
|---|---------|----------|-------------|
| R1 | Finder passes are near-identical: same model, same system prompt, same slices rotated by 1. No fan width, no lens variation (E1/P5 unused). | `src/identify.js:461-489`, `rotate()` at `:464` | "Dry" can mean "the same context converged," not "the codebase is exhausted." Premature satisfaction migrates from single-pass to loop level. |
| R2 | Each finder pass sees ≤ 30KB (`PACKET_BYTES`). Rotation only shifts which files fit. With ~40 deep-read files / ~150KB, most of the deep-read set is never shown to any finder for a given dimension, and this coverage gap is recorded nowhere. | `src/identify.js:19,189-198` | Violates the project's own "declared, never silent" doctrine at the D2 layer. Loop runs dry having examined a fraction of what D1 declared it read. |
| R3 | **Bug**: `buildFinderPacket` does `break` (not skip) when a chunk won't fit. Line-numbering inflates a 24,000-char slice past 30KB for short-line files → first oversized rotated file → empty packet → finder sees `"(no deep-read slices available)"` → instant dry streak → **gate passes with zero findings, silently**. | `src/identify.js:189-198` | Dry-by-starvation passes the gate. The exact failure the tool exists to prevent, inside the tool. |
| R4 | Dedupe key is `sha256(dimension|file|normalized-claim)` — verbatim wording. Models rephrase; real duplicates re-enter the pool (dry streak resets on noise), and "do NOT repeat these" is a prompt-layer request, not a fact. | `src/identify.js:39-43` | Paraphrase can trigger MAX_PASSES gate failures; dry streak is noisy. |
| R5 | Blind verifier is a single frontier vote over one cited file ± 40 lines. Cross-file claims (architecture, maintainability, operability) cannot be supported by one slice → correctly killed. | `src/identify.js:341-405` (`verifyCandidate`, `codeSlice`) | Surviving findings — and the roadmap — skew systematically toward local, greppable trivia. Bias in the judgment layer that is the product's differentiator. |
| R6 | All finder/verify LLM calls are strictly sequential awaits. | `src/identify.js:444-510` | Wall-clock cost only; not correctness. |
| R7 | `sanitizeRepro` permits `node -e "<≤500 chars>"` proposed by a mid-tier model, executed with full user privileges in the target repo. A hostile brownfield repo is a prompt-injection surface into that model. | `src/identify.js:290-312` | Unacceptable posture for enterprise engagements. |
| R8 | ADLC distillation (lesson-foundry) is absent: verified findings never convert into permanent cheap controls, so every engagement re-buys the same detections. | (absent) | Cost curve stays flat instead of bending down (the ADLC compounding lever). |

ADLC doctrine references: F6 (finding-count prior / loop with fresh contexts),
E1 (sampling diversity), P5 (prosecutors are pooled, not paired), F4
(evidence-gating), P7 (distill), "declared, never silent," "constraints in the
tool layer are facts; in the prompt layer are requests."

---

## 1. Goal state (v0.2.0)

After this work, `npx do-better audit` D2 behaves as follows:

1. The **entire deep-read set** is partitioned into packets; every
   *(dimension × packet)* cell independently runs loop-until-dry (K=2). Dry
   means "every declared file was examined on every dimension until nothing
   new emerged." D2 finder coverage is written to the coverage manifest.
2. Each pass fans out **N pooled finders with distinct lenses** (default N=3);
   the dry streak counts the *pool's* combined new-candidate yield.
3. Dedupe is **semantic** (cheap-tier equivalence check layered over the hash),
   so paraphrases neither reset the streak nor burn passes.
4. Verification supports **multi-citation claims** and one bounded
   NEED_CONTEXT round, so cross-file findings can survive without
   sacrificing verifier blindness.
5. A new **`distill`** step clusters verified findings across runs into
   suggested permanent controls (`.dobetter/distilled/`).
6. Finder pools and verification run with **bounded concurrency**.
7. Model-proposed `node -e` reproduction execution is **disabled by
   default** (R7 posture: never execute model-proposed code with user
   privileges against a hostile brownfield repo); `--eval-repro` opts back
   into v0.1 behavior for engagements that accept the risk.

Non-goals (explicitly out of scope for v0.2.0): planted-bug calibration
(`review-calibration`), any change to D0/D1/D3/D4 semantics, executing fixes
(D1 charter boundary is untouched), new runtime dependencies (still zero),
changing the exit-code contract or the two human gates.

---

## 2. Ground rules for every ticket

- **Repo**: `/Users/voodootikigod/Projects/do-better`, branch off `main`.
  Plain JS ESM, Node ≥ 18, **zero runtime dependencies**, `node --test`.
- **Rails**: the existing 205-test suite is the frozen rail set, plus the new
  rails in T0. Builders never edit files under `test/` except to *add* tests
  named in their ticket's acceptance criteria. Rail edits outside that = stop
  and escalate.
- **No network in tests** — use the `DOBETTER_FAKE_LLM` seam
  (`test/fixtures/fake-llm.js` pattern; see `test/identify.test.js:130-170`
  for the per-test fake-writer helper) or `--offline`.
- **Dual-mode invariant**: the CLI loads `do-better/SKILL.md` and
  `do-better/references/*` as prompt sources. Any behavior change MUST update
  the matching SKILL.md section and reference doc in the same ticket —
  CLI/skill drift is a contract violation.
- **Immutability**: state transitions return new objects
  (`patchPhase`-style); the LLM spend accumulator is the one sanctioned
  mutable object.
- **Fail closed**: unparseable LLM output, unsafe paths, and unverifiable
  citations are dropped/killed, never guessed. Exception noted in T3
  (dedupe fails *open*, deliberately — rationale inline).
- Style: match the codebase (small focused modules, ~200–650 lines, JSDoc
  where it clarifies).
- Before merge of the integrated branch:
  `npx adversarial-review --base main` must pass (exit 0), per the standing
  git-workflow rule.

## 2b. Execution harness — ADLC toolkit wiring

The `@adlc/cli` dispatcher (`adlc <tool> [args]`, v1.1.0) is globally
installed — `adlc --version` confirms it; no local checkout or wrapper
needed. Doctrine in this plan is enforced **mechanically** by these tools,
not by reviewer diligence — "constraints in the tool layer are facts; in the
prompt layer are requests." Run `/adlc-init` once per repo before S0 below
to create the `.adlc/` workspace, and prefer `/adlc-ticket` to author
`.adlc/tickets.json` over hand-authoring it (S0.4 still describes the
required shape for tickets that skill produces).

**S0.0 — commit the plan before spawning anything:**

`handoff.md` and `.adlc/tickets.json` must be **committed to `main`** — or
listed in `seedPaths` per the standing worktrees rule — before any
`.worktrees/*` is created. Worktree branches fork from `main`; a worktree
created before this commit contains neither the plan a builder is meant to
execute nor the tickets file the mechanical gates consume.

**`.adlc/manifest.jsonl` is deliberately untracked**, matching `/adlc-init`'s
own convention (`.gitignore` carries `.adlc/*` / `!.adlc/tickets.json` —
only the ticket contract is committed; ledgers, gate evidence, the ticket
lock, and hook runtime state are runtime artifacts). This plan's execution
model is single-checkout (one physical clone runs every post-merge record
step — see below), so the untracked local file is sufficient: chain
integrity comes from the serialization rule, not from git tracking. A
distributed/multi-machine execution would need a different durability
mechanism (an explicit `!.adlc/manifest.jsonl` un-ignore, or pushing the
ledger to a shared location) — out of scope here.

**The manifest ledger cannot be appended from inside a worktree, by any
tool, ever** — verified against `@adlc/gate-manifest`'s actual source
(`packages/gate-manifest/lib/record.mjs`): each entry's hash chains against
`readLastRawLine()`, the literal last physical line of `.adlc/manifest.jsonl`
*at the moment of the write*. Two worktrees forked from the same base and
independently appending (even to a git-tracked file that later merges
cleanly at the text level) each compute their entry's `prevHash` against a
predecessor that is no longer the file's actual predecessor once both
branches land — the chain silently stops proving what it claims, and
`gate-manifest verify` fails at T8, or worse, "passes" over a chain that
no longer means anything. `rails-guard --record` shares the same
`@adlc/core` ledger writer and has the identical hazard.

The fix is a strict split, carried through the gate tables below:
**checking** whether a ticket's diff passes a gate (blocking, pre-merge, safe
to run inside any worktree — it doesn't touch the shared ledger) is a
different operation from **recording** that it passed (must run from `main`,
serialized, immediately after that ticket's merge and before the next
ticket starts anywhere). Because git only ever applies one merge to `main`
at a time, "run the record step immediately post-merge, from `main`" is
sufficient to keep the chain linear even with two worktrees in flight — the
serialization comes from doing the record step right after the merge, not
from where the ledger file happens to live.

**S0 — plan intake (run before dispatching any builder):**

1. `adlc spec-lint handoff.md` — criteria without named verification
   methods exit 2. Fix the plan, not the linter.
2. `adlc premortem handoff.md --tier frontier --out .adlc/premortem.md`
   — inverted-sycophancy stress test of this plan; fold real causes back into
   §7 before execution.
3. Parallax the plan: N fresh-context readings of §3–§5
   (`adlc parallax --file handoff.md`); divergent readings = plan ambiguity
   → fix the text.
4. Materialize `.adlc/tickets.json` from §3 (ADLC P2 ticket schema: id,
   scope files, contracts, acceptance criteria, `rails` arrays listing the
   frozen paths, dependency edges). This file is what the mechanical gates
   consume — the prose tickets in §3 are its source of truth.
5. `adlc coldstart --tickets .adlc/tickets.json --all` — every ticket
   must be fresh-agent executable **before** builders run; gaps are plan
   defects, repair here.
6. `adlc merge-forecast --tickets .adlc/tickets.json --width 2` —
   certifies the two-worktree split in §4 instead of trusting my hand
   analysis. A SEQUENCE verdict overrides §4.
7. `adlc preflight` in each worktree — dry-run operation classes,
   front-load permission prompts before fan-out.

**Pre-merge, blocking, ledger-blind (run inside the ticket's own worktree,
against `--base main`, BEFORE merging that branch to `main` — none of these
write `.adlc/manifest.jsonl`):**

| Stage | Tool | Gate |
|---|---|---|
| Rail freeze | `adlc rails-guard --base main --tickets .adlc/tickets.json --ticket <id>` (**no `--record`** — that flag shares the ledger writer and is deferred to the post-merge step below) | Builder diff touching frozen rail paths (existing `test/**` + `test/identify-rails.test.js`) exits 2 — the rails-diff-empty proof. |
| Test quality | `adlc hollow-test --test-cmd "node --test" --base main` | Diff-scoped mutation on each ticket's new tests; surviving mutants = vacuous tests, exit 2. Applies to T0's rails **and** every ticket's AC tests. |
| Flail control | `adlc flail-detector` on the builder session log | Two-strike rule: second failed attempt escalates to re-decomposition of the ticket, never to a bigger model or a third try. Ticket-scoped output, no shared-ledger interaction. |
| Review evidence | `adlc prosecute --input passes.json --ticket <id> --dir .adlc` | Records review passes to a **ticket-scoped** `passes.json` (not the shared chained ledger); exits 2 until two consecutive dry passes with zero verified findings. This is the merge-approval gate: a ticket does not merge until this exits 0. |

A gate that exits non-zero **blocks the merge** — the branch does not land
on `main` until it's fixed and the gate is re-run clean. This is what makes
"pre-merge" mean "before," not "after": nothing above ever runs against
already-merged code, and none of it writes the shared ledger.

**Post-merge, ledger writes (run from the `main` checkout ONLY, immediately
after each merge, before the next ticket starts anywhere — this immediacy,
not the ledger's file location, is what keeps the chain linear across two
worktrees):**

| Stage | Tool | Purpose |
|---|---|---|
| Provenance record | `adlc gate-manifest record <gate-name> --ticket <id> --data '{"result":"pass", ...}' --files <touched-files>` — one call per gate that passed pre-merge (rail freeze, test quality, review evidence) | Appends the evidence entry for the *just-merged* ticket to `main`'s single `.adlc/manifest.jsonl`, chained against `main`'s actual current tip (verified CLI shape: `record <gate-name> [--ticket id] [--data '{json}'] [--files a,b,c]`). |
| Provenance verify | `adlc gate-manifest verify` | Confirms the chain on `main` is intact so far — run after each merge as a cheap sanity check, and again, whole-chain, at T8. |

**Post-merge (compounding):** run `lesson-foundry` over the build's own
verified review findings (anything that recurs becomes a lint/skill/spec-
template candidate — dogfooding T5's doctrine on ourselves), and `skill-rot`
against `do-better/references/*` to stamp `last-verified` after the doc
changes in T1–T4.

Fallbacks: any tool that cannot run in context degrades to the manual
protocol in §6 — **declared in the PR description, never silent** (the same
degrade-loudly contract do-better itself uses).

Key existing contracts (do not reinvent):

- `src/identify.js` exports `run(ctx)`, `PHASE_ID`, `dedupeKey(candidate)`,
  constants `K_DRY = 2`, `MAX_PASSES = 8`.
- `ctx = { root, dotdir, llm, log, exec, state, now, flags, adlc, ask }` —
  `ctx.adlc` is the locate/availability table from `src/adlc.js` (read
  `ctx.adlc.available` for "is skill-mining/aidlc present" checks; T5
  depends on this — do not re-locate ad hoc). `ctx.ask` is the interview I/O
  seam (used by D0 charter; present on every ctx for shape uniformity, not
  used by D2/distill).
- LLM service (`src/llm.js`): `llm.call(prompt, {system, tier, label, jsonMode})`,
  `llm.callJson(...)`, `llm.offline`, `llm.drainSpend()`; tiers
  `cheap|mid|frontier`; wrap every call site with `withFallback(llm, args, fallbackFn)`.
- Artifacts (`src/artifacts.js`): `LAYOUT`, `readArtifact`/`writeArtifact`
  (frontmatter codec), `verifyCitations(root, citations, exec)`,
  `runReproCheck(root, check)`, `writeFinding`, `readFindings`.
- State (`src/state.js`): `setGate`, `recordPhase`, `addSpend`, `pinSha`,
  `nextFindingId` — all pure.
- Gate failure = `GateError` with `.gate`, `.detail`, `.state` attached
  (exit 2); operational failure = `OpError` (exit 1); budget = `BudgetError`.

---

## 3. Tickets

Effort t-shirts: S ≈ ½ day, M ≈ 1 day, L ≈ 2 days for one agent. Model tier =
the tier the *builder* should be; per ADLC, never smarter than the gate
requires.

---

### T0 — Rails: characterization tests for retained D2 behavior

**Motivation**: T1–T4 restructure the identify loop. Pin what must not change
*before* anyone changes it (ADLC P3; rails authored fresh-context, frozen).

**Scope**: `test/identify-rails.test.js` (new file only).

**Author in a fresh context** from the SKILL.md D2 section + the public
contracts in §2 above — not from reading the loop internals.

**Pin (bug-compatible where noted)**:
1. `run(ctx)` without a passed comprehend gate throws `OpError` (exit 1).
2. Gate pass requires all dimensions dry AND zero unverified written; gate
   fail throws `GateError` with `.gate === "identify"`, `.state` attached,
   exit 2.
3. Verified findings are written via `writeFinding` with
   `status: "verified"`, evidence `[{file, line, sha}]`, and a reproduction
   record; killed candidates are never written.
4. Re-run seeds dedupe from `readFindings` — no duplicate finding files or
   IDs (D6 idempotency).
5. Offline mode: deterministic static pass per dimension, single pass,
   declared degradation in the summary string.
6. Candidate validation drops unsafe paths / bad severities silently
   (fail closed).
7. State shape: `phases.identify.{passesByDimension, killed, verified}` and
   `gates.identify.{passed, dryPassesByDimension, unverified}` keys exist.
   (T1 may *add* keys; these must remain.)

**Explicit non-pins** — do NOT assert these; T1–T4 legitimately change them:
pass-count *magnitudes* (`passesByDimension` values), the exact wording of
`GateError` detail strings, or the content/shape of any LLM system or user
prompt. Assert presence/shape/invariants only (e.g. "`passesByDimension[dim]`
is a positive integer"), never today's specific numbers or strings. A rail
that pins these makes T1 unlandable under `rails-guard` for a defect
authored into the plan, not the code — this instruction exists to prevent
that trap.

#### Acceptance criteria
- AC1: `node --test test/identify-rails.test.js` green against current `main` *before* any T1 code lands. *(Verification: run on main.)*
- AC2: No existing test file modified. *(Verification: `git diff --stat main -- test/` shows only the new file.)*
- AC3: Rails survive mutation — `adlc hollow-test --test-cmd "node --test test/identify-rails.test.js" --base main` exits 0 (no surviving mutants; a rail that `toBeDefined()`s its way to green is not a rail). *(Mechanical gate, §2b.)*

**Depends on**: nothing. **Effort**: M. **Builder tier**: mid.
**Partition**: `test/identify-rails.test.js` only.

---

### T1 — Coverage-driven dry loop + packet-starvation fix

**Motivation**: R1 (partially), R2, R3. The exhaustiveness lever. Direct
answer to "run in a loop to gather all possible items."

**Scope**: `src/identify.js`, `do-better/SKILL.md` (D2 section),
`do-better/references/verification.md` (coverage note), `README.md`,
`test/identify.test.js` (additions), `test/identify-coverage.test.js` (new).

**Design (decided — do not relitigate)**:

1. **Fix `buildFinderPacket`** (`src/identify.js:189-198`):
   - Replace `break` with skip-and-continue: a chunk that doesn't fit is
     skipped, later smaller chunks may still be admitted.
   - A single numbered chunk that alone exceeds `PACKET_BYTES` is
     hard-truncated (via existing `truncate`) to fit rather than dropped.
   - Given ≥1 readable slice, the packet is **never** empty.
2. **New pure function** `export function partitionSlices(slices, maxBytes = PACKET_BYTES)`:
   returns `[{ files: [names], packet: string }]` such that every readable
   slice appears in **exactly one** packet (numbered form, same `=== file ===`
   header format as today); oversized slices become singleton truncated
   packets. Deterministic ordering (input order). Unit-testable without LLM.
3. **Loop inversion**: for each dimension (descending charter weight, as
   today), for each packet, run loop-until-dry: K_DRY = 2 consecutive
   zero-new-candidate passes, cap `MAX_PASSES = 8` **per (dimension × packet)
   cell**. `rotate()` is deleted. The per-pass prompt is unchanged in shape
   (prior-conclusions list is pool-wide for the dimension, not per-packet —
   a finding found via packet 1 must not be re-proposed against packet 3).
4. **Starvation is a gate failure, never a silent pass**: if the deep-read
   file list is empty or no slice is readable, online D2 throws `GateError`
   (`.gate = "identify"`, detail names the cause). The offline static path is
   exempt (it doesn't consume packets).
5. **State/gate additions** (additive; T0 rails must stay green):
   `phases.identify.packetsByDimension` (`{dimId: packetCount}`) and
   `phases.identify.passesByDimension` becomes total passes summed across
   packets for that dimension. `gates.identify` gains
   `packetsByDimension`. Not-dry detail names the dimension *and* packet
   index.
6. **D2 finder coverage manifest**: after the loop, rewrite (idempotently —
   replace the section if present) a `## D2 finder coverage` section in
   `.dobetter/comprehension/coverage-manifest.md` via
   `readArtifact`/`writeArtifact`: per dimension — files examined, packet
   count, total passes, truncated-slice list. Files in the deep-read list
   that were unreadable are listed under a `### Unexamined` subheading.
   **Offline**: the section is still written, never empty or skipped — files
   examined comes from T0 rail 5's static pass (the section's populatable
   field even offline); packet count and total passes are `0`/`1`
   respectively with a `(offline — no packetization)` note, satisfying §6.7's
   smoke-test requirement without inventing an undocumented format.
7. **Cost note in README + SKILL.md**: calls scale as
   `dims × packets × passes × poolN`; `--budget` remains the hard ceiling
   and a `BudgetError` mid-loop preserves verified findings (already true —
   findings are written per-candidate).
8. **Persisted per-cell dry state (cost control — in scope for v0.2.0, not
   deferred)**: `phases.identify.dryCellsByDimension: {dimId:
   [packetIndex, ...]}` records packets that reached K_DRY this run. On a
   re-run **against the same headSha** (i.e. resuming after a `BudgetError`
   before the next phase pins a new SHA), packets already recorded dry are
   skipped entirely — no finder calls are reissued for them. A re-run after
   the SHA changes discards all dry-cell state (the code moved; re-examine
   everything). This makes `BudgetError` resumable instead of
   restart-from-zero.

#### Acceptance criteria (each names its verification method)
- AC1: `partitionSlices` covers all slices exactly once; oversized slice → singleton truncated packet; never returns `[]` for non-empty input. *(Unit test, new `test/identify-coverage.test.js`.)*
- AC2: Regression test reproducing R3 — a slice whose numbered form exceeds `PACKET_BYTES` at rotation head — fails on `main`'s builder, passes on the new one, and end-to-end the fake-LLM finder receives packet text containing the *other* file's content (assert via fake-LLM prompt log). *(Integration test, fake-LLM seam.)*
- AC3: With 2 dimensions × 3 packets in the fake fixture, every packet's content appears in ≥1 finder prompt per dimension (assert on the fake-LLM log). *(Integration test.)*
- AC4: Empty/unreadable deep-read set online → `GateError` exit 2 with descriptive detail; offline unaffected. *(Integration test.)*
- AC5: `coverage-manifest.md` gains the `## D2 finder coverage` section with per-dimension file lists; re-running replaces rather than duplicates it. *(Integration test asserting on file content.)*
- AC6: T0 rails + full existing suite green. *(`node --test`.)*
- AC7: SKILL.md D2 step 1–2 and README updated to describe packetized coverage and the coverage section. *(Reviewer check — `grep -l packet do-better/SKILL.md README.md` matches both.)*
- AC8: `BudgetError` mid-run, same-SHA re-run: cells already dry are not re-queried (assert zero fake-LLM calls for those cells); a cell not yet dry resumes from its recorded pool, not from empty. A SHA change between runs clears all dry-cell state (full re-examination). *(Integration test.)*
- AC9: README gains a "Sizing `--budget`" table with expected D2 call counts for a reference repo shape (8 dims × ~5 packets × K_DRY=2 × charter-weighted N — see T2), so operators can size budgets before running. *(Reviewer check — README contains the table.)*

**Depends on**: T0. **Effort**: L. **Builder tier**: mid.
**Partition**: `src/identify.js` (single writer — see §5).

---

### T2 — Pooled, lens-diverse finders (D2 fan width)

**Motivation**: R1. ADLC E1 (sampling diversity) + P5 (pooled prosecutors).

**Scope**: `src/identify.js`, `do-better/references/refute-charter.md`
(lens section), `src/utils.js` (only if flag plumbing needs it — `--n` already
parses), `do-better/SKILL.md`, `README.md` (flags table),
`test/identify-pool.test.js` (new).

**Design (decided)**:

1. Reuse the existing `--n` flag (already the D1 parallax width, default 3)
   as the **maximum** D2 pool width — one flag, one meaning: "fan width for
   fresh-context multiplicity." **Charter-weighted in scope for v0.2.0**
   (not deferred — see cost review, §7): effective pool width for a
   dimension is `min(--n, charterPoolWidth(weight))` where weight ≥ 4 →
   full `--n`, weight 2–3 → `max(1, floor(--n / 2))`, weight 1 → `1` (no
   pooling — a single finder call, identical to v0.1 for that dimension).
   Document the table in both flag tables and `references/taxonomy.md`.
2. Add a `## Lenses` section to `references/refute-charter.md` with 5 named
   lenses (one paragraph each): `exploit-author`, `oncall-3am`,
   `new-hire-reader`, `performance-profiler`, `staff-skeptic`.
   **Leakage hazard (found in review): the finder system prompt
   (`refuteSystem`, `identify.js:425`,
   `loadRef("refute-charter.md", FALLBACK_REFUTE)`) is loaded wholesale
   today and passed verbatim to every finder. Left as-is, every finder
   would see all 5 lens descriptions regardless of its assigned lens,
   diluting the diversity this ticket exists to add.** Fix: a new pure
   `parseLenses(refuteDoc)` returns `{ base: string, lenses: [{id, text}] }`
   — `base` is everything ABOVE the `## Lenses` heading (used as
   `refuteSystem`, replacing today's whole-file load); `lenses` is the
   parsed catalog. Fallback (section absent or unparseable): `base` = the
   whole doc (today's behavior, doctrine preserved) and `lenses` = a
   hardcoded 5-entry const array — degrade loudly via `log.warn`.
3. Each pass of a (dimension × packet) cell issues **N finder calls** (N =
   the charter-weighted width from item 1); call `i`'s system prompt is
   `base + "\n\nLens: " + lenses[(passIndex + i) % lenses.length].text` —
   the finder sees its own assigned lens only, never the catalog. Same
   packet, same prior-conclusions list.
4. Pool admission: candidates from all N calls are validated + deduped
   together; `newCount` is the pooled total; dry streak advances only when
   the **pool** yields zero new. `passesByDimension` still counts passes
   (not calls).
5. A single finder-call failure inside a pool: `BudgetError` rethrows
   (stop-the-world, existing contract); any other `OpError` after the LLM
   layer's own 3 retries fails the phase (fail closed — a silently absent
   pool member is undeclared coverage loss).

#### Acceptance criteria
- AC1: With `--n 3`, each pass issues exactly 3 finder calls with 3 distinct lens strings (assert on fake-LLM prompt log). *(Integration test.)*
- AC2: Dry streak: pool pass A yields {2 new, 0, 0} across members → not dry; passes B and C yield all-zero pools → dry at K=2. *(Assert in `test/identify-pool.test.js`, scripted fake.)*
- AC3: Lens parsing: doc-driven lenses used when present; hardcoded fallback + warning when section missing. *(Unit test in `test/identify-pool.test.js`.)*
- AC4: `--n 1` reproduces pre-T2 single-finder call counts (backward compatible escape hatch). *(Integration test.)*
- AC5: T0 rails + full suite green (`node --test`); SKILL.md/README flag tables updated.
- AC6: Charter-weighted width: a weight-1 dimension issues exactly 1 finder call per pass regardless of `--n`; a weight-5 dimension issues `--n` calls; a weight-3 dimension issues `max(1, floor(--n/2))`. *(Unit + integration test.)*
- AC7: A finder's system prompt contains its assigned lens text and does **not** contain the `## Lenses` heading or any other lens's text (assert on fake-LLM system-prompt log). *(Integration test — the leakage regression item 2 exists to prevent.)*

**Depends on**: T1. **Effort**: M. **Builder tier**: mid.
**Partition**: `src/identify.js` + `references/refute-charter.md`.

---

### T3 — Semantic dedupe

**Motivation**: R4. Make the dry streak measure novelty, not phrasing.

**Scope**: `src/identify.js`, `test/identify-dedupe.test.js` (new),
`do-better/SKILL.md` (D2 step 2 wording).

**Design (decided)**:

1. Layered admission for each validated candidate:
   a. **Hash filter** (existing `dedupeKey`) — free, unchanged, still
      exported.
   b. **Semantic filter** (only for hash-survivors, online only): one
      cheap-tier `jsonCall` per candidate comparing against prior admitted
      entries with the **same dimension AND same file** (small list):
      prompt lists prior `{index, title, claim}`, asks
      `{"duplicateOf": null | <index>}`. Duplicate → not admitted, does not
      reset the dry streak, and its key is added to `seen` so the paraphrase
      is not re-litigated next pass.
2. **Fails OPEN, deliberately**: unparseable/erroring semantic check ⇒ treat
   as new. Rationale: the cost of a false-new is one wasted verification;
   the cost of a false-duplicate is a lost finding. Verification downstream
   kills junk; nothing resurrects a wrongly-suppressed finding. (This is the
   one sanctioned fail-open in D2 — document it in the code comment and
   SKILL.md.)
3. Offline: hash-only (declared in the summary line, as offline already
   declares degradation).
4. Prior-findings seeding (D6) also participates: semantic comparison list
   includes prior verified findings for that dimension+file (title/claim
   from `readFindings`).

#### Acceptance criteria
- AC1: Paraphrase fixture — same defect, different wording, same dimension+file — is suppressed; dry streak advances; no second finding file on re-run. *(Integration test, scripted fake returning `duplicateOf`.)*
- AC2: Genuinely distinct claim in the same file is admitted. *(Integration test in `test/identify-dedupe.test.js`.)*
- AC3: Semantic-check failure ⇒ candidate admitted (fail open) + `log.warn`. *(Integration test.)*
- AC4: Semantic check runs at `tier: "cheap"` (assert on fake-LLM log) and only for same dimension+file pairs. *(Integration test.)*
- AC5: T0 rails + full suite green (`node --test`).

**Depends on**: T2 (same admission code path; sequence, don't parallelize).
**Effort**: M. **Builder tier**: mid. **Partition**: `src/identify.js`.

---

### T4 — Multi-citation claims + bounded NEED_CONTEXT verification

**Motivation**: R5. Let cross-file findings survive without breaking verifier
blindness.

**Scope**: `src/identify.js` (finder prompt JSON shape, `verifyCandidate`,
`codeSlice` usage), `src/artifacts.js` (**additive only**: finding evidence
may carry >1 citation — confirm `writeFinding`/`readFindings` already
round-trip an evidence array; if so, no change), `do-better/references/verification.md`,
`do-better/references/templates/finding-template.md`, `do-better/SKILL.md`,
`test/identify-crossfile.test.js` (new).

**Design (decided)**:

1. **Candidate schema (additive)**: finders may return
   `citations: [{file, line}, ...]` (≤ 4). `file`/`line` remain required and
   are treated as `citations[0]` when `citations` is absent. Validation:
   every citation passes `isSafeRelPath` + integer line ≥ 1, else the whole
   candidate is dropped (fail closed). Finder prompt documents the field and
   instructs multi-citation for cross-file claims.
2. **Deterministic stage**: `verifyCitations` must verify **all** citations;
   any failure kills the candidate (unchanged spirit, wider net).
3. **Repro stage**: unchanged.
4. **Blind reread stage**: the verdict prompt includes one ±40-line slice
   per citation (cap 4 slices; total slice budget 24,000 chars — reuse
   `truncate`). Verifier remains blind to proposer reasoning.
5. **NEED_CONTEXT round (exactly one)**: `VERDICT_SYSTEM` gains a fourth
   verdict `NEED_CONTEXT` with `{"files": ["rel/path", ...]}` (≤ 2). If
   returned, re-issue the verdict call once with those files' slices
   appended (each `isSafeRelPath`-checked, truncated to 8,000 chars;
   unsafe/unreadable requests are simply omitted). Second response must be
   CONFIRM/KILL/UNCERTAIN; a second NEED_CONTEXT ⇒ killed (fail closed).
   The reproduction record notes `context-round: 1` and which files were
   supplied.
6. **Finding output**: evidence array carries all verified citations;
   finding-template.md documents multi-citation evidence.

#### Acceptance criteria
- AC1: Cross-file fixture: candidate citing 2 files, verdict CONFIRM ⇒ finding written with 2 evidence entries, both SHA-pinned. *(Integration test in `test/identify-crossfile.test.js`.)*
- AC2: One bad citation among several ⇒ killed before any LLM verdict call (assert zero verdict entries in fake-LLM log). *(Integration test.)*
- AC3: NEED_CONTEXT round: first verdict NEED_CONTEXT with a safe path ⇒ exactly one follow-up verdict call whose prompt contains the requested file's content; CONFIRM ⇒ verified with `context-round` in the reproduction record. *(Integration test.)*
- AC4: Second consecutive NEED_CONTEXT ⇒ killed; unsafe requested path ⇒ omitted from the follow-up, not fetched. *(Integration tests in `test/identify-crossfile.test.js`.)*
- AC5: Single-citation candidates take **no NEED_CONTEXT round** against the scripted fixtures (a real model may legitimately request context even for a single citation — that's the feature working, not a regression); the CONFIRM/KILL/UNCERTAIN verdict call count per candidate is unchanged from v0.1 (one call, or two only on an actual NEED_CONTEXT round). Note: `VERDICT_SYSTEM` itself changes for every candidate (design item 5) — this AC does **not** claim byte-identical prompts, only unchanged call-count behavior on fixtures that don't trigger NEED_CONTEXT. T0 rails and the pre-T4 verdict-path tests stay green. *(Rails + full suite + new scripted-fake assertion on call count.)*
- AC6: verification.md + finding-template.md + SKILL.md updated. *(Reviewer check — `grep NEED_CONTEXT do-better/references/verification.md`.)*

**Depends on**: T3 merged — single-writer sequential order in worktree 1
(see §4); no ambiguity about parallel-vs-sequence, T2/T3/T4 all serialize in
one worktree. **Effort**: L. **Builder tier**: mid (verifier prompts
reviewed by frontier in prosecution). **Partition**: `src/identify.js` +
reference docs.

---

### T5 — Distill: findings → suggested permanent controls

**Motivation**: R8. ADLC P7 / lesson-foundry: bend the cost curve by
converting recurring verified findings into cheap permanent controls.

**Scope**: `src/distill.js` (new, self-contained: exports `run(ctx)` +
`PHASE_ID`), `src/artifacts.js` (LAYOUT addition), `do-better/SKILL.md`
(new section), `README.md`, `test/distill.test.js` (new). **Does NOT touch
`src/utils.js`, `bin/cli.js`, or `src/refresh.js`** — CLI registration and
the refresh auto-invoke wiring are ticket T5b, not this one (see §4:
`utils.js`/`bin/cli.js`/`refresh.js` are single-writer-owned by worktree 1,
where T6/T7 also edit them — `HELP_TEXT` and, in T7's case, `refresh.js`'s
own re-verification logic. The original T5 scope claimed both files as
"disjoint" from worktree 1, which was false both times and guaranteed a
merge conflict — review findings, round 1 and round 2).

**Design (decided)**:

1. New command `npx do-better distill` (invocable standalone; **the
   auto-invoke-at-end-of-refresh wiring is T5b's job**, not this ticket's —
   `src/distill.js` exports `run(ctx)` for T5b to call, but does not itself
   touch `refresh.js`). Requires ≥1 verified finding; otherwise a clean
   no-op with a message (exit 0).
2. **Clustering**: group verified findings (current + all prior runs — they
   persist in `findings/`) by dimension, then one cheap-tier `jsonCall` per
   dimension proposing clusters:
   `{"clusters":[{"label":"...", "findingIds":["F-..."], "rationale":"..."}]}`.
   Offline fallback: cluster by identical static `check.type` only
   (declared).
3. **Control proposal**: for each cluster with ≥ 2 findings, one mid-tier
   call proposing the *cheapest permanent defense*, constrained to three
   shapes:
   - `{"type":"grep","pattern":"...","file":"..."}` or
     `{"type":"grep-repo","pattern":"..."}` — a static check runnable by
     `runReproCheck` / added to `staticFinderPass` heuristics;
   - `{"type":"lint","tool":"eslint|other","sketch":"..."}` — human-readable
     rule sketch;
   - `{"type":"skill","suggestion":"..."}` — routed to skill-mining when
     present (reuse `src/adlc.js` locate/degrade table).
4. **Verification of controls** (evidence-or-it-didn't-happen applies to
   distill's own output): grep-shaped controls are executed against the
   current worktree via `runReproCheck`; a control that doesn't currently
   fire is still emitted but marked `dormant: true` (it defends the future).
   Lint/skill shapes are marked `unverified-suggestion` — they are
   suggestions, and say so.
5. **Artifacts**: `.dobetter/distilled/lessons.md` (human: one section per
   cluster — findings cited by ID, proposed control, status) and
   `.dobetter/distilled/controls.json` (machine:
   `{version: 1, generatedAt, headSha, controls: [{id: "C-NNN", cluster,
   findingIds, control, status: "verified"|"dormant"|"unverified-suggestion"}]}`).
   Idempotent: re-runs regenerate both from the full findings set; `C-NNN`
   ids stable-keyed by cluster-label hash.
6. **State**: `phases.distill` recorded via `recordPhase`/`addSpend` (add
   `"distill"` to `PHASES` in `src/state.js` — confirm additive-safety with
   the state round-trip tests). No gate, no human approval.

#### Acceptance criteria
- AC1: Fixture with 3 verified findings (2 same-class) ⇒ one cluster of 2, one control emitted; `controls.json` validates against the shape above. *(Integration test, scripted fake.)*
- AC2: Grep-shaped control that fires ⇒ `status: "verified"` with a repro record; non-firing ⇒ `"dormant"`. *(Integration test.)*
- AC3: Zero findings ⇒ exit code 0, friendly message, no artifacts. *(CLI test.)*
- AC4: Re-run is idempotent — stable `C-NNN` ids, no duplicate sections. *(Integration test.)*
- AC5: Full suite green (`node --test`); README/SKILL.md document the command's behavior and artifacts. (CLI registration, the refresh auto-invoke wiring, and their tests are T5b's ACs, not this ticket's.)

**Depends on**: nothing in T1–T4 (separate partition; may run in parallel
from day one). **Effort**: L. **Builder tier**: mid.
**Partition**: `src/distill.js`, `src/state.js` (PHASES only),
`src/artifacts.js` (LAYOUT only). Explicitly excludes `src/utils.js`,
`bin/cli.js`, and `src/refresh.js` (all three are T5b).

---

### T5b — Wire `distill` into the CLI surface and into `refresh`

**Motivation**: Two review findings, same failure class, twice: T5's
original scope claimed `src/utils.js` (round 1) and separately
`src/refresh.js` (round 2) as disjoint from worktree 1 for parallel
execution, while T6/T7 also edit both there — a guaranteed conflict in
`HELP_TEXT` (round 1) and in `refresh.js`'s eval-repro re-verification
logic (round 2, T7 also edits `refresh.js`). Single-writer rule (§4)
resolves both: `utils.js`/`bin/cli.js`/`refresh.js` are worktree-1-owned;
this ticket does all three integrations there, after **both** `T5`'s
`src/distill.js` and `T7`'s `refresh.js` changes have merged to `main` —
so this is also where the two independent `refresh.js` changes (T7's
eval-repro gating, this ticket's distill auto-invoke) get a single
integration test proving they compose correctly.

**Scope**: `src/utils.js` (`COMMANDS` set + `HELP_TEXT`), `bin/cli.js` (new
`distill` dispatch case calling `distill.run`), `src/refresh.js` (import
`distill.run`, invoke non-fatally at the end of a refresh run — warn on
throw, never fail refresh's own exit code), `test/cli.test.js` and
`test/refresh.test.js` (additions).

**Design (decided)**:
1. Add `"distill"` to `COMMANDS` in `src/utils.js`.
2. Add a `distill` section to `HELP_TEXT`.
3. Add the dispatch case in `bin/cli.js`, mirroring the existing per-phase
   command wiring (same shape as `scan`/`charter`/etc.).
4. In `refresh.js`, import `distill.run` and call it non-fatally at the end
   of a refresh run: a thrown error is caught, warned via `log.warn`, and
   does not change refresh's own exit code or gate outcome.

#### Acceptance criteria
- AC1: `npx do-better --help` lists `distill` with its one-line description. *(Spawn test, `cli.test.js`-style.)*
- AC2: `npx do-better distill` dispatches to `src/distill.js`'s `run(ctx)`. *(Integration test.)*
- AC3: `refresh` still exits per its own contract when `distill.run` throws (warn-only, exit code unaffected). *(Integration test with a fake that errors on distill labels.)*
- AC4: **Composition test** (the reason this ticket waits for both T5 and T7): a single `refresh` run with `--eval-repro` unset correctly (a) skips re-executing eval-shaped stored repros — flagging them stale-unverifiable per T7 — **and** (b) still auto-invokes `distill.run` at the end of the same run. Both behaviors asserted in one integration test, proving the two independently-developed `refresh.js` changes don't silently break each other on merge. *(Integration test.)*
- AC5: Full suite green (`node --test`); T0 rails untouched.

**Depends on**: T5 merged to `main` **and** T7 merged to `main` (T7 is the
last ticket to touch `src/identify.js`/`src/utils.js`/`src/refresh.js` in
worktree 1 — this runs immediately after, still in worktree 1, before T8).
**Effort**: S (well under half a day). **Builder tier**: cheap.
**Partition**: `src/utils.js`, `bin/cli.js`, `src/refresh.js` — worktree 1,
single-writer, sequenced last in that worktree.

---

### T6 — Bounded concurrency for finder pools and verification

**Motivation**: R6. Wall-clock, not correctness.

**Scope**: `src/utils.js` (`mapLimit`), `src/identify.js` (apply),
`test/utils.test.js` (additions), `test/identify.test.js` (determinism
assertion).

**Design (decided)**:

1. `export async function mapLimit(items, limit, fn)` in `src/utils.js` —
   zero-dep, order-preserving results, first rejection propagates after
   in-flight tasks settle.
2. Apply to: (a) the N pooled finder calls within a pass (limit = N, ≤ 4);
   (b) per-candidate verification within a dimension (limit 4). Dimensions
   and packets remain sequential (keeps spend ordering and logs readable).
3. **Budget note (document, don't fix)**: `checkBudget` is
   check-then-record; under concurrency the ceiling can overshoot by at most
   `(limit − 1) × maxCallCost`. Acceptable and documented in a code comment
   + README budget row. Spend accumulation itself is single-threaded-safe
   (no await between read and write in `recordSpend`).
4. Determinism: pool admission order = lens index order (stable), regardless
   of completion order — sort results before admission.

#### Acceptance criteria
- AC1: `mapLimit` unit tests: order preserved, limit respected (concurrent counter probe), rejection propagates. *(Unit tests.)*
- AC2: Identify results (finding ids, files, state) byte-identical between `limit=1` and `limit=4` runs on the same scripted fake. *(Integration test.)*
- AC3: Full suite green (`node --test`).

**Depends on**: T2 + T3 merged (functional dependency: touches the
pool/verify paths they add) **and T4 merged** (correction — `merge-forecast`
run during ticket authoring scored T4/T6 as a hard-veto scope-overlap pair,
both touching `src/identify.js`; running them concurrently is unsafe
regardless of functional need, so `.adlc/tickets.json` carries an explicit
T4→T6 edge and this line matches it. An earlier draft of this plan claimed
"no functional dependency" and omitted the edge — that draft was wrong; the
edge is required for correct scheduling, not just documentation). **Effort**:
S. **Builder tier**: mid. **Partition**: `src/utils.js` + `src/identify.js`.

---

### T7 — Eval-repro is opt-in (`--eval-repro` flag, safe default)

**Motivation**: R7. The plan's own review called executing model-proposed
`node -e` code with full user privileges against a hostile brownfield repo
"unacceptable posture for enterprise engagements" — a default-off opt-in
flag would leave that posture as the shipped default for every operator who
doesn't discover the flag, contradicting "constraints in the tool layer are
facts; in the prompt layer are requests." **Decision (superseding the
original opt-out design): default flips to safe.**

**Scope**: `src/utils.js` (parseArgs + HELP_TEXT), `src/identify.js`
(`sanitizeRepro` gains an options arg), `src/refresh.js` (re-verification
must honor it for stored eval-shaped repros), `do-better/SKILL.md` +
`README.md` flag tables, `SPEC.md` addendum note (T8) recording the
default-flip as a locked decision, `test/identify.test.js` additions.

**Design (decided)**:

1. New boolean flag `--eval-repro` (**default `false` — the new safe
   default**). Unset (default): `sanitizeRepro` unconditionally rejects the
   `node -e` shape (falls through to blind reread — existing path; the
   functional cost is one extra frontier verdict call per candidate that
   would previously have used eval repro). `node --test` and grep shapes
   remain allowed unconditionally — they execute repo-authored code or no
   code at all, a different trust class than model-proposed `node -e`. Set:
   v0.1 behavior (eval proposals are sanitized and run).
2. Refresh: stored reproduction records of `method: "command"` whose `cmd`
   is eval-shaped are re-executed **only when `--eval-repro` is passed to
   `refresh`**; otherwise the finding is flagged stale-unverifiable with a
   declared reason. (This is the inverse of v0.1's default — call it out
   explicitly in the T8 SPEC addendum as a behavior change, not just a new
   flag.)
3. Record the flag in `state.json` run history (`beginRun` already records
   command/provider; add flags snapshot if trivially additive, else skip —
   the declared-degradation note in gate records is the requirement).

#### Acceptance criteria
- AC1: Without the flag (default), a proposed `node -e` repro is never spawned (assert via exec-spy) and the candidate proceeds to blind reread. *(Integration test.)*
- AC2: With `--eval-repro`, behavior matches v0.1. Note: T0 rails stay green under this AC only because T0's non-pin rule (see T0) forbids pinning exact pass/verified counts — those numbers can legitimately differ once eval repro is opted back in. *(Integration test.)*
- AC3: Refresh without the flag flags eval-repro findings as unverifiable with a reason, exit code unchanged; with the flag, re-executes them as v0.1 did. *(Integration test, both branches.)*
- AC4: Help/README/SKILL.md updated; README states the default explicitly and cites R7 as the reason. *(Spawn test: assert the flag and its default appear in help output.)*

**Depends on**: T4 merged (same `verifyCandidate` region) and T6 merged
(single-writer sequential order in worktree 1 — see §4). **Effort**: S.
**Builder tier**: mid. **Partition**: `src/identify.js` + `src/utils.js` +
`src/refresh.js`.

---

### T8 — Docs, spec addendum, version bump, prosecution

**Motivation**: Close the loop; keep SPEC as law.

**Scope**: `SPEC.md` (addendum section "v0.2.0 — D2 hardening", recording the
new locked decisions: packetized coverage, persisted per-cell dry state,
charter-weighted pool width via `--n`, semantic dedupe fail-open rationale,
NEED_CONTEXT bound, distill phase, **eval-repro flipped to safe-by-default**
— call this last one out explicitly as a behavior change from v0.1, not
just a new flag), `README.md` final pass (including the "Sizing `--budget`"
table from T1 AC9), `package.json` → `0.2.0`, CHANGELOG section in README or
new `CHANGELOG.md`.

#### Acceptance criteria
- AC1: SPEC addendum documents every behavior change shipped, in the D# locked-decision style. *(Reviewer check — `grep '## v0.2.0' SPEC.md`.)*
- AC2: `node --test` fully green; `npm pack --dry-run` includes no new unintended files.
- AC3: **Prosecution pass**: adversarial review of the full diff (`npx adversarial-review --base main`, exit 0) — run loop-until-dry per the house rule; all CRITICAL/HIGH findings resolved. Pass evidence recorded via `adlc prosecute` (two consecutive dry passes required, §2b); ledger sealed with `adlc gate-manifest verify`.
- AC4: **Distill the build itself**: run `lesson-foundry` over this build's verified review findings and `skill-rot` over `do-better/references/*` (stamps `last-verified` after the T1–T4 doc changes). Output committed or explicitly declared empty.

**Depends on**: everything (T0–T7 and T5b). **Effort**: S. **Builder tier**:
frontier for the prosecution verdicts, cheap for the mechanical doc sync.

---

## 4. Sequencing DAG

```
Worktree 1 (single-writer: src/identify.js throughout; src/utils.js +
            bin/cli.js + src/refresh.js at the tail via T7 then T5b):

  T0 ──▶ T1 ──▶ T2 ──▶ T3 ──▶ T4 ──▶ T6 ──▶ T7 ──┐
                                                     ├──▶ T5b ──▶ T8
Worktree 2 (disjoint from worktree 1 until T5b):    │
  T5 ─────────────────────────────────────────────┘
```

Every ticket in worktree 1 (T0…T7) runs **strictly sequentially in the
listed order** — this is the single-writer rule for `src/identify.js`
(T0–T7 all touch it except T0, which precedes it) and, at the tail, for
`src/utils.js`/`bin/cli.js`/`src/refresh.js` (T7 edits `refresh.js`, then
T5b edits `utils.js`, `bin/cli.js`, **and** `refresh.js` again). Do not fan
T1–T7 to separate concurrent worktrees; the merge conflicts cost more than
the parallelism buys. Individual "Depends on" lines in §3 record the real
edges — including T4→T6, which `merge-forecast` scored as a hard-veto
scope-overlap pair (both touch `src/identify.js`) during ticket authoring,
not merely an operational-sequencing convention layered on top of a looser
functional dependency. Where §3 states a ticket's functional need is
narrower than the edge actually encoded (e.g. T6's functional need is only
T2+T3; the T4 edge exists purely to prevent unsafe concurrent scheduling),
it says so explicitly, so a coldstart agent reads the edge as required
scheduling, not an inferred artifact.

T5 runs in worktree 2 from day one on a **verified-disjoint source-file**
set — `src/distill.js`, `src/state.js`/PHASES, `src/artifacts.js`/LAYOUT —
none of which worktree 1 touches. **`src/refresh.js` is explicitly NOT part
of T5's scope** (a round-2 review finding: T5 originally claimed it, but T7
— worktree 1 — also edits it; T5's own distill logic lives entirely in
`src/distill.js`, which `refresh.js` is only ever *wired into* by T5b).
T5b (CLI + refresh wiring) is worktree 1's job and runs only after **both**
T5 (worktree 2) and T7 (worktree 1, last to touch `refresh.js` there) have
merged to `main` — see T5b's composition-test AC.

**`.adlc/manifest.jsonl` is not part of either worktree's file set at
all** (a round-3 review finding: "disjoint source files" does not by itself
make the shared ledger safe). Neither worktree ever writes it — per §2b,
every gate that touches the shared manifest runs the *check* pre-merge
(ledger-blind) and the *record* post-merge, serialized, from `main` only.
The two-worktree split is safe for source files; it was never meant to
extend to the ledger, and now doesn't.

This split is a *forecast*, not a fact, until certified:
`merge-forecast --tickets .adlc/tickets.json --width 2` (§2b S0.6) has the
final word — a SEQUENCE verdict collapses everything to one worktree.

Worktree conventions: `.worktrees/<name>`, branch `feat/<ticket-id>-<slug>`,
per the standing worktrees rule; **`handoff.md` and `.adlc/tickets.json`
must already be committed to `main` (§2b S0.0) before any worktree is
created** (`.adlc/manifest.jsonl` stays untracked, per S0.0); build gate
(`node --test`) before any merge; rebase the remaining worktree after each
merge. **Gate discipline (§2b): blocking checks (rails-guard without
`--record`, hollow-test, flail-detector, prosecute) run inside the ticket's
own worktree, pre-merge; ledger writes (`gate-manifest record`,
`gate-manifest verify`) run from the `main` checkout ONLY, immediately
after that ticket's merge — never batched, never from inside a worktree.**

## 5. Cross-ticket contracts (the interfaces; do not invent others)

- `partitionSlices(slices, maxBytes)` (T1) → `[{files: string[], packet: string}]` — consumed by T2's pool loop.
- Pool admission function signature after T3:
  `admitCandidate(cand, {seen, pool, priorFindings, llm, log})` → `Promise<boolean>` (admitted). T6 must not parallelize *admission* (ordering), only the finder calls that feed it and verification after it.
- Candidate shape after T4 (superset of v0.1):
  `{dimension, title, claim, file, line, severity, confidence, method, check, citations?: [{file,line}]}`.
- Verdict JSON after T4:
  `{"verdict":"CONFIRM"|"KILL"|"UNCERTAIN"|"NEED_CONTEXT","reason":"...","files"?:[...]}` — NEED_CONTEXT valid only on round 1.
- `controls.json` v1 shape as specified in T5 §5.
- State additions: `phases.identify.packetsByDimension` (T1);
  `"distill"` in `PHASES` + `phases.distill` (T5). Everything pinned by T0
  rails must survive.
- Constants stay exported from `identify.js`: `K_DRY`, `MAX_PASSES`,
  `PHASE_ID`, `dedupeKey`, plus new `partitionSlices`.

## 6. Verification protocol (applies to every ticket)

Mechanical gates from §2b run first; the items below are what they enforce
(and the manual fallback when a tool can't run — declared, never silent):

1. TDD: acceptance-criteria tests written first, red, then green.
2. `node --test` — full suite, zero network (fake-LLM seam / `--offline`).
3. T0 rails green and untouched — enforced **pre-merge**, in the ticket's
   worktree, by `adlc rails-guard --base main --ticket <id>` (no
   `--record` — the rails-diff-empty proof is written to the shared ledger
   in a separate, serialized post-merge step from `main`, per §2b); manual
   fallback: `git diff main -- test/` shows only ticket-named additions.
4. New tests are not hollow — `adlc hollow-test --test-cmd "node --test"`,
   pre-merge in the worktree, exit 0.
5. Fresh-context reviewer (not the builder) per ticket, **before that
   ticket's branch merges**: correctness, fail-closed discipline,
   SKILL.md/README sync, no scope creep. Passes are recorded via
   `adlc prosecute --ticket <id> --dir .adlc` (ticket-scoped
   `passes.json`, not the shared ledger), which exits 2 until two
   consecutive dry passes — the ticket does not merge until this exits 0
   (§2b). Immediately after merge, `adlc gate-manifest record` (run
   from `main` — §2b) appends the evidence for rails freeze, test quality,
   and review to the shared chain.
6. Final gate before merging **T8's own** branch to `main`: T8's prosecution
   pass, exit 0, and `adlc gate-manifest verify` over the full
   (already-merged) evidence chain.
7. Smoke: `npx . run --offline` against `test/fixtures/tiny-repo` (copied to
   a tmp git repo) completes D-1→D2 with declared degradations and non-empty
   coverage manifest including the new `## D2 finder coverage` section.

## 7. Risks & watch items

- **Cost blow-up (T1×T2)**: packets × pools multiplies calls — the floor
  after T1+T2 is `dims × packets × K_DRY × charterPoolWidth`, materially
  above v0.1's `dims × K_DRY`. **Shipped mitigations (pulled into scope,
  not deferred — cost review)**: charter-weighted pool width (T2 design
  item 1) caps low-weight dimensions at N=1; persisted per-cell dry state
  (T1 design item 8) makes a `BudgetError` resumable instead of
  restart-from-zero; the README "Sizing `--budget`" table (T1 AC9) gives
  operators the arithmetic up front. `--n 1` remains an absolute-minimum
  escape hatch on top of these. If real-world runs are still too costly,
  the next knob is charter-weighted packet *depth* (fewer packets for
  low-weight dimensions) — **not** silent sampling; that would need its own
  ticket, out of scope here.
- **Dry-streak semantics drift**: after T2+T3, "dry" = pooled, semantically
  deduped zero-new per (dimension × packet). Keep the summary line explicit
  about this so gate records stay self-describing.
- **`identify.js` size**: T1–T4 will push it past the ~800-line ceiling.
  Extract `src/identify-verify.js` (verification stages) and/or
  `src/identify-packets.js` when crossing it — mechanical extraction, same
  exports re-exported from `identify.js`, do it inside whichever ticket
  crosses the line, with tests untouched.
- **Fail-open dedupe (T3)** is deliberate and bounded; if prosecution flags
  it, the answer is the rationale in T3 §2, not a silent flip to fail-closed.
- **First-run cost blow-up (premortem finding)**: T1's persisted dry-cell
  state (design item 8) only helps a *resumed* run after `BudgetError` — it
  does nothing for the first attempt against a target repo larger than the
  README sizing table's assumed shape (~5 packets/dimension). A real
  monorepo could be 20-50 packets/dimension, exhausting `--budget` before D2
  completes and producing no roadmap at all. No ticket adds a mid-run
  downgrade path (e.g. drop pool width or packet depth on a budget warning
  rather than a hard `BudgetError`). Flagged, not fixed — out of scope for
  v0.2.0; revisit if real engagements hit this.
- **Worktree-1's serial chain is a single point of failure (premortem
  finding)**: T0→T1→T2→T3→T4→T6→T7 has no parallelism by design (§4). A
  flail-detector two-strike escalation on any one ticket blocks every
  downstream ticket, including T5b (which also needs T5, already sitting
  finished in worktree 2). No contingency is documented for what
  re-decomposing a mid-chain ticket like T4 would even look like. Mitigate
  operationally by keeping worktree-1 tickets scoped tightly (already true —
  effort S/M predominates except T1/T4) rather than by plan changes here.
- **Merge-forecast certification can go stale (premortem finding)**: S0.6's
  width=2 certification is computed from *declared* ticket scope. T4's
  `src/artifacts.js` edit is explicitly conditional ("if `writeFinding`/
  `readFindings` don't already round-trip an evidence array, edit it"). If
  that condition triggers, T4's actual diff could touch a file the
  certified schedule assumed was untouched, without any re-certification
  step required before merge. Mitigation: re-run `merge-forecast` if any
  ticket's actual diff exceeds its declared `scope` array — add this as an
  explicit pre-merge check in §6 rather than trusting the point-in-time S0.6
  certification for the whole build.
- **Distill is unvalidated against real output (premortem finding)**: T5's
  acceptance criteria all use scripted fixtures. Nothing in this plan runs
  `do-better` end-to-end against a real target repo before v0.2.0 ships, so
  distill's actual clustering quality on genuine LLM-generated findings is
  unproven at ship time. Recommend T8 add a manual smoke run (`do-better run`
  against a real repo, then `do-better distill`) as a release gate, even
  though no ticket currently requires it — flagged for the human at HUMAN
  GATE 2 (roadmap approval) equivalent, not mechanically enforced here.
