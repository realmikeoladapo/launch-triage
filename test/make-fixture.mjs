#!/usr/bin/env node
/**
 * Writes a synthetic application containing deliberately planted defects.
 *
 * The fixture is generated at run time rather than committed, so this
 * repository never stores anything that looks like a credential. Secret-shaped
 * strings are assembled from fragments for the same reason.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const KEY_HEADER = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'.slice(0, 16);

export function makeFixture(root) {
  rmSync(root, { recursive: true, force: true });
  const w = (p, s) => {
    const full = join(root, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, s);
  };

  w('package.json', JSON.stringify({
    name: 'fixture-app',
    dependencies: { next: '15.0.0', '@supabase/supabase-js': '2.45.0' },
  }, null, 2));

  // SEC-1: a private key on disk
  w('service-account.json', JSON.stringify({ private_key: `${KEY_HEADER}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ\n` }, null, 2));

  // SEC-2: a provider access key in source
  w('src/lib/uploader.js', `export const config = { accessKeyId: "${AWS_KEY}" };\n`);

  // SEC-3: an env file carrying a real secret
  w('.env', 'NEXT_PUBLIC_SITE_URL=https://example.com\nSTRIPE_SECRET_KEY=sk_test_51ABCdefGHIjklMNOpqrSTUvwx\n');

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
  w('src/app/api/webhooks/payments/route.ts', `export async function POST(req: Request) {
  const event = await req.json();
  await fulfil(event);
  return Response.json({ received: true });
}
`);

  // Control: a migration naming a webhook table. Must NOT be flagged as an endpoint.
  w('supabase/migrations/0002_webhook_events.sql', 'CREATE TABLE "WebhookEvent" (id uuid primary key);\nALTER TABLE "WebhookEvent" ENABLE ROW LEVEL SECURITY;\n');

  // OPS-1: swallowed failure
  w('src/lib/sync.ts', 'export async function sync() {\n  try { await push(); } catch (e) {}\n}\n');

  // QUAL-1: strict mode off
  w('tsconfig.json', JSON.stringify({ compilerOptions: { strict: false } }, null, 2));

  return root;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] || join(process.cwd(), '.fixture');
  makeFixture(out);
  console.log(out);
}
