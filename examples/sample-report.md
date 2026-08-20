# Launch Triage report

Client: Example organisation
Product: Example App
Review date: 2026-08-20
Prepared by: Example reviewer
Generated with: Launch Triage v1.2.0
Dependency audit: Not requested
Coverage: Complete: 27 supported files read

## Automated triage

Automated static review of 27 supported source files found 12 critical, 4 high, and 5 medium findings.

Recommended next action: Repair and verify the critical findings before the affected journey is launched.

Human confirmation is required before sharing this report or making a launch decision.

## Findings

| Severity | Finding and evidence | Production consequence | Recommended action |
| --- | --- | --- | --- |
| Critical | **Mutating API route has no recognised authentication guard**<br>`src/app/api/authors/delete/route.ts:1`<br>`export async function DELETE() {` | No recognised authentication guard was found. If the route is reachable without another platform-level control, an unauthenticated caller may be able to change data directly. | Confirm the effective access control, then resolve the session at the top of the handler, reject when absent, and verify the caller owns the affected record. |
| Critical | **Mutating API route has no recognised authentication guard**<br>`src/app/api/invoices/route.ts:1`<br>`export async function POST(req: Request) {` | No recognised authentication guard was found. If the route is reachable without another platform-level control, an unauthenticated caller may be able to change data directly. | Confirm the effective access control, then resolve the session at the top of the handler, reject when absent, and verify the caller owns the affected record. |
| Critical | **Mutating API route has no recognised authentication guard**<br>`src/app/api/leadership/members/route.ts:1`<br>`export async function DELETE() {` | No recognised authentication guard was found. If the route is reachable without another platform-level control, an unauthenticated caller may be able to change data directly. | Confirm the effective access control, then resolve the session at the top of the handler, reject when absent, and verify the caller owns the affected record. |
| Critical | **Mutating API route has no recognised authentication guard**<br>`src/app/api/orders/update-status/route.ts:1`<br>`export async function DELETE() {` | No recognised authentication guard was found. If the route is reachable without another platform-level control, an unauthenticated caller may be able to change data directly. | Confirm the effective access control, then resolve the session at the top of the handler, reject when absent, and verify the caller owns the affected record. |
| Critical | **Tables created without row level security: profile, invoice**<br>`supabase/migrations/0001_init.sql:1`<br>`CREATE TABLE "profile" (id uuid primary key, email text);` | Client-reachable database code was detected. With row level security disabled, an untrusted client may be able to read or write rows outside its account. | Enable row level security on each table and add explicit policies for select, insert, update, and delete. |
| Critical | **Row level security policy evaluates to true for everyone**<br>`supabase/migrations/0001_init.sql:3`<br>`CREATE POLICY "open" ON "invoice" FOR SELECT USING (true);` | A policy of USING (true) satisfies row level security while granting universal access. The protection appears enabled and is not. | Scope the policy to the authenticated owner, for example USING (auth.uid() = user_id). |
| Critical | **Webhook endpoint has no recognised signature verification**<br>`src/app/api/webhooks/payments/route.ts:3`<br>`export const POST = async (req: Request) => {` | No recognised verifier call was found before side effects. If no external gateway verifies the request, anyone who learns the URL may be able to post a forged event. | Verify the provider signature against the raw request body before any handling, reject on failure, and keep the verifier call visible in this handler. |
| Critical | **Private key present in the repository workspace**<br>`service-account.json:2`<br>`"private_key": "<redacted>"` | A value matching this rule is present in the current git commit. Anyone with the affected commit or clone may retain it after deletion. Treat it as exposed until the provider confirms rotation or revocation. | Rotate or revoke the credential at the provider first, then remove it from the tree and purge the affected history where appropriate. |
| Critical | **Provider credential found in source**<br>`src/lib/uploader.js:1`<br>`export const config = { accessKeyId: "AKIA<redacted>" };` | A value matching this rule is present in the current git commit. Anyone with the affected commit or clone may retain it after deletion. Treat it as exposed until the provider confirms rotation or revocation. | Rotate or revoke the credential at the provider first, then remove it from the tree and purge the affected history where appropriate. |
| Critical | **Secret exposed through a public environment prefix**<br>`src/app/config.ts:1`<br>`export const k = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;` | Variables with a public prefix are compiled into the browser bundle. This value is readable by every visitor with developer tools open. | Move the value to a server-only variable and access it from a server route or action. |
| Critical | **Supabase service role key referenced in client-reachable code**<br>`src/lib/admin-client.ts:3`<br>`export const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);` | The service role key bypasses row level security entirely. In a client bundle it grants any visitor full read and write access to every table. | Restrict the service role key to server routes, and use the anon key with row level security from the client. |
| Critical | **Supabase service role key referenced in client-reachable code**<br>`src/lib/db-browser.ts:2`<br>`export const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);` | The service role key bypasses row level security entirely. In a client bundle it grants any visitor full read and write access to every table. | Restrict the service role key to server routes, and use the anon key with row level security from the client. |
| High | **Empty catch block swallows the failure**<br>`src/lib/sync.ts:2`<br>`try { await push(); } catch (e) {}` | The operation fails and nothing records it. The user sees a success state, and the failure is invisible until a customer reports it. | Log the error with context, surface an honest failure state, and report it to monitoring. |
| High | **No recognised error-monitoring package detected**<br>`package.json:1`<br>`dependencies: no monitoring package found` | No common monitoring integration was found in this deployable application. Confirm whether the platform supplies equivalent coverage; otherwise production failures may only surface through user reports. | Confirm platform-level monitoring or add an error reporting service, then verify that a deliberate test error reaches the dashboard before launch. |
| High | **Webhook handler has no recognised idempotency guard**<br>`src/app/api/webhooks/payments/route.ts:3`<br>`export const POST = async (req: Request) => {` | Providers retry on timeout or non-2xx responses. Without a guard a retry double-credits the account, duplicates the order, or sends the email twice. | Persist the provider event id and return early when it has already been handled. |
| High | **Expo project without a build configuration**<br>`app.json:1`<br>`eas.json not present` | There is no reproducible path to a signed build. Release becomes a manual sequence that works once and cannot be repeated under deadline. | Add eas.json with development, preview, and production profiles, and produce one signed build before committing to a launch date. |
| Medium | **No recognised rate-limiting package detected for request handlers**<br>`package.json:1`<br>`dependencies: no rate limiting package found` | No common rate-limiting integration was found. Confirm whether an API gateway or platform supplies equivalent protection, especially for authentication and paid model routes. | Confirm the external control or apply a per-identifier rate limit to authentication, contact, and model-backed routes. |
| Medium | **Query selects without a limit or range**<br>`src/lib/list-invoices.ts:1`<br>`export const listInvoices = (db) => db.from("invoice").select("*");` | The query returns the whole table. It is fast on seed data and degrades in production as rows accumulate, until the page times out. | Add an explicit limit or range and paginate the interface. |
| Medium | **Awaited call inside a loop**<br>`src/lib/send-batch.ts:2`<br>`for (const item of items) { await send(item); }` | Each iteration waits for the previous one. Latency grows linearly with the collection and the request eventually exceeds the platform timeout. | Batch the work into a single query, or run the calls concurrently with Promise.all where ordering does not matter. |
| Medium | **TypeScript strict mode is not enabled**<br>`tsconfig.json:1`<br>`compilerOptions.strict is not true` | Null and undefined errors reach runtime instead of the compiler. These are the most common crash class in generated code. | Enable strict mode and resolve the resulting errors before launch. |
| Medium | **Environment file contains a secret-like value**<br>`.env:2`<br>`DB_PASSWORD=<redacted>` | A value matching this rule is present in the working tree or index, with no matching value detected in the current commit or reachable history. The scanner did not verify distribution through reachable git history, so this is a local hygiene and near-miss finding rather than a confirmed repository disclosure. | Keep the file ignored, remove the value from the working tree or index, and rotate it if the machine or any backup has been shared. |

## Human verification checklist

- [ ] Open every flagged file and confirm the matched pattern is a real defect.
- [ ] Reproduce the highest-severity failure in the affected user journey.
- [ ] Record the owner, target date, and acceptance test for each confirmed finding.
- [ ] Remove false positives before sharing the report with a client or team.

## Evidence boundary

### File coverage

Every discovered file within the supported collection boundary was read.

### Analysis boundary

This report records static patterns found in the inspected files. It is not a
penetration test, legal certification, third-party approval, or guarantee about
surfaces outside the repository.

Automated static analysis covered 27 files. It does not execute the
product, test authenticated flows by hand, or inspect infrastructure,
third-party dashboards, or anything outside this repository.
