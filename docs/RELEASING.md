# Development and canary releases

## Local validation

```sh
pnpm install --frozen-lockfile
pnpm check
npm pack --dry-run
```

`pnpm check` is the release gate. The dry run must contain only compiled `dist` artifacts,
`README.md`, `LICENSE`, and package metadata.

Use `pnpm clean` to remove build output, API Extractor temporary files, coverage, runtime fixture
builds, and local package tarballs.

## Manual canary release

Canaries use semantic prerelease versions and the npm `next` tag.

1. Update `version` in `package.json` and the lockfile.
2. Update generated deployment inputs when the release changes presets.
3. Run `pnpm check` and review `npm pack --dry-run`.
4. Commit and push the versioned release to `main`.
5. Dispatch the GitHub `release` workflow.
6. Confirm the published npm version and install it in a clean runtime fixture.

The workflow publishes with npm provenance. Do not commit `.tgz` files or run publication from a
developer machine unless recovering from an explicitly documented release failure.
