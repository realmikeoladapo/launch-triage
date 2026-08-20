#!/usr/bin/env node
/**
 * Writes a synthetic application containing deliberately planted defects.
 *
 * The fixture is generated at run time rather than committed, so this
 * repository never stores anything that looks like a credential. Secret-shaped
 * strings are assembled from fragments for the same reason.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const KEY_HEADER = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
const KEY_FOOTER = ['-----END', 'PRIVATE', 'KEY-----'].join(' ');
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'.slice(0, 16);

export function makeFixture(root, { git = true } = {}) {
  rmSync(root, { recursive: true, force: true });
  const w = (p, s) => {
    const full = join(root, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, s);
  };

  w('package.json', JSON.stringify({
    name: 'fixture-app',
    dependencies: { next: '15.0.0', expo: '0.0.0-test', '@supabase/supabase-js': '2.45.0' },
  }, null, 2));
  w('.gitignore', '.env\n');
  w('app.json', JSON.stringify({ expo: { name: 'Fixture App', slug: 'fixture-app' } }, null, 2));

  // SEC-1: a private key on disk
  w('service-account.json', JSON.stringify({ private_key: `${KEY_HEADER}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\nAQABMIIEsyntheticFixturePayloadOnly1234567890=\n${KEY_FOOTER}\n` }, null, 2));

  // SEC-2: a provider access key in source
  w('src/lib/uploader.js', `export const config = { accessKeyId: "${AWS_KEY}" };\n`);

  // SEC-3: an env file carrying a real secret
  w('.env', 'NEXT_PUBLIC_SITE_URL=https://example.com\nDB_PASSWORD=p@ssw0rd!\nDATABASE_URL=postgres://alice:hunter2@db/acme\n');

  // SEC-4: a secret behind a public build prefix
  w('src/app/config.ts', 'export const k = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY;\n');

  // SEC-5: service role key in a client-reachable module
  w('src/lib/db-browser.ts', `import { createClient } from "@supabase/supabase-js";
export const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
`);

  // Control: same key, but a server-only module. Must NOT be flagged.
  w('src/lib/db-admin.ts', `import "server-only";
import { createClient } from "@supabase/supabase-js";
export const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
`);

  // SEC-5 regression: a filename containing "admin" is not a server marker.
  w('src/lib/admin-client.ts', `"use client";
import { createClient } from "@supabase/supabase-js";
export const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
`);

  // DATA-1 and DATA-2
  w('supabase/migrations/0001_init.sql', `CREATE TABLE "profile" (id uuid primary key, email text);
CREATE TABLE "invoice" (id uuid primary key, total integer);
CREATE POLICY "open" ON "invoice" FOR SELECT USING (true);
`);

  // AUTH-1: a mutating route with no guard
  w('src/app/api/invoices/route.ts', `export async function POST(req: Request) {
  const body = await req.json();
  return Response.json({ ok: true, body });
}
`);

  // Control: guarded route. Must NOT be flagged.
  w('src/app/api/clients/route.ts', `import { requireUserId } from "@/lib/http";
export async function POST(req: Request) {
  const userId = await requireUserId(req);
  return Response.json({ ok: true, userId });
}
`);

  // Control: route that returns 401. Must NOT be flagged.
  w('src/app/api/jobs/run/route.ts', `export async function POST(req: Request) {
  if (req.headers.get("authorization") !== \`Bearer \${process.env.CRON_SECRET}\`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json({ ok: true });
}
`);

  // PAY-1 and PAY-2: unverified webhook
  w('src/app/api/webhooks/payments/route.ts', `function verifySignature(_value: string) { return true; }
const hmac = () => createHmac("sha256", "unused");
export const POST = async (req: Request) => {
  // TODO: verify signature before launch
  const signature = req.headers.get("stripe-signature");
  const declaredOnly = verifySignature;
  console.log(declaredOnly, hmac); // stripe.webhooks.constructEvent(req)
  console.log("verifySignature() is not implemented");
  const event = await req.json();
  await fulfil(event, signature);
  return Response.json({ received: true });
};
`);

  // Control: a migration naming a webhook table. Must NOT be flagged as an endpoint.
  w('supabase/migrations/0002_webhook_events.sql', 'CREATE TABLE "WebhookEvent" (id uuid primary key);\nALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;\n');

  // Control: RLS may be enabled by a later migration.
  w('supabase/migrations/0003_account.sql', 'CREATE TABLE "account" (id uuid primary key);\n');
  w('supabase/migrations/0004_account_rls.sql', 'ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;\n');

  // AUTH-1 regressions: public-route words must match complete segments, not
  // substrings inside authors, update-status, or leadership.
  for (const route of ['authors/delete', 'orders/update-status', 'leadership/members']) {
    w(`src/app/api/${route}/route.ts`, `export async function DELETE() {
  return Response.json({ ok: true });
}
`);
  }

  // Control: an exact public-by-design route stays exempt.
  w('src/app/api/status/route.ts', `export async function POST() {
  return Response.json({ ok: true });
}
`);

  // Control: a webhook utility is not a request handler.
  w('src/lib/webhook-client.ts', 'export function webhookUrl(base) { return `${base}/webhook`; }\n');

  // Control: a real verifier call before side effects is recognised.
  w('src/app/api/webhooks/verified/route.ts', `import { Webhook } from "svix";
export async function POST(req: Request) {
  const event = new Webhook(process.env.WEBHOOK_SECRET).verify(await req.text(), {});
  await saveIfNew(event.id);
  return Response.json({ received: true });
}
`);

  // PERF-1 and PERF-2
  w('src/lib/list-invoices.ts', 'export const listInvoices = (db) => db.from("invoice").select("*");\n');
  w('src/lib/send-batch.ts', `export async function sendBatch(items) {
  for (const item of items) { await send(item); }
}
`);

  // OPS-1: swallowed failure
  w('src/lib/sync.ts', 'export async function sync() {\n  try { await push(); } catch (e) {}\n}\n');

  // QUAL-1: strict mode off
  w('tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }, null, 2));

  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '--', '.gitignore', 'package.json', 'app.json', 'service-account.json', 'src', 'supabase', 'tsconfig.json'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=Launch Triage Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'Create synthetic fixture'], { cwd: root });
  }

  return root;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = process.argv[2] || join(process.cwd(), '.fixture');
  makeFixture(out);
  console.log(out);
}
