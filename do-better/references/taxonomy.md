# The Fixed Taxonomy Floor (D5)

Eight dimensions of "better," in canonical order. This is the **floor**, not a
menu: every engagement charter MUST carry a weight (1–5) for every dimension
below. The charter interview (D0) may *weight* dimensions and *add*
engagement-specific ones, but it may never drop one — the floor exists to
prevent charter blind spots ("nobody asked about security, so nobody looked").
A synthesized charter missing a dimension is corrected to weight 1 with a
`(floor)` note, never dropped.

Each section below is the **finder charter** for that dimension: what a
D2 finder chartered on this dimension hunts for, and what counts as concrete
evidence. Finders operate under the refutation doctrine in
[refute-charter.md](./refute-charter.md) — they are told to *disprove* the
claim that the codebase is acceptable on the dimension, with file:line
citations for every claim.

Canonical ids (used in charter weights, finding ids, and ticket categories):
`correctness`, `security`, `maintainability`, `performance`, `operability`,
`test-quality`, `dependency-health`, `dx`.

## Correctness risk

`id: correctness`

Hunt for code that can silently produce wrong results: unhandled error paths,
swallowed exceptions, race conditions and unsynchronized shared state, off-by-one
and boundary errors, implicit type coercions at trust boundaries, null/undefined
dereferences on optional data, time-zone and floating-point hazards, partial
writes without transactions or rollback, retry logic that double-applies effects,
and logic that contradicts the documented or evident intent (comments, names,
tests asserting one thing while code does another). Evidence is the exact
file:line where the wrong result can be produced, plus the input or sequence that
triggers it. The strongest correctness findings come with a runnable
reproduction; propose one whenever the claim is mechanically checkable.

## Security

`id: security`

Hunt for ways an attacker — external or internal — gains capability they should
not have: injection (SQL, shell, template, path traversal), missing or bypassable
authentication/authorization checks, secrets in source or config committed to the
repo, unvalidated input crossing a trust boundary, unsafe deserialization,
`eval`/dynamic-require on tainted data, child processes built from string
concatenation, permissive CORS, missing rate limits on state-changing endpoints,
sensitive data in logs or error messages, and outdated crypto or homegrown
crypto. Cite the exact sink and the path tainted data takes to reach it. Severity
tracks exploitability × blast radius, not theoretical purity.

## Maintainability / debt

`id: maintainability`

Hunt for structures that make every future change slower or riskier: god files
and god functions, copy-paste clones that must be changed in lockstep, cyclic
dependencies, dead code that still has to be read, abstraction layers that leak
or that exist for exactly one caller, configuration scattered across hardcoded
literals, naming that lies, TODO/FIXME/HACK clusters that mark known unfinished
surgery, and modules whose churn history shows repeated bug-fix commits (hot,
fragile code). Evidence is structural and locational — name the files, the line
ranges, and where possible the churn or clone counterpart that proves the cost
recurs.

## Performance

`id: performance`

Hunt for work the system does that it does not need to do, at the moments it can
least afford it: N+1 query patterns, unbounded result sets, synchronous I/O on
hot paths, O(n²) loops over data that grows, missing indexes implied by query
shapes, per-request recomputation of invariants, oversized payloads, chatty
service calls inside loops, memory retained beyond its useful life, and absent
caching where reads dwarf writes (or caching with no invalidation where writes
matter). Claims must name the code path and the scaling variable that makes it
hurt; "this could be slow" without a growth factor is not a finding.

## Operability

`id: operability`

Hunt for everything that makes the system hard to run, observe, and recover:
missing or useless logging at failure points, no health/readiness signals,
swallowed errors that turn outages into mysteries, absent timeouts and circuit
breakers on outbound calls, no graceful shutdown, configuration that only works
on one machine, deploy and migration steps that exist only in someone's head,
unbounded queues and retries that amplify incidents, and startup that fails
late instead of failing fast on missing prerequisites. Evidence cites where the
signal is missing (the catch block that drops the error, the fetch with no
timeout) — absence is locational too.

## Test quality

`id: test-quality`

Hunt for the gap between what the test suite appears to guarantee and what it
actually guarantees: load-bearing behaviors with no test at all (cross-check the
behavior inventory and rails map), tests with no assertions or assertions that
cannot fail, tests that mock the very thing under test, snapshot tests nobody
reads, flaky patterns (sleeps, ordering dependence, shared mutable fixtures),
test code that swallows errors, and suites that pass with the implementation
deleted (hollowness). Evidence cites the test file and line, and names the
production behavior left unguarded. Coverage percentage alone is never evidence.

## Dependency health

`id: dependency-health`

Hunt for risk imported through the dependency graph: dependencies past
end-of-life or unmaintained, known-vulnerable version ranges, lockfile drift or
absence, duplicate dependencies solving the same problem, deep coupling to a
dependency's internals (imports from `dist/` or private paths), licenses
incompatible with the engagement's constraints, and single points of failure
(one maintainer, one registry). Flag what can be verified from manifests and
lockfiles deterministically; mark CVE/EOL claims that require network
verification as "needs verification" rather than asserting them — see
[verification.md](./verification.md).

## Developer experience

`id: dx`

Hunt for friction that taxes every contributor on every change: setup that takes
hours or requires tribal knowledge, build/test cycles measured in tens of
minutes, incantations that exist only in CI config or shell history, missing or
lying README instructions, inconsistent formatting with no enforcement, error
messages that don't say what to do, slow or noisy CI that trains people to
ignore it, and onboarding gaps the glossary and codemap expose. Evidence is the
concrete command, file, or absence — "DX is bad" is vibes; "`npm test` takes 14
minutes because X (file:line)" is a finding.
