# Release process

`launch-triage@1.1.0` was published manually on 20 August 2026 and verified
from the public npm registry. Future releases should use npm trusted publishing
after the GitHub publisher is configured.

## Prepare a release

1. Work from a clean branch based on `main`.
2. Bump `package.json` and update the changelog.
3. Run `npm test`, regenerate the sample, and confirm no diff remains.
4. Run `npm publish --dry-run --json` and inspect the package contents.
5. Push the branch and wait for every CI job to pass.
6. Merge only the exact green commit.

## Publish

Configure npm trusted publishing for:

- Repository owner: `realmikeoladapo`
- Repository: `launch-triage`
- Workflow: `publish.yml`

Create the GitHub release only after the version is merged and confirmed
unpublished. The release workflow tests the source, rejects duplicate versions,
and publishes through the short-lived GitHub identity.

## Verify

1. Confirm `npm view launch-triage@<version> version` returns the new version.
2. Run `npx --yes launch-triage@<version> /path/to/a/test/repository`.
3. Confirm the report is created and the npm package links to this repository.
4. Move the major `v1` Git tag only after the package and Action are verified.
