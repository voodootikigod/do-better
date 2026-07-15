---
name: release
description: Release a new version of do-better (bumps version, tags git, pushes; the publish workflow ships it to npm)
user-invocable: true
metadata:
  version: 1.0.0
  internal: true
---

# Release

Use this command to release a new version of `do-better` to npm.

Publishing itself is automated: pushing a `vX.Y.Z` tag triggers
`.github/workflows/publish.yml`, which verifies the tag is an ancestor of
`main` and matches `package.json`, runs tests, and publishes with
`--provenance --access public` via npm's OIDC trusted publishing (falling
back to the `NPM_TOKEN` environment secret only if trusted publishing isn't
configured yet — see `docs/github-rulesets/README.md`). The publish job runs
under the `npm-publish` protected environment, which requires a reviewer to
approve it before it runs. This command's job is to bump, tag, and push
correctly.

## Arguments

- First positional argument: version bump type — `patch`, `minor`, or `major`. Defaults to `minor`.

## Steps

1. **Determine the new version.** Read the current version from `package.json` and apply the requested semver bump (default `minor`).

2. **Verify preconditions:**
   - Working tree is clean (`git status --porcelain` is empty)
   - On the `main` branch (`git branch --show-current`)
   - Up to date with remote (`git fetch` then confirm no divergence)
   - Tests pass (`npm test`)

3. **Bump the version:**
   ```bash
   npm version <patch|minor|major> --no-git-tag-version
   ```
   This atomically updates the `"version"` field in both `package.json` and `package-lock.json`.

4. **Commit the bump:**
   ```bash
   git add package.json package-lock.json
   git commit -m "chore: bump version to X.Y.Z"
   ```

5. **Create the tag:** `vX.Y.Z` (must match `package.json` exactly — the workflow enforces this). Tag creation is restricted by the `release tags` GitHub ruleset to admins — this push succeeds for a maintainer and is refused for anyone else.

6. **Push commit and tag:**
   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```

7. **Confirm completion.** Print:
   - Previous version → new version
   - Tag created
   - A reminder that the tag push triggers `.github/workflows/publish.yml`, but the job waits under the `npm-publish` protected environment for a reviewer to approve it — point the user at the repo's Actions tab.
   - If the publish job fails with `ENEEDAUTH`, npm trusted publishing isn't configured yet for `do-better` on npmjs.com — see `docs/github-rulesets/README.md` § "npm trusted publishing (OIDC)".
