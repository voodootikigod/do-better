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
`.github/workflows/publish.yml`, which verifies the tag matches
`package.json`, runs tests, and publishes with provenance using the
`NPM_TOKEN` repo secret. This command's job is to bump, tag, and push
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
   - `NPM_TOKEN` is configured in the repo's Actions secrets (`gh secret list`) — the publish will fail without it

3. **Bump the version:** update the `"version"` field in `package.json`.

4. **Commit the bump:**
   ```bash
   git commit -am "chore: bump version to X.Y.Z"
   ```

5. **Create the tag:** `vX.Y.Z` (must match `package.json` exactly — the workflow enforces this).

6. **Push commit and tag:**
   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```

7. **Confirm completion.** Print:
   - Previous version → new version
   - Tag created
   - A reminder that the GitHub Actions publish workflow (`.github/workflows/publish.yml`, triggered on `v*` tags) will publish to npmjs automatically. Point the user at the Actions tab to watch it.
