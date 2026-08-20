#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './make-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const work = mkdtempSync(join(tmpdir(), 'launch-triage-example-'));

try {
  const app = join(work, 'example-app');
  makeFixture(app);
  execFileSync(process.execPath, [
    join(repo, 'scan.mjs'),
    app,
    '--out', join(repo, 'examples', 'sample-report.md'),
    '--client', 'Example organisation',
    '--product', 'Example App',
    '--prepared-by', 'Example reviewer',
    '--date', '2026-08-20',
  ], { stdio: 'inherit' });
} finally {
  rmSync(work, { recursive: true, force: true });
}
