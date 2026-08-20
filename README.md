# Launch Triage

Static production-readiness triage for web and mobile codebases. It answers one
question before a launch or a handover: **what is actually going to hurt, and
what is fine?**

Built for the common 2026 situation where a product was prototyped quickly, in
an AI builder or otherwise, and now has to survive real users, real payments,
and real data.

Zero dependencies. Node standard library only. It never executes the code it
reads.

## Run it

From the project you want to check:

```bash
npx --yes launch-triage .
```

The report is written to `output/triage-<project>-<date>.md`. To choose the
location or add project details:

```bash
npx --yes launch-triage /path/to/repo --out launch-triage.md --product "Acme App"
```

When working from a clone of this repository, you can run the source directly:

```bash
node scan.mjs /path/to/repo --product "Acme App" --audit --json
```

| Flag | Effect |
| --- | --- |
| `--out <file>` | Write the report somewhere specific |
| `--client <name>` | Client name in the report header |
| `--product <name>` | Product name in the report header |
| `--audit` | Also run `npm audit` in the target repo. Network, slower |
| `--json` | Emit raw findings as JSON beside the report |
| `--fail-on <level>` | Exit with code 1 for `critical`, `high`, or `medium` findings. Default: `none` |
| `--annotate` | Emit GitHub Actions annotations for each finding |
| `--no-annotate` | Suppress automatic annotations inside GitHub Actions |

Output is a severity-ranked Markdown report where every finding carries a file,
a line, and a redacted excerpt. See [examples/sample-report.md](examples/sample-report.md),
generated from the synthetic fixture in `test/`.

Exit code 0 means the scan completed and did not cross the chosen threshold.
Exit code 1 means findings crossed `--fail-on`. Exit code 2 means the command
itself could not run, for example because the path or threshold was invalid.

## What it checks

| ID | Check |
| --- | --- |
| SEC-1 | Private key present |
| SEC-2 | Live provider credential in source (AWS, Stripe, OpenAI, GitHub) |
| SEC-3 | Environment file carrying a real secret |
| SEC-4 | Secret behind a public build prefix (`NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`) |
| SEC-5 | Supabase service role key in client-reachable code |
| DATA-1 | Tables created without row level security |
| DATA-2 | Policy that evaluates to `USING (true)` |
| AUTH-1 | Mutating API route with no authorisation check |
| PAY-1 | Webhook without signature verification |
| PAY-2 | Webhook without an idempotency guard |
| OPS-1 | Empty catch block swallowing failures |
| OPS-2 | No error monitoring dependency |
| OPS-3 | No rate limiting on public endpoints |
| PERF-1 | Query with no limit or range |
| PERF-2 | Awaited call inside a loop |
| QUAL-1 | TypeScript strict mode off |
| REL-1 | Expo project with no build configuration |
| DEP-1 | High or critical dependency vulnerabilities (`--audit` only) |

## Severity is conditional, on purpose

The same pattern means very different things in different projects. Three rules
grade themselves against context rather than reporting a fixed severity.

**Secrets are graded against git, not the path alone.** For the exact detected
value, the scanner checks the current committed revision, prior history, the
git index, and the working tree before describing its exposure:

| Git state | Severity | Wording |
| --- | --- | --- |
| Present in HEAD | Critical | committed in the current revision |
| Present in prior history | Critical | still recoverable from existing clones |
| Present in the index only | High | staged for the next commit |
| Present in the working tree only | Medium | local near miss, not repository disclosure |
| Not a git repository | High | distribution state cannot be verified |

**Missing row level security depends on who reaches the database.** With a
client-side SDK such as `@supabase/supabase-js` or Firestore, the anon key
reaches Postgres directly, so absent RLS is full exposure and DATA-1 is
Critical. Behind a server-only ORM against a private database it is defence in
depth, and DATA-1 drops to Medium with wording that says so.

**Server-only modules are detected from source, not path.** A file that imports
`server-only`, declares `"use server"`, or imports a Node built-in such as
`fs/promises` cannot reach a browser bundle, so it is excluded from SEC-5.

## Precision is the whole point

A scanner that reports everything is worthless. A false critical costs more
than a missed medium, because it destroys trust in every other line of the
report.

`npm test` asserts both directions against a generated fixture: that planted
defects are found, and that deliberately correct code stays clean. The controls
are the important half.

| Control | Must not be flagged |
| --- | --- |
| Module importing `server-only` | SEC-5 |
| Route calling `requireUserId(req)` | AUTH-1 |
| Route returning 401 for a bad bearer token | AUTH-1 |
| Migration creating a table named `WebhookEvent` | PAY-1 |
| Dummy credentials inside `test/` or `fixtures/` | SEC-2, SEC-4, SEC-5 |

The generated fixture makes those controls reproducible in `npm test`. The same
test suite creates temporary git histories for working-only, staged, committed,
and historical secret states, then checks the severity and wording for each.

## Known limits

- Static analysis only. It does not run the product, click through
  authenticated flows, or test infrastructure.
- AUTH-1 recognises guards by name or by the handler being able to return 401
  or 403. A guard that does neither will still be reported.
- A module that reads a service role key with no server-only marker is still
  flagged, deliberately. Only a human can confirm it is never imported into a
  client component.
- Python and Ruby coverage is thinner than TypeScript coverage.
- No finding does not mean no problem. It means no pattern matched.

The report is a first pass, not a verdict. Open every flagged file and confirm
the finding before you send it to anyone.

## Licence

MIT. Built by [Mike Oladapo](https://mikeoladapo.com).
