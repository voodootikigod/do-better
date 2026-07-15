# npm Publish Gates

Reproducible protection for the npm release path, expressed as GitHub
[ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets)
JSON so the configuration lives in version control instead of only in the GitHub UI.

Ported from the `antigravity-booster` repo.

## Scope: publish gates only

do-better does not currently version-control (or have) branch protection on
`main` — it's a solo-maintainer repo where releases are pushed directly via the
`/release` skill. This directory only provisions the publish-path gates: the tag
ruleset and the `npm-publish` environment. It does not add PR review requirements
or restrict pushes to `main`.

## Files

- `release-tag-ruleset.json` — protects `v*` release tags (the publish trigger).
- `apply.sh` — provisions the `npm-publish` environment and applies the tag ruleset
  via `gh api` (requires admin auth).

## What the release-tag ruleset enforces

`creation` + `deletion` + `non_fast_forward` on `refs/tags/v*`, with admins as the
only bypass actors. This restricts who can create release tags.

This rule is load-bearing: `.github/workflows/publish.yml` triggers **only** on a
`v*` tag push (it deliberately has no `workflow_dispatch`), so the workflow content
that runs is always the admin-controlled tagged commit. Restricting tag creation to
admins therefore restricts who can publish to npm.

The **`npm-publish` protected environment** (below) is the second layer — a required
human approval plus a deployment-ref allowlist on top of the tag gate. Any npm
credential must be an **environment-scoped secret** so it is unreadable outside that
environment.

## Applying

Requires the `gh` CLI (admin auth) and `jq`.

```sh
gh auth status            # must have admin on the repo
REPO=voodootikigod/do-better ./apply.sh
```

`apply.sh` does two things:

1. **Provisions and verifies the `npm-publish` protected environment** — the real
   publish gate. It sets required reviewers and a **deployment-ref allowlist**, then
   **fails closed** unless both are actually present after the API call. This matters
   because a workflow that references a missing environment silently creates it
   *unprotected*.

   - **Required reviewers** (`REVIEWER_IDS`, default the authenticated user; 1–6
     numeric IDs, validated locally and re-checked against the API response) — a
     human approval gate on every publish.
   - **Deployment refs** (`ALLOWED_BRANCHES` default `main`, `ALLOWED_TAGS` default
     `v*`) — constrains *which code* can be published.

   ```sh
   REVIEWER_IDS=123,456 ALLOWED_TAGS="v*" ALLOWED_BRANCHES="main" \
     REPO=voodootikigod/do-better ./apply.sh
   ```

2. **Applies the release-tag ruleset idempotently** — it matches the ruleset by
   name and updates the existing one (`PUT /rulesets/{id}`) instead of creating a
   duplicate, and refuses to act if two active rulesets already share a name. A
   re-run never strands a stale active ruleset.

Verify afterward:

```sh
gh api /repos/voodootikigod/do-better/environments/npm-publish | jq .protection_rules
gh api /repos/voodootikigod/do-better/rulesets
```

## npm trusted publishing (OIDC)

`apply.sh` cannot configure this — it lives on npmjs.com, not GitHub. Do it once,
by hand:

1. Go to <https://www.npmjs.com/package/do-better/access> →
   **Trusted Publisher** → **GitHub Actions**.
2. Set:
   - Organization/user: `voodootikigod`
   - Repository: `do-better`
   - Workflow filename: `publish.yml`
   - Environment: `npm-publish`
3. Save, then **delete the `NPM_TOKEN` environment secret** if one was set for the
   bootstrap publish. With trusted publishing configured, `NODE_AUTH_TOKEN` resolves
   empty and npm mints a short-lived registry token from the GitHub OIDC id-token
   instead — no long-lived credential to leak or rotate.

The workflow already requests `id-token: write` and upgrades to npm 11, both of
which are required for OIDC to work.

## Not expressible as rulesets

Set these in the GitHub UI:

- **Settings → Actions → General → Workflow permissions:** default `GITHUB_TOKEN`
  to read-only. (`publish.yml` already requests its own `id-token: write`.)
- **Settings → General → Pull Requests:** allow squash merging only; enable
  automatically delete head branches.
