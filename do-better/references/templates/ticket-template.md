# Ticket Template — `.dobetter/backlog/<id>.md` (D3 output)

One markdown file per Now/Next roadmap item, **plus** the machine mirror
`backlog/tickets.json` in the exact ADLC `.adlc/tickets.json` schema
(`{ "tickets": [ { id, title, body, scope, rails, edges, duration, category,
budget? } ] }`). The JSON is the source of truth consumed by `coldstart
--tickets .dobetter/backlog/tickets.json` and ADLC P3/P4 intake; the markdown
is the human-review surface. The two are written together and must agree.

A ticket must be **self-contained**: a fresh agent with only this ticket (and
the repo) can execute it. That is what the coldstart gate tests. Embed data
shapes, contracts, and file paths — never reference "the discussion" or "as
mentioned above."

```markdown
---
id: T<n>
title: <short imperative title>
category: <dimension id of the driving finding>
duration: <relative build-time estimate, positive number>
scope: [<glob>, ...]
rails: [<path>, ...]
---

# T<n> — <title>

## Motivation

<Why this work exists, linking every driving finding:
[F-SEC-0003](../findings/F-SEC-0003.md). Quote the risk-of-inaction. A ticket
whose motivation cites no finding is not a do-better ticket.>

## Acceptance criteria

<Each criterion is machine-verifiable and NAMES its verification method (F1
defense). One bullet per criterion, exactly one method each:>
- <criterion> — verified by: <a test to be written at `<path>`>
- <criterion> — verified by: <a command whose output is asserted: `<command>` → <expected>>
- <criterion> — verified by: <a behavior demonstrated: <observable before/after>>

## Scope

<The declared file globs this ticket may touch, one per line, matching the
frontmatter `scope` array. Work outside scope is escalation, not improvisation.>

## Rails

<The characterization rails that must stay green while executing this ticket
(paths matching the frontmatter `rails` array — frozen, hollow-audited; see
rails/manifest.md). D4 appends authored rail paths here mechanically.>

## Dependencies

<One line per edge: `T<m> — contract: <path/to/contract/file>` meaning this
ticket must complete before T<m>, with the named file as the interface between
them. "None" if independent. Mirrors `edges` in tickets.json.>

## Partition hints

<How to split execution contexts if the ticket is run by parallel agents: which
files group together, what must be sequential. Optional but recommended.>

## Suppression allowances

<Optional `allow-suppression: <marker>` lines, one per allowed lint/test
suppression marker this ticket may legitimately introduce. Omit the section if
none — absence means zero suppressions allowed.>

## Coldstart

<Gate record: `clean` (round N) or `failed — demoted to Later`, with the gap
list from the coldstart run. Written by the tool, kept current on re-runs.>
```

Validation (mirrors aidlc `validateTicket`, applied before writing): string
`id` and `title` required; `scope`/`rails` arrays; every `edges[].to` a string
naming a known ticket id; `duration` a positive number. An invalid ticket gets
one repair round, then is demoted to Later with a warning.
