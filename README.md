# Launch Triage

[![CI](https://github.com/realmikeoladapo/launch-triage/actions/workflows/ci.yml/badge.svg)](https://github.com/realmikeoladapo/launch-triage/actions/workflows/ci.yml)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Static production-readiness triage for web and mobile codebases. It answers one
question before a launch or handover: **what is actually going to hurt, and
what is fine?**

Launch Triage is built for products that moved quickly—through an AI builder,
a prototype sprint, or otherwise—and now have to survive real users, payments,
and data. It has zero runtime dependencies and never executes the source it
inspects.

## Quick start

Requires Node.js 22 or newer. Git is strongly recommended: without readable
local history, credential findings remain unverified and are graded as local
near misses rather than confirmed repository exposure.

Run from source:

```bash
git clone https://github.com/realmikeoladapo/launch-triage.git
cd launch-triage
node scan.mjs /path/to/repo --product "Acme App" --json
```

Published package (available from `v1.0.0`):

```bash
npx launch-triage@1 /path/to/repo --product "Acme App" --json

# Or install it globally
npm install --global launch-triage
launch-triage /path/to/repo --product "Acme App" --json
```

The default Markdown report is written to
`output/triage-<repository>-<local-date>.md`. See the
[sample report](examples/sample-report.md).

### Options

| Flag | Effect |
| --- | --- |
| `--out <file>` | Write the Markdown report to a specific path |
| `--client <name>` | Add a client name to the report header |
| `--product <name>` | Override the product name inferred from the directory |
| `--prepared-by <name>` | Add a reviewer or organisation to the report header |
| `--date <YYYY-MM-DD>` | Override the local review date for reproducible reports |
| `--audit` | Run `npm audit` when an npm lockfile is present |
| `--json` | Write versioned, machine-readable JSON beside the report |
| `--fail-on <severity>` | Exit `2` when a finding at or above `critical`, `high`, or `medium` is present |
| `-h`, `--help` | Show CLI help |
| `-v`, `--version` | Show the installed version |

Exit code `0` means the scan completed; it does **not** mean the product is safe
to launch. Exit code `1` means invalid input or an operational failure,
including incomplete file coverage or a requested dependency audit that could
not complete. Exit code `2` means the scan completed and the configured
`--fail-on` threshold was met.

## What it checks

| ID | Check |
| --- | --- |
| SEC-1 | Private key present |
| SEC-2 | Provider credential in source (AWS, Stripe, OpenAI, GitHub) |
| SEC-3 | Environment file carrying a secret-like value |
| SEC-4 | Secret behind a public build prefix (`NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`) |
| SEC-5 | Supabase service role key in client-reachable code |
| DATA-1 | Tables created without row level security |
| DATA-2 | Policy that evaluates to `USING (true)` |
| AUTH-1 | Mutating API route with no recognised authentication guard |
| PAY-1 | Webhook with no recognised signature verification |
| PAY-2 | Webhook with no recognised idempotency guard |
| OPS-1 | Empty catch block swallowing failures |
| OPS-2 | Deployable app with no recognised error-monitoring package |
| OPS-3 | Request handlers with no recognised rate-limiting package |
| PERF-1 | Query with no limit or range |
| PERF-2 | Awaited call inside a loop |
| QUAL-1 | TypeScript strict mode off or absent without an inherited config |
| REL-1 | Expo project with no EAS build configuration |
| DEP-1 | High or critical dependency vulnerabilities (`--audit` only) |

Every finding includes a relative file path, line number, redacted excerpt,
production consequence, and recommended action. Rules are capped so a noisy
pattern cannot inflate the report.

## Severity is conditional, on purpose

The same pattern can mean very different things in different projects. Launch
Triage grades several rules against repository context rather than assigning a
fixed severity.

### Git exposure is verified against content

The scanner reads the working tree, but it only calls a secret finding
“committed” after a matching value is found in the current commit or reachable
git history. A staged file or a new local edit to an old path is not treated as
proof of distribution.

| Verified state | Severity | Interpretation |
| --- | --- | --- |
| Matching value in the current commit | Critical¹ | Present in the repository now |
| Matching value in reachable history | Critical¹ | Recoverable from an affected clone |
| Working tree or index only | Medium | Local near miss; distribution not verified |
| Not a git repository or history unreadable | Medium | Exposure is unknown, not asserted |

¹ Recognised Stripe test-mode credentials are capped at High: they still grant
account access, but are not described as production payment credentials.

History checks are limited to commits reachable in the local clone. A shallow
clone cannot prove what exists outside its available history.

### Missing RLS depends on real client reachability

Table creation and `ENABLE ROW LEVEL SECURITY` statements are aggregated across
migrations. Missing RLS is Critical only when production client-reachable source
actually imports a Supabase/PostgREST client. An unrelated Firestore or
PocketBase client does not elevate SQL tables, and merely listing a package or
importing it from a `server-only` module does not elevate the finding.

### Server-only modules are detected from source

A module importing `server-only`, declaring `"use server"`, or importing a Node
built-in such as `fs/promises` is excluded from client-reachability checks. An
explicit `"use client"` directive wins over a reassuring filename: a file named
`admin-client.ts` is still client code.

## Precision is the point

A scanner that reports everything is not useful. A false critical destroys
trust in every other row, so the calibration suite asserts both directions:
planted defects must be found, and deliberately correct controls must stay
clean.

Current controls include:

- server-only database modules;
- guarded routes and routes that return `401`;
- exact public-by-design route segments;
- webhook utilities that are not request handlers;
- webhook handlers with a real verifier call;
- RLS enabled in a later migration;
- SQL migrations that merely contain the word “webhook”;
- credentials assembled only inside tests and fixtures;
- a self-scan of Launch Triage itself.

The suite also locks down CLI errors, git state, redaction, JSON/Markdown output
separation, deterministic ordering, and all 17 non-network rules. `DEP-1` is
tested from representative npm audit metadata without relying on the network.

Run it with:

```bash
npm test
```

## JSON contract

`--json` writes a separate JSON file even when the Markdown output uses a
non-`.md` extension. Version 1 includes:

- `schemaVersion` and tool version;
- review metadata and audit status;
- severity counts, scanned file count, and complete/partial coverage details;
- findings with paths relative to the scanned repository.

Absolute workstation paths are intentionally omitted. Consumers should reject
schema versions they do not understand.

## Dependency audit behaviour

`--audit` is opt-in because it uses the network and is slower. It requires
`package-lock.json` or `npm-shrinkwrap.json`. The Markdown and JSON outputs say
whether the audit was completed, not applicable, or failed; a failed requested
audit is never presented as a clean result.

## Known limits

- Static analysis only. It does not run the product, click through authenticated
  flows, inspect cloud configuration, or test infrastructure.
- Pattern recognition is evidence for review, not proof that a vulnerability is
  exploitable.
- AUTH-1 recognises common guard calls and `401`/`403` responses. Custom access
  controls may need human confirmation.
- A service-role reference without a real server-only marker is flagged
  deliberately; a filename alone is not a security boundary.
- Git history checks see only commits available in the local clone.
- Collection covers `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.astro`,
  `.vue`, `.svelte`, `.sql`, `.py`, `.rb`, `.go`, `.php`, `.swift`, `.kt`,
  `.java`, `.env*`, `.json`, `.yml`, `.yaml`, `.toml`, `.pem`, `.key`, `.p8`,
  `.npmrc`, and common SSH private-key filenames. Symbolic links and unsupported
  extensions are outside this configured boundary.
- Dependency, build-output, cache, vendor, generated, editor, and test-worktree
  directories and generated dependency lockfiles are intentionally excluded.
  Supported files over 600 KiB or paths that cannot be read make coverage
  Partial, are named in Markdown and JSON, and force exit code `1` instead of a
  clean result.
- Python, Ruby, Go, and PHP request-handler coverage is thinner than JavaScript
  and TypeScript coverage.
- No finding means no configured pattern matched—not that no problem exists.

Open every flagged file and confirm the finding before acting on or sharing a
report. Never paste a real credential, private client source, or unsanitised
report into a public issue.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a rule. Accuracy changes
must include both a positive fixture and a false-positive control. Report tool
vulnerabilities privately as described in [SECURITY.md](SECURITY.md); scanner
accuracy reports should use synthetic examples.

## Licence

MIT. Built by [Mike Oladapo](https://mikeoladapo.com).
