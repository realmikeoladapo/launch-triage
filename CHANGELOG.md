# Changelog

All notable changes to Launch Triage are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [1.2.2] - 2026-08-22

### Fixed

- High-confidence provider credentials are detected even when they appear in
  `.env.example`, `.env.sample`, or other environment-template files.
- The README now documents partial file coverage with the same operational exit
  code (`2`) used by the CLI.
- The npm release workflow publishes only from a release tag that exactly
  matches the version in `package.json`.

## [1.2.1] - 2026-08-21

### Fixed

- Package validation accepts the JSON formats returned by npm 11 and npm 12.
- Release publishing uses an audited npm version and tests that exact toolchain
  in CI.
- The GitHub `v1.2.0` release stopped before npm publication. No
  `launch-triage@1.2.0` package was published.

## [1.2.0] - 2026-08-21

### Added

- Versioned JSON output with relative paths, coverage details, audit status,
  counts, and redacted findings.
- Reproducible report dates and optional reviewer metadata.
- Conventional `--help` and `--version` commands.
- Cross-platform CI, deterministic sample generation, package smoke tests,
  contributor guidance, issue forms, and private security reporting.

### Improved

- Credential findings verify the exact detected value against the current
  commit and reachable history.
- Database reachability, server-only modules, authentication guards, webhook
  verification, and idempotency checks have tighter false-positive controls.
- Partial scans and failed requested audits now exit as operational failures.
- Git history inspection works for nested scan roots on macOS, Linux, and
  Windows path conventions.

## [1.1.0] - 2026-08-20

### Added

- First public npm release of the zero-dependency Node.js CLI.
- Severity-ranked Markdown reports with file, line, redacted evidence, impact,
  and recommended action.
- Conditional severity for secrets, database access, and server-only code.
- Optional npm audit, JSON output, CI thresholds, and GitHub annotations.
- Composite GitHub Action and OIDC-ready release workflow.

[1.2.2]: https://www.npmjs.com/package/launch-triage/v/1.2.2
[1.2.1]: https://www.npmjs.com/package/launch-triage/v/1.2.1
[1.2.0]: https://github.com/realmikeoladapo/launch-triage/releases/tag/v1.2.0
[1.1.0]: https://www.npmjs.com/package/launch-triage/v/1.1.0
