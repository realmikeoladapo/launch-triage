# First release bootstrap

The npm package does not exist yet, so npm has no package settings page where a
trusted publisher can be configured. The first publication must be a deliberate
manual bootstrap. Later releases can use the OIDC workflow.

## Before publication

1. Commit the reviewed release files and push them to `main`.
2. Wait for every CI version to pass.
3. Confirm `package.json` and `action.yml` both pin version `1.1.0`.
4. Sign in with `npm login`, then confirm the intended account with `npm whoami`.
5. Confirm `npm view launch-triage@1.1.0 version` still returns not found.
6. Run `npm test` and `npm publish --dry-run --json` from a clean checkout.
7. Inspect the four-file tarball list and confirm that `scan.mjs` is executable.

## Manual bootstrap

Immediately before the public registry write, ask Mike to confirm this exact
action and version:

```bash
npm publish --access public
```

Complete the npm two-factor prompt personally. Do not store the code or an npm
write token in this repository.

## Verify before creating action tags

1. Confirm `npm view launch-triage@1.1.0 version` returns `1.1.0`.
2. From a fresh temporary directory, run `npx --yes launch-triage@1.1.0 .`.
3. Confirm the command writes a report and the npm package page links back to
   the correct GitHub repository.
4. In npm package settings, configure the trusted GitHub publisher with:
   - Repository owner: `realmikeoladapo`
   - Repository: `launch-triage`
   - Workflow: `publish.yml`
5. Create and push `v1.1.0` and `v1` tags at the verified release commit. Do
   not create a GitHub Release for this already-published bootstrap version,
   because the release workflow correctly rejects duplicate npm versions.
6. Only after the `v1` tag exists, add the GitHub Action usage example to the
   public README.

For the next version, bump `package.json` and the package pin in `action.yml`,
run the same local checks, then publish a GitHub Release. The configured trusted
publisher will authenticate that workflow without a stored write token.
