# Launch Triage report

Client: [name]
Product: Example App
Review date: 2026-08-18
Prepared by: Mike Oladapo
Decision requested: [the launch or product decision this report must support]

## One-page decision

Current state: Automated static review of 15 source files found 8 critical, 3 high, and 3 medium findings. [Add the one-paragraph human summary here.]

Recommended next action: Repair first. Do not launch the affected journey until the critical findings are closed.

Why: [the smallest evidence-backed explanation, naming the one finding that drives the decision]

## Critical journey

Start: [where the user begins]

Success: [observable end state]

Failure observed: [what happened, with a screenshot, log, test, or code excerpt]

Acceptance test: [the exact result that proves the blocker is resolved]

## Findings

| Severity | Finding and evidence | Production consequence | Recommended action |
| --- | --- | --- | --- |
| Critical | **Private key committed to the repository**<br>`service-account.json:2`<br>`"private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADA<redacted>\n"` | This file is tracked by git and committed to the repository. Anyone who can read the repository, including any past collaborator or a leaked clone, holds this value permanently, and deleting the file does not remove it. Rotation is the only remedy. | Rotate the credential at the provider first, then remove the file from the tree and purge it from git history. |
| Critical | **Live provider credential found in source**<br>`src/lib/uploader.js:1`<br>`export const config = { accessKeyId: "AKIAIOSFODNN<redacted>" };` | This file is tracked by git and committed to the repository. Anyone who can read the repository, including any past collaborator or a leaked clone, holds this value permanently, and deleting the file does not remove it. Rotation is the only remedy. | Rotate the credential at the provider first, then remove the file from the tree and purge it from git history. |
| Critical | **Secret exposed through a public environment prefix**<br>`src/app/config.ts:1`<br>`export const k = process.env.NEXT_PUBLIC_<redacted>;` | Variables with a public prefix are compiled into the browser bundle. This value is readable by every visitor with developer tools open. | Move the value to a server-only variable and access it from a server route or action. |
| Critical | **Supabase service role key referenced in client-reachable code**<br>`src/lib/db-browser.ts:2`<br>`export const c = createClient(process.env.NEXT_PUBLIC_<redacted>, process.env.SUPABASE_SER<redacted>);` | The service role key bypasses row level security entirely. In a client bundle it grants any visitor full read and write access to every table. | Restrict the service role key to server routes, and use the anon key with row level security from the client. |
| Critical | **Tables created without row level security: profile, invoice**<br>`supabase/migrations/0001_init.sql:1`<br>`CREATE TABLE "profile" (id uuid primary key, email text);` | With row level security disabled, the anon key can read and write every row in these tables. This is the most common cause of full data exposure in Supabase products. | Enable row level security on each table and add explicit policies for select, insert, update, and delete. |
| Critical | **Row level security policy evaluates to true for everyone**<br>`supabase/migrations/0001_init.sql:3`<br>`CREATE POLICY "open" ON "invoice" FOR SELECT USING (true);` | A policy of USING (true) satisfies row level security while granting universal access. The protection appears enabled and is not. | Scope the policy to the authenticated owner, for example USING (auth.uid() = user_id). |
| Critical | **Mutating API route with no visible authorisation check**<br>`src/app/api/invoices/route.ts:1`<br>`export async function POST(req: Request) {` | Any unauthenticated caller can invoke this endpoint directly and change data. The user interface hiding the button is not a control. | Resolve the session at the top of the handler, reject when absent, and verify the caller owns the record being changed. |
| Critical | **Webhook endpoint without signature verification**<br>`src/app/api/webhooks/payments/route.ts:1`<br>`export async function POST(req: Request) {` | Anyone who learns the URL can post a forged event. For payment webhooks that means granting paid access or crediting an account without a real payment. | Verify the provider signature against the raw request body before any handling, and reject on failure. |
| High | **Webhook handler has no idempotency guard**<br>`src/app/api/webhooks/payments/route.ts:1`<br>`export async function POST(req: Request) {` | Providers retry on timeout or non-2xx responses. Without a guard a retry double-credits the account, duplicates the order, or sends the email twice. | Persist the provider event id and return early when it has already been handled. |
| High | **Empty catch block swallows the failure**<br>`src/lib/sync.ts:2`<br>`try { await push(); } catch (e) {}` | The operation fails and nothing records it. The user sees a success state, and the failure is invisible until a customer reports it. | Log the error with context, surface an honest failure state, and report it to monitoring. |
| High | **No error monitoring dependency present**<br>`package.json:1`<br>`dependencies: no monitoring package found` | Production failures are only discovered when a user reports them. There is no way to tell whether a release made things worse. | Add an error reporting service and verify that a deliberate test error reaches the dashboard before launch. |
| Medium | **Environment file with real values is committed**<br>`.env:2`<br>`STRIPE_SECRET_KEY=sk_test_51AB<redacted>` | This file is present in the working tree but untracked and absent from git history, so it has not been distributed. The immediate exposure is limited to this machine, so this is a hygiene and near-miss finding rather than a disclosure. It becomes critical the moment the ignore rule is changed or the file is force-added. | Confirm the ignore rule covers it permanently, and rotate the value if the machine or any backup of it has been shared. |
| Medium | **No rate limiting on public endpoints**<br>`package.json:1`<br>`dependencies: no rate limiting package found` | Public endpoints, especially those calling a paid model API, can be called in a loop by anyone. The first symptom is usually the bill. | Apply a per-identifier rate limit to authentication, contact, and any model-backed route. |
| Medium | **TypeScript strict mode is not enabled**<br>`tsconfig.json:1`<br>`compilerOptions.strict is not true` | Null and undefined errors reach runtime instead of the compiler. These are the most common crash class in generated code. | Enable strict mode and resolve the resulting errors before launch. |

Do not fill rows to make the report look larger. Include only verified findings.
Remove any row below that you have not confirmed by reading the code yourself.

## What can wait

- [useful improvement that is not blocking the decision]

## Recommended scope

Offer: [Critical Flow Rescue or Controlled Launch Sprint]

Price: [fixed price]

Timeline: [business days after access is ready]

Included: [one journey, integration, deployment target, tests, handover]

Excluded: [specific exclusions]

Dependencies: [access, buyer decisions, accounts, sample data]

## Evidence boundary

This report records what was inspected and reproduced. It is not a penetration
test, legal certification, third-party approval, or guarantee about surfaces
outside the agreed review.

Automated static analysis covered 15 files. It does not execute the
product, test authenticated flows by hand, or inspect infrastructure,
third-party dashboards, or anything outside this repository.
