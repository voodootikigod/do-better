# Reproduce-or-Kill — D2 Verification Protocol (F4 defense)

Verification is separated from finding. The agent (or pass) that proposed a
candidate never judges it. Every candidate is either **reproduced** — and
becomes a verified finding with a reproduction record — or **killed** and
counted. There is no third bucket: *unverified findings never reach output.*

## Evidence-citation rules (apply everywhere, not just D2)

1. **Canonical citation format**, inline in every artifact body:

   ```
   path/to/file.js:123@a1b2c3d
   ```

   `path` is repo-relative, `line` is 1-based, `@sha` is the 7–40 hex commit
   sha the claim was read at. A claim is pinned to the code as it was, so
   `refresh` can detect when the ground moved under it.

2. **Deterministic verification, no LLM.** A citation verifies iff the file
   exists in the worktree and `1 ≤ line ≤ line count`. This is a filesystem
   check, never a model judgment.

3. **Every finding carries ≥ 1 verified citation.** A claim line whose
   citations all fail verification is removed and logged. Behavior-inventory
   entries with zero verified citations are dropped with a warning.

4. **Stale ≠ trusted.** When `refresh` finds a cited file changed since the
   pinned sha, the claim is flagged stale, not silently believed (skill-rot
   doctrine: a stale claim is misinformation with the voice of authority).

## The protocol, per candidate

### Step 1 — Citation check (deterministic)

Verify the candidate's citation per the rules above. Fails → **killed**. No
appeal: a finder that cited a nonexistent location fabricated evidence.

### Step 2 — Mechanical reproduction (preferred)

If the claim is mechanically checkable, ask the model to propose a `reproCmd`
from a **whitelist of shapes** — nothing outside it is ever executed:

- `node --test <file>` — run an existing test file.
- `node -e "<snippet>"` — a self-contained check, snippet ≤ 500 chars.
- A grep-equivalent pattern check, executed natively (no shell).

Execution discipline: `cwd` = repo root, no shell (`shell:false`), 30-second
timeout, stdout/stderr and exit code recorded verbatim. The command
demonstrating the claim succeeds → **verified**, `method: "command"`, the full
record stored in the finding.

### Step 3 — Blind re-read (for non-runnable claims)

Design and debt claims can't run. For these, a **fresh frontier context** —
which has seen none of the finder's reasoning — receives only:

- the bare claim (title + one-paragraph claim text), and
- the cited code slice: the cited line ± 40 lines.

It re-derives a verdict from the code alone:

- **CONFIRM** — the code, read cold, supports the claim → verified,
  `method: "reread"`, the verdict rationale recorded.
- **KILL** — the code does not support the claim → killed.
- **UNCERTAIN** — cannot confirm from the slice → **killed**. Uncertainty is
  not a finding.

The blindness is load-bearing (F2): a verifier shown the proposer's reasoning
rubber-stamps it. Withhold everything but the claim and the code.

### Step 4 — Fail closed

- Unparseable verdict → killed.
- Repro command errors, times out, or exits unexpectedly without demonstrating
  the claim → killed.
- Offline mode: only candidates whose reproduction is a deterministic native
  check survive (`method: "static"`); everything requiring model judgment is
  killed for the run and may be re-found online later.

Killed candidates are **counted** (per dimension, in state) but never written
as findings. The kill count is diagnostic, not shameful — a healthy finder
over-generates and a healthy verifier prunes hard.

## The reproduction record

Every verified finding stores, in frontmatter and body:

```
reproduction:
  method: command | reread | static
  record: <the command + captured output, or the verdict rationale>
  exitCode: <integer or null>
```

The record is what makes the finding **re-checkable**: `refresh` re-runs
`command`/`static` reproductions and re-verdicts `reread` ones against the
fresh slice. A finding that no longer reproduces is marked RESOLVED and its
roadmap item flips to done — the living-document loop closes only because
every finding ships with the means of its own re-verification.

## The gate

D2 passes its deterministic gate iff:

1. every `(dimension × packet)` cell went dry within `MAX_PASSES` (see
   [refute-charter.md](./refute-charter.md)) — the deep-read set is partitioned
   into packets and each cell loops-until-dry independently, so the gate detail
   names the dimension *and* the packet that stalled, and
2. the count of unverified findings written is exactly **zero** — true by
   construction, asserted anyway.

An empty or unreadable deep-read set online is also a gate failure (exit 2):
with no packets to examine, "dry" would be vacuously true, so starvation is
surfaced rather than passed silently. Offline is exempt — it consumes no
packets and runs a single deterministic static pass per dimension.

Either condition failing is exit 2. The findings count is never a success
metric (D11); ten verified findings beat a hundred plausible ones.
