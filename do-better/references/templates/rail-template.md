# Rail Template — Characterization-Test Authoring (D4)

A **rail** is a characterization test that pins a behavior exactly as it is
today, so execution work can prove it broke nothing. Rails are authored in a
**fresh context** that sees ONLY: the behavior-inventory entry, the boundary
I/O shape, and this template — never implementation internals (P3
separate-context doctrine). A rail written by someone who read the
implementation tests the implementation's opinion of itself.

## Where rails live

- File: `<repo>/test/dobetter-rails/<behaviorId>.rail.test.js` (or the repo's
  idiomatic test directory if one is detected — rails run under the repo's own
  runner or `node --test`).
- Pointers only in `.dobetter/rails/manifest.md`; the tests live in the repo's
  test tree and ship with it.

## Authoring rules

1. **Boundary-level golden-master style.** Capture the behavior at its
   observable surface, by kind:
   - `route` — start the app locally, hit it with builtin `fetch`, assert
     status + headers that matter + body (normalized for timestamps/ids).
   - `cli` — spawn the command (`spawnSync`, no shell), assert exit code,
     stdout, stderr.
   - `job`/`event` — invoke the entry, assert emitted effects.
   - `db-write` — snapshot relevant rows before, run, assert the after-state
     delta.
2. **Bug-compatible pinning.** Assert the *current actual* output, even when it
   is odd or known-wrong. Annotate, don't fix:

   ```js
   // pinned current behavior, possibly a bug: see F-CORR-0007
   assert.equal(res.status, 200); // (spec says 404; current code returns 200)
   ```

   Rails preserve behavior; the roadmap changes it. A rail that asserts the
   *desired* behavior is red on arrival and useless as a rail.
3. **Deterministic.** Normalize or freeze time, ids, ordering, and environment.
   A flaky rail is worse than no rail — it trains people to ignore red.
4. **One behavior per rail file.** Named by behavior id (`B-014.rail.test.js`),
   header comment citing the inventory entry and its citation
   (`path:line@sha`).
5. **Self-contained setup.** The rail starts/seeds what it needs and tears it
   down; it must pass on a fresh clone where preflight is green.

## Quality gates the rail must survive

- **Green on current code** — any rail red after 2 fix rounds is deleted and
  the behavior recorded as `gap: could not pin`. Never ship a red rail.
- **Hollow-test audit** — mutants in the rail's assertions must be killed. A
  rail that passes with its assertions mutated is fog, not glass; survivors get
  one fix round, then the rail is deleted and the gap recorded. When
  hollow-test is unavailable: deletion spot-check (comment out the behavior's
  entry line; the rail must go red).
- **Frozen** — once green and audited, the rail path is appended to every
  backlog ticket's `rails` array so ADLC rails-guard freezes it mechanically.
  Execution agents may not edit rails; a rail change is a human decision.

## Manifest row shape — `.dobetter/rails/manifest.md`

One table row per authored rail:

```markdown
| behavior | rail file | style | pinned-at SHA | audit | frozen |
|---|---|---|---|---|---|
| B-014 | test/dobetter-rails/B-014.rail.test.js | http golden-master | a1b2c3d | hollow: killed 4/4 | yes |
| B-021 | test/dobetter-rails/B-021.rail.test.js | cli golden-master | a1b2c3d | spot-check | yes |
```

`audit` values: `hollow: killed n/n` · `spot-check` · `unaudited (hollow-test
absent)`. Below the table, a `## Gaps` section lists every targeted behavior
without a green rail and why (`could not pin`, `env not runnable`, `vacuous —
deleted`). A gap declared is a known risk; a gap omitted is a lie.
