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

## First publish (bootstrap)

### The scope must match the npm org

The npm org is `medievaltech`, with no hyphen, so the package is `@medievaltech/cage-calls-sdk`.
The GitHub org is `medieval-tech`, *with* a hyphen. The two names differ and that is intentional.

The package was originally named `@medieval-tech/cage-calls-sdk`, matching the GitHub org rather than
the npm org. `@medieval-tech` is not a registered scope, so the 2026-07-15 release dispatches failed
on the publish step with:

```
npm error 404 Not Found - PUT https://registry.npmjs.org/@medieval-tech%2fcage-calls-sdk
```

Every prior step passed. A `404` on `PUT` means the scope does not exist or the credential cannot
write to it — not that the build is broken. Verify membership before assuming a build problem:

```sh
npm login
npm org ls medievaltech
```

### Publishing requires 2FA

npm rejects publishes from accounts without two-factor auth:

```
npm error 403 Two-factor authentication or granular access token with bypass 2fa enabled is required
```

Either enable 2FA on the account and pass `--otp=<code>`, or publish with a granular access token
that has read/write on `@medievaltech/*` and 2FA bypass enabled.

### Route A — bootstrap through CI (keeps provenance)

1. Create a granular access token on npmjs.com with read/write on `@medievaltech/*`, 2FA bypass
   enabled, and a short expiry. Classic automation tokens are being restricted and the failed runs
   already logged that deprecation warning.
2. Store it on the `npm` GitHub environment:
   `gh secret set NPM_TOKEN --env npm --repo medieval-tech/cage-calls-sdk`
3. Dispatch the `release` workflow.

### Route B — bootstrap from a developer machine

This is the "documented release failure" exception to the rule above. `.npmrc` sets
`provenance=true`, and provenance requires CI OIDC, so a local publish must opt out of it:

```sh
npm publish --access public --tag next --provenance=false --otp=<code>
```

Only the bootstrap version loses its provenance attestation; every later release keeps it.

Publish from this repository, not from any other clone on the machine. Confirm the version first —
`node -p "require('./package.json').version"` must match the version you intend to release.

### After the package exists

Configure the npm trusted publisher (package settings -> Publishing access -> GitHub Actions,
repository `medieval-tech/cage-calls-sdk`, workflow `release.yml`, environment `npm`), then delete
the `NPM_TOKEN` secret if Route A created one. The workflow already requests `id-token: write` and
pins npm `>=11.5.1`, so no workflow change is needed.

Once published, move the client off the GitHub release tarball in `client/package.json` and onto the
registry version.
