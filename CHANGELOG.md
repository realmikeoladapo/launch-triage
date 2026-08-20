# Changelog

All notable changes to Launch Triage are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-08-20

### Added

- Zero-dependency Node.js CLI with 18 production-readiness checks across
  secrets, data access, authentication, payments, operations, performance,
  TypeScript quality, Expo release setup, and dependency vulnerabilities.
- Context-aware severity based on verified git content, production
  client-reachable database use, and explicit server/client source markers.
- Severity-ranked Markdown reports and schema-versioned JSON with relative
  paths, audit status, counts, redacted evidence, and remediation guidance.
- CI-friendly `--fail-on`, reproducible `--date`, neutral `--prepared-by`, and
  conventional `--help` and `--version` commands.
- Transparent npm audit outcomes: completed, not applicable, or failed.
- Generated calibration fixture with exact positive assertions and
  false-positive controls, including split RLS migrations and webhook helpers.
- Cross-platform CI, package smoke tests, contributor guidance, issue forms,
  pull-request checklist, and private security-reporting instructions.

### Safety and accuracy

- Markdown and JSON outputs can no longer overwrite one another.
- File and empty-directory targets can no longer produce misleading clean
  reports.
- Credential excerpts redact punctuation-heavy passwords, URL credentials,
  provider tokens, and private-key material.
- Staged or locally edited secrets are no longer described as committed without
  matching content in a reachable commit.
- Partial scans caused by oversized or unreadable supported paths are explicit
  in Markdown and JSON and exit unsuccessfully.
- Arrow route handlers, unused guard imports, misleading verifier declarations,
  and log-only webhook event IDs are covered by regression tests.
- App-only monitoring and rate-limit rules no longer flag libraries or CLIs.
- Table creation and RLS enablement are evaluated across migrations.

[1.0.0]: https://github.com/realmikeoladapo/launch-triage/releases/tag/v1.0.0
