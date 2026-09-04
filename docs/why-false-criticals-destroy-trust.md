# Why false criticals destroy trust in static analysis

A production-readiness scanner has two ways to fail.

It can miss a real problem. Or it can loudly assert that something is critical
when the available evidence does not support that conclusion.

The first failure is obvious. The second is often treated as harmless: flag
everything, let a human sort it out, and prefer too many warnings to too few.
That approach sounds cautious. In practice, it spends the reviewer's attention
as though attention were free.

It is not.

When a scanner labels a staged credential as a confirmed repository leak, calls
a server-only database module browser-reachable, or reports missing row-level
security without reading later migrations, the reviewer learns a damaging
lesson: severity is not evidence. It is presentation.

After that, every red row becomes negotiable. The real critical finding is now
competing with the memory of the last false one.

Launch Triage is built around a different principle:

> A finding should say only what the inspected evidence can support, and its
> severity should change when the evidence changes.

This note explains what that means in the scanner today, why the test suite
asserts both unsafe and safe cases, and where human verification still begins.

## Severity is a claim, not a colour

A rule match and a severity are different things.

A pattern can establish that a private-key-shaped value exists in the working
tree. It cannot, by itself, establish that the value is present in the current
commit, retained in reachable history, distributed to another clone, active at
the provider, or capable of accessing production data.

Those are progressively stronger claims. A useful scanner should not collapse
them into one word.

Launch Triage therefore separates detection from exposure grading. For
credential rules, it first finds a high-confidence value and then asks what Git
can actually prove about that exact value:

| Evidence | What the scanner can responsibly say |
| --- | --- |
| Exact value exists in the current commit | The repository currently contains it |
| Exact value exists in reachable Git history | An affected clone may retain it after deletion |
| Value exists only in the working tree or index | A local near miss exists; repository distribution was not verified |
| Git is absent, shallow, or unreadable | Exposure is unknown rather than clean or confirmed |

That distinction matters operationally. A value in the current commit calls for
provider rotation or revocation before repository cleanup. A new ignored local
file may call for hygiene and investigation, but the scanner should not claim a
historical disclosure it did not find.

The same rule ID can therefore produce different severities and different
remediation language. That is not inconsistency. It is the scanner responding
to stronger or weaker evidence.

## Exact-value verification is better than path-based suspicion

A tracked filename is not proof that the current secret-shaped value was
committed.

Consider a tracked configuration file that once contained placeholders. A
developer adds a real credential locally and stages the change but has not
committed it. A path-only check sees a tracked file and concludes that the new
value is already in repository history.

That conclusion is false.

Launch Triage checks the matching content, not merely the path. The scanner
compares the complete detected value against the current committed blob and
reachable history. A replacement value staged into an old tracked file remains
a working-tree finding until Git evidence shows that particular value in a
commit.

This also avoids another subtle mistake: matching only the header or shared
prefix of a multiline private key. Two different keys can share familiar
headers and large common fragments. Exposure grading should be based on the
complete detected credential, not a reassuringly unique-looking substring.

The report still recommends caution when Git cannot verify the history. It just
does not turn uncertainty into a fact.

## Filenames are not security boundaries

Static analysis often tries to infer trust from names:

- `admin-client.ts`
- `server.ts`
- `private-db.ts`
- `backend-utils.ts`

Names can communicate intent. They do not control a bundler.

For client-reachability checks, Launch Triage looks for source-level evidence
such as `server-only`, a `"use server"` directive, or a Node built-in import. An
explicit `"use client"` directive overrides a comforting filename.

This is intentionally stricter than naming convention and intentionally less
aggressive than assuming every shared module ships to the browser.

The distinction is especially important for Supabase secret or legacy service
role credentials. Those keys bypass row-level controls and must remain in a
trusted backend. A scanner should flag a client-reachable reference, but it
should not accuse a properly marked server-only module merely because the same
repository also contains frontend code.

The question is not “does this file sound private?” It is “what evidence marks
this module as server-only, and what evidence makes it client-reachable?”

## Database severity requires application context

A SQL migration that creates a table without enabling row-level security is
important evidence. Its severity depends on how the application reaches that
database.

Launch Triage aggregates table creation and row-level-security changes across
migrations before reporting the final state. This prevents an early migration
from being flagged when a later migration correctly enables RLS.

It also distinguishes a browser-reachable Supabase or PostgREST client from an
unrelated client library or a server-only database module. Missing RLS becomes
Critical when untrusted client code can reach the affected data surface. In a
server-only architecture, the same migration remains a review finding without
claiming direct browser exposure.

This does not mean server-only tables are automatically safe. Server routes can
still have broken authorization. It means the scanner should identify the
actual control boundary instead of treating every SQL file as though it were
queried directly by a browser.

A scanner that ignores application context may produce more red findings. It
does not necessarily produce more useful ones.

## A function name is not proof that a control runs

Webhooks expose another common false-confidence problem.

A file may contain:

- a helper named `verifySignature`;
- a comment mentioning a provider verifier;
- an unused HMAC function;
- an idempotency utility imported but never called;
- a correct verifier in another non-handler file.

Those strings are not equivalent to verification before side effects in the
request handler.

Launch Triage scopes webhook checks to recognised handler surfaces and looks for
a verifier call in the relevant execution path. The calibration suite contains
lookalikes that must remain flagged and real verifier calls that must remain
clean. The same principle applies to authentication guards: importing or
defining a guard is weaker evidence than resolving the caller and rejecting an
unauthenticated request inside the mutating handler.

Pattern-based analysis cannot prove every control-flow property. But it can
avoid rewarding decorative security code that never executes.

## Safe controls are first-class tests

A scanner test suite is incomplete when it asks only:

> Did the planted defect trigger?

Every accuracy change should also ask:

> What is the most similar correct implementation, and did it stay quiet?

Launch Triage's calibration suite includes both directions. Unsafe fixtures
must produce the intended rule IDs and severities. Deliberately correct controls
must not appear in the findings.

Current controls cover cases such as:

- RLS enabled in a later migration;
- a guarded route that returns `401` or `403`;
- a webhook helper that is not itself an endpoint;
- a handler with a real signature verifier and idempotency guard;
- a server-only database client;
- a public-by-design route segment;
- test-mode credentials that should not be described as live production keys;
- placeholder values inside environment templates;
- a self-scan of Launch Triage itself.

This changes how new rules should be proposed. A proposal is not complete with
an unsafe snippet. It needs a neighbouring safe snippet that expresses the
boundary the rule must preserve.

False-positive controls are not secondary polish. They are part of the rule's
definition.

## Partial coverage must not look clean

Trust also depends on how a tool reports what it could not inspect.

Launch Triage has a configured collection boundary and a per-file size limit.
If a supported path cannot be read or exceeds that limit, the report marks
coverage as partial, names the skipped path, and exits with an operational error
rather than presenting the scan as clean.

A zero-finding result is meaningful only inside the files and rule families the
scanner actually examined. Unsupported extensions, symbolic links, cloud
configuration, runtime behavior, dashboards, external gateways, and
infrastructure outside the repository remain outside the claim.

The honest statement is:

> No configured pattern matched within the completed static-analysis boundary.

It is not:

> This product is safe to launch.

## Human review starts where pattern evidence ends

Precision does not turn static analysis into proof.

A recognised `401` response can indicate a real authentication guard, or it can
sit on a branch that never protects the mutation. A gateway may provide rate
limiting the repository cannot show. A custom framework may implement access
control through conventions the scanner does not recognise. A webhook verifier
may be present but configured with the wrong secret.

Every finding therefore includes evidence, a production consequence stated with
appropriate conditions, and a recommended verification or remediation action.
The report asks a human to open the file, confirm the effective control, and
reproduce the important failure where possible.

The scanner's job is to compress the search space without pretending to replace
engineering judgment.

## The product decision behind the rule design

Static-analysis tools compete for more than CPU time. They compete for belief.

Teams stop acting on tools that repeatedly exaggerate. They add blanket
suppressions, lower CI thresholds, ignore annotations, or remove the scanner
entirely. A single false finding is recoverable; a pattern of unsupported
critical claims changes the user's default response from investigation to
discounting.

That is why Launch Triage deliberately prefers a calibrated Medium with explicit
uncertainty over a dramatic Critical unsupported by repository evidence. The
goal is not to minimize the number of findings. It is to maximize the number of
findings a reviewer can responsibly act on.

This principle also determines the roadmap. New output formats, suppressions,
baselines, and provider-specific payment rules should be prioritized from real
field-test evidence. Every confirmed false positive should become a safe
control. Every confirmed false negative should be reproduced with an unsafe
fixture and a similar safe fixture.

The project improves when users show where its claim boundary is wrong—not when
it merely accumulates more patterns.

## A practical standard for trustworthy findings

Before a scanner calls something Critical, ask:

1. What exact evidence was observed?
2. Which stronger facts are being inferred rather than verified?
3. Does repository context raise or lower the consequence?
4. What similar correct implementation must remain clean?
5. What part of the system was not inspected?
6. What should a human verify before acting?

A trustworthy finding does not need to sound certain. It needs to make its
certainty legible.

That is the standard Launch Triage is trying to enforce: detect the pattern,
verify the context, state the boundary, and reserve the loudest language for the
cases where the evidence earns it.

---

Run the current release with:

```bash
npx --yes launch-triage@1.2.2 . --json
```

To help calibrate the next rules, read the [field-test guide](field-test.md) and
submit only sanitized feedback. Launch Triage does not need your private source
to learn whether a rule was right.
