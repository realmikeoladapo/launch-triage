# Changelog

All notable changes to Launch Triage are documented here. The project follows
[Semantic Versioning](https://semver.org/).

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

[1.2.0]: https://www.npmjs.com/package/launch-triage/v/1.2.0
[1.1.0]: https://www.npmjs.com/package/launch-triage/v/1.1.0
