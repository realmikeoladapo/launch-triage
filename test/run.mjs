#!/usr/bin/env node
/**
 * Calibration test. Asserts both directions:
 *   - planted defects are found
 *   - deliberately correct code is NOT flagged
 *
 * The second half is the one that matters. A scanner that reports everything is
 * worthless, and a false critical in front of a technical reader costs more
 * than a missed medium.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './make-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scan = join(here, '..', 'scan.mjs');
const work = mkdtempSync(join(tmpdir(), 'launch-triage-'));
const app = join(work, 'app');
const out = join(work, 'report.md');

makeFixture(app);
execFileSync('node', [scan, app, '--out', out, '--json'], { stdio: 'ignore' });
const { findings } = JSON.parse(readFileSync(out.replace(/\.md$/, '.json'), 'utf8'));
const ids = new Set(findings.map((f) => f.id));
const files = findings.map((f) => f.file.replace(app + '/', ''));

const MUST_FIND = ['SEC-1', 'SEC-2', 'SEC-3', 'SEC-4', 'SEC-5', 'DATA-1', 'DATA-2', 'AUTH-1', 'PAY-1', 'OPS-1', 'QUAL-1'];
const MUST_NOT_FLAG = [
  'src/lib/db-admin.ts',                        // server-only module
  'src/app/api/clients/route.ts',               // requireUserId guard
  'src/app/api/jobs/run/route.ts',              // returns 401
  'supabase/migrations/0002_webhook_events.sql', // a table, not an endpoint
];

let failed = 0;
for (const id of MUST_FIND) {
  if (!ids.has(id)) { console.error(`MISS   ${id} was not reported`); failed++; }
}
for (const f of MUST_NOT_FLAG) {
  if (files.includes(f)) { console.error(`FALSE  ${f} should not have been flagged`); failed++; }
}

rmSync(work, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log(`ok. ${MUST_FIND.length} rules fired, ${MUST_NOT_FLAG.length} controls stayed clean.`);
