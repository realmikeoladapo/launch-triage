# Contributing to Launch Triage

Thank you for helping make production-readiness reviews more accurate. Launch
Triage values precision over rule count: a false critical can be more damaging
than a missed medium because it weakens trust in the whole report.

## Development setup

You need Node.js 22 or newer and git.

```bash
git clone https://github.com/realmikeoladapo/launch-triage.git
cd launch-triage
npm test
```

There are no runtime or development dependencies to install. The test suite
uses Node's built-in test runner and temporary git repositories.

## Before opening a pull request

Run:

```bash
node --check scan.mjs
npm test
npm run example
git diff --exit-code -- examples/sample-report.md
```

The final command should be clean after committing an intentional sample-report
update.

## Adding or changing a rule

Every rule must have:

1. A stable ID and defensible severity.
2. A specific source pattern—not a broad keyword claim.
3. Relative file and line evidence with secret-safe redaction.
4. A concrete production consequence written without overstating certainty.
5. A practical recommended action.
6. At least one planted positive fixture.
7. At least one negative control for the most likely false positive.

Update the README rule table and regenerate the sample report when output
changes. Assert the exact rule, severity, and relative path; checking only that
an ID appears is not enough.

## Fixture and report safety

- Never commit a real credential, client repository fragment, private report,
  customer name, or production URL.
- Assemble credential-shaped test strings from fragments at runtime so GitHub
  secret scanning and downstream forks are not polluted by realistic tokens.
- Use synthetic, minimal reproductions in issues and tests.
- Verify that raw secret values appear in neither Markdown nor JSON output.

## Design constraints

- Preserve the zero-runtime-dependency design unless a change has a compelling,
  documented reason.
- Never execute source from the target repository.
- Prefer a narrower claim over a confident false positive.
- Keep output deterministic across filesystems and use relative paths in
  machine-readable output.
- Treat operational uncertainty—unreadable history, failed audits, unsupported
  targets—as uncertainty, not a clean result.

## Pull requests

Keep each pull request focused. Explain the production failure or false-positive
case, include the synthetic reproducer, and state the commands you ran. By
contributing, you agree that your contribution is licensed under the MIT
licence in this repository.
