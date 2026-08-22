#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const scan = join(here, '..', 'scan.mjs');

function write(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

test('high-confidence provider credentials are still detected in env example files', (t) => {
  const work = mkdtempSync(join(tmpdir(), 'launch-triage-env-example-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));

  const app = join(work, 'app');
  const out = join(work, 'report.md');
  const key = `AKIA${'ENVEXAMPLEKEY1234'.slice(0, 16)}`;

  write(app, 'package.json', '{"name":"env-example-regression"}\n');
  write(app, '.env.example', `AWS_ACCESS_KEY_ID=${key}\nSAFE_PLACEHOLDER=your_value_here\n`);

  const result = spawnSync(process.execPath, [
    scan,
    app,
    '--out', out,
    '--json',
    '--date', '2026-08-22',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(readFileSync(out.replace(/\.md$/i, '.json'), 'utf8'));
  const finding = json.findings.find(({ id, file }) => id === 'SEC-2' && file === '.env.example');

  assert.ok(finding, 'provider credential in .env.example must be reported by SEC-2');
  assert.equal(finding.severity, 'Medium');

  const combined = `${readFileSync(out, 'utf8')}\n${JSON.stringify(json)}`;
  assert.equal(combined.includes(key), false, 'reports must redact the detected credential');
});
