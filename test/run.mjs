#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './make-fixture.mjs';
import { dependencyAuditFailureDetail, dependencyAuditFinding, jsonOutputPath, redact } from '../scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const scan = join(repo, 'scan.mjs');

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'launch-triage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(args, cwd = repo) {
  return spawnSync(process.execPath, [scan, ...args], { cwd, encoding: 'utf8' });
}

function runNpm(args, options) {
  if (process.env.npm_execpath) {
    return execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);
  }
  if (process.platform === 'win32') {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options);
  }
  return execFileSync('npm', args, options);
}

function packedPackageMetadata(raw) {
  const result = JSON.parse(raw);
  const entries = Array.isArray(result) ? result : Object.values(result);
  assert.equal(entries.length, 1, 'expected exactly one packed package');
  const [packed] = entries;
  assert.ok(packed && Array.isArray(packed.files), 'npm pack returned invalid package metadata');
  return packed;
}

function write(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initGit(root, paths) {
  git(root, ['init', '-q']);
  git(root, ['add', '--', ...paths]);
  git(root, ['-c', 'user.name=Launch Triage Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'Initial fixture']);
}

function scanToJson(root, out, extra = []) {
  const result = run([root, '--out', out, '--json', '--date', '2026-08-20', ...extra]);
  const jsonPath = jsonOutputPath(out);
  const payload = [0, 1, 2].includes(result.status)
    ? JSON.parse(readFileSync(jsonPath, 'utf8'))
    : null;
  return { result, payload, jsonPath };
}

test('calibration fixture covers every non-network rule and keeps controls clean', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  const out = join(work, 'report.md');
  makeFixture(app);

  const { result, payload } = scanToJson(app, out);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(payload.counts, { critical: 12, high: 4, medium: 5 });

  const actual = payload.findings.map(({ severity, id, file }) => `${severity}\t${id}\t${file}`);
  assert.deepEqual(actual, [
    'Critical\tAUTH-1\tsrc/app/api/authors/delete/route.ts',
    'Critical\tAUTH-1\tsrc/app/api/invoices/route.ts',
    'Critical\tAUTH-1\tsrc/app/api/leadership/members/route.ts',
    'Critical\tAUTH-1\tsrc/app/api/orders/update-status/route.ts',
    'Critical\tDATA-1\tsupabase/migrations/0001_init.sql',
    'Critical\tDATA-2\tsupabase/migrations/0001_init.sql',
    'Critical\tPAY-1\tsrc/app/api/webhooks/payments/route.ts',
    'Critical\tSEC-1\tservice-account.json',
    'Critical\tSEC-2\tsrc/lib/uploader.js',
    'Critical\tSEC-4\tsrc/app/config.ts',
    'Critical\tSEC-5\tsrc/lib/admin-client.ts',
    'Critical\tSEC-5\tsrc/lib/db-browser.ts',
    'High\tOPS-1\tsrc/lib/sync.ts',
    'High\tOPS-2\tpackage.json',
    'High\tPAY-2\tsrc/app/api/webhooks/payments/route.ts',
    'High\tREL-1\tapp.json',
    'Medium\tOPS-3\tpackage.json',
    'Medium\tPERF-1\tsrc/lib/list-invoices.ts',
    'Medium\tPERF-2\tsrc/lib/send-batch.ts',
    'Medium\tQUAL-1\ttsconfig.json',
    'Medium\tSEC-3\t.env',
  ]);

  const dataFinding = payload.findings.find(({ id }) => id === 'DATA-1');
  assert.doesNotMatch(dataFinding.title, /account|WebhookEvent/i, 'later RLS migration and protected table must stay clean');
  const flaggedFiles = new Set(payload.findings.map(({ file }) => file));
  for (const clean of [
    'src/lib/db-admin.ts',
    'src/app/api/clients/route.ts',
    'src/app/api/jobs/run/route.ts',
    'src/app/api/status/route.ts',
    'src/app/api/webhooks/verified/route.ts',
    'src/lib/webhook-client.ts',
    'supabase/migrations/0002_webhook_events.sql',
    'supabase/migrations/0003_account.sql',
  ]) {
    assert.equal(flaggedFiles.has(clean), false, `${clean} should stay clean`);
  }
});

test('reports and JSON never expose detected credential values', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  const out = join(work, 'report.md');
  makeFixture(app);
  const { result, jsonPath } = scanToJson(app, out);
  assert.equal(result.status, 0, result.stderr);

  const combined = `${readFileSync(out, 'utf8')}\n${readFileSync(jsonPath, 'utf8')}`;
  for (const secret of [
    'p@ssw0rd!',
    'hunter2',
    'AKIA' + 'IOSFODNN7EXAMPLE'.slice(0, 16),
    'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
  ]) {
    assert.equal(combined.includes(secret), false, `${secret} must be redacted`);
  }
  assert.match(combined, /DB_PASSWORD=<redacted>/);
  assert.equal(readFileSync(jsonPath, 'utf8').includes(work), false, 'JSON paths must be relative');
});

test('JSON output never overwrites a custom Markdown report', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  const out = join(work, 'report.txt');
  makeFixture(app);
  const { result, jsonPath } = scanToJson(app, out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(jsonPath, `${out}.json`);
  assert.match(readFileSync(out, 'utf8'), /^# Launch Triage report/);
  assert.equal(JSON.parse(readFileSync(jsonPath, 'utf8')).schemaVersion, 1);
  assert.equal(jsonOutputPath('/tmp/report.MD'), '/tmp/report.json');
  assert.equal(jsonOutputPath('/tmp/report'), '/tmp/report.json');
});

test('CLI validates help, version, options, targets, dates, and finding thresholds', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  makeFixture(app);

  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.equal(run(['--version']).stdout.trim(), '1.2.1');

  for (const args of [
    ['--bogus'],
    [app, '--out'],
    [app, '--client', '--json'],
    [app, '--date', '2026-02-30'],
    [app, '--fail-on', 'unknown'],
    [app, '--annotate', '--no-annotate'],
    [app, 'another-path'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(' ')} should fail`);
    assert.match(result.stderr, /Error:/);
  }

  const fileTarget = run([join(app, 'package.json')]);
  assert.equal(fileTarget.status, 2);
  assert.match(fileTarget.stderr, /must be a directory/);

  const empty = join(work, 'empty');
  mkdirSync(empty);
  const emptyTarget = run([empty]);
  assert.equal(emptyTarget.status, 2);
  assert.match(emptyTarget.stderr, /No supported source files/);

  const threshold = run([app, '--out', join(work, 'threshold.md'), '--fail-on', 'high']);
  assert.equal(threshold.status, 1);

  const disabledThreshold = run([app, '--out', join(work, 'none.md'), '--fail-on', 'none']);
  assert.equal(disabledThreshold.status, 0);
});

test('partial coverage is reported and cannot produce a successful clean exit', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  const hiddenKey = 'AKIA' + 'OVERSIZEDSOURCE1'.slice(0, 16);
  write(app, 'package.json', '{"name":"partial-coverage"}\n');
  write(app, 'src/large.js', `${'x'.repeat(601 * 1024)}\nexport const key = "${hiddenKey}";\n`);

  const out = join(work, 'partial.md');
  const { result, payload } = scanToJson(app, out);
  assert.equal(result.status, 2);
  assert.equal(payload.coverage.status, 'partial');
  assert.equal(payload.coverage.skippedCount, 1);
  assert.deepEqual(payload.coverage.skipped, [{
    file: 'src/large.js',
    reason: 'larger than the 614400-byte limit',
  }]);
  assert.match(readFileSync(out, 'utf8'), /This scan is incomplete and exits with code 2/);
  assert.match(result.stderr, /Coverage incomplete/);
});

test('git exposure distinguishes committed values from staged-only values and nested roots', (t) => {
  const work = workspace(t);
  const root = join(work, 'repo');
  mkdirSync(root);
  write(root, 'app/package.json', '{"name":"nested"}\n');
  write(root, 'app/src/config.js', 'export const mode = "safe";\n');
  initGit(root, ['app']);

  const stagedKey = 'AKIA' + 'STAGEDVALUE123456'.slice(0, 16);
  write(root, 'app/src/config.js', `export const key = "${stagedKey}";\n`);
  git(root, ['add', '--', 'app/src/config.js']);

  const staged = scanToJson(join(root, 'app'), join(work, 'staged.md'));
  assert.equal(staged.result.status, 0, staged.result.stderr);
  const stagedFinding = staged.payload.findings.find(({ id }) => id === 'SEC-2');
  assert.equal(stagedFinding.severity, 'Medium');
  assert.match(stagedFinding.consequence, /no matching value detected/);

  git(root, ['-c', 'user.name=Launch Triage Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-qm', 'Add synthetic key']);
  const committed = scanToJson(join(root, 'app'), join(work, 'committed.md'));
  assert.equal(committed.result.status, 0, committed.result.stderr);
  const committedFinding = committed.payload.findings.find(({ id }) => id === 'SEC-2');
  assert.equal(committedFinding.severity, 'Critical');
  assert.match(committedFinding.consequence, /current git commit/);

  const replacementKey = 'AKIA' + 'REPLACEDVALUE6543'.slice(0, 16);
  write(root, 'app/src/config.js', `export const key = "${replacementKey}";\n`);
  git(root, ['add', '--', 'app/src/config.js']);

  const replaced = scanToJson(join(root, 'app'), join(work, 'replaced.md'));
  assert.equal(replaced.result.status, 0, replaced.result.stderr);
  const replacedFinding = replaced.payload.findings.find(({ id }) => id === 'SEC-2');
  assert.equal(replacedFinding.severity, 'Medium');
  assert.match(replacedFinding.consequence, /no matching value detected/);
});

test('git exposure matches the complete private key and exact env assignment', (t) => {
  const work = workspace(t);
  const root = join(work, 'repo');
  const header = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  const footer = ['-----END', 'PRIVATE', 'KEY-----'].join(' ');
  const shared = 'MIISharedSyntheticPayloadLine1234567890=';
  const key = (suffix) => `${header}\n${shared}\n${suffix}\n${footer}\n`;

  write(root, 'app/package.json', '{"name":"exact-git-values"}\n');
  write(root, 'app/key.pem', key('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'));
  write(root, 'app/.env', 'DB_PASSWORD=safe-old-value\n');
  initGit(root, ['app']);

  const committed = scanToJson(join(root, 'app'), join(work, 'exact-committed.md'));
  assert.equal(committed.payload.findings.find(({ id }) => id === 'SEC-1').severity, 'Critical');
  assert.equal(committed.payload.findings.find(({ id }) => id === 'SEC-3').severity, 'Critical');

  write(root, 'app/key.pem', key('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'));
  write(root, 'app/.env', 'DB_PASSWORD=a\n');
  git(root, ['add', '--', 'app/key.pem', 'app/.env']);

  const replaced = scanToJson(join(root, 'app'), join(work, 'exact-replaced.md'));
  assert.equal(replaced.payload.findings.find(({ id }) => id === 'SEC-1').severity, 'Medium');
  assert.equal(replaced.payload.findings.find(({ id }) => id === 'SEC-3').severity, 'Medium');
});

test('credentials are checked outside production paths and test-mode keys are not called live', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  const aws = 'AKIA' + 'NONPRODFIXTURE123'.slice(0, 16);
  const workflowKey = 'AKIA' + 'WORKFLOWFIXTURE1'.slice(0, 16);
  const stripe = ['sk', 'test', 'syntheticvalue123456789012'].join('_');
  write(app, 'package.json', '{"name":"credential-scope"}\n');
  write(app, 'test/config.js', `export const key = "${aws}";\n`);
  write(app, '.github/workflows/leak.yml', `env:\n  ACCESS_KEY: "${workflowKey}"\n`);
  write(app, 'src/payments.js', `export const key = "${stripe}";\n`);
  initGit(app, ['.']);

  const { payload } = scanToJson(app, join(work, 'credential-scope.md'));
  const nonProduction = payload.findings.find(({ id, file }) => id === 'SEC-2' && file === 'test/config.js');
  const workflow = payload.findings.find(({ id, file }) => id === 'SEC-2' && file === '.github/workflows/leak.yml');
  const testMode = payload.findings.find(({ id, file }) => id === 'SEC-2' && file === 'src/payments.js');
  assert.equal(nonProduction.severity, 'Critical');
  assert.equal(workflow.severity, 'Critical');
  assert.equal(testMode.severity, 'High');
  assert.equal(testMode.title, 'Provider credential found in source');
  assert.doesNotMatch(testMode.title, /live/i);
});

test('arrow handlers, unused guards, and webhook lookalikes do not bypass rules', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  write(app, 'package.json', '{"name":"handler-precision"}\n');
  write(app, 'src/app/api/orders/route.ts', `import { getUser } from "./auth";
export const POST = async (req: Request) => Response.json(await req.json());
function getUser() { return { id: "unused" }; }
`);
  write(app, 'src/app/api/mixed/route.ts', `export async function POST() {
  const user = await requireUser();
  return Response.json({ user });
}
export const DELETE = async () => Response.json({ deleted: true });
`);
  write(app, 'src/app/api/webhooks/fake/route.ts', `function verifySignature(_value: string) { return true; }
const verifier = { verifySignature(_value: string) { return true; } };
const makeHash = () => createHmac("sha256", "unused");
function unusedSafety(event: { id: string }) {
  verifySignature(event);
  saveIfNew(event.id);
}
export const POST = async (req: Request) => {
  const event = await req.json();
  const idempotentMode = true;
  console.log(event.id, makeHash, verifier, idempotentMode); // stripe.webhooks.constructEvent(req)
  await fulfil(event);
  return Response.json({ ok: true });
};
`);
  write(app, 'src/app/api/webhooks/verified/route.ts', `export const POST = async (req: Request) => {
  const event = new Webhook(process.env.WEBHOOK_SECRET).verify(await req.text(), {});
  await saveIfNew(event.id);
  return Response.json({ ok: true });
};
`);

  const { payload } = scanToJson(app, join(work, 'handler-precision.md'));
  const idsFor = (file) => payload.findings.filter((finding) => finding.file === file).map(({ id }) => id);
  assert.deepEqual(idsFor('src/app/api/orders/route.ts'), ['AUTH-1']);
  assert.deepEqual(idsFor('src/app/api/mixed/route.ts'), ['AUTH-1']);
  assert.deepEqual(idsFor('src/app/api/webhooks/fake/route.ts'), ['PAY-1', 'PAY-2']);
  assert.deepEqual(idsFor('src/app/api/webhooks/verified/route.ts'), []);
});

test('comments, policy settings, and env templates do not become secret findings', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  write(app, 'package.json', '{"name":"secret-controls"}\n');
  write(app, 'src/app/settings.ts', `"use client";
// Never reference SUPABASE_SERVICE_ROLE_KEY from this module.
export const passwordMinLength = process.env.NEXT_PUBLIC_PASSWORD_MIN_LENGTH;
`);
  write(app, '.env.example', 'NEXT_PUBLIC_STRIPE_SECRET_KEY=your_secret_key\n');

  const { payload } = scanToJson(app, join(work, 'secret-controls.md'));
  const secretFindings = payload.findings.filter(({ id }) => id === 'SEC-4' || id === 'SEC-5');
  assert.deepEqual(secretFindings, []);
});

test('DATA-1 severity requires production client-reachable database usage', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  write(app, 'package.json', JSON.stringify({ dependencies: { '@supabase/supabase-js': '2.0.0' } }));
  write(app, 'migrations/001.sql', 'CREATE TABLE profile (id uuid primary key);\n');
  write(app, 'src/lib/db-admin.ts', 'import "server-only";\nimport { createClient } from "@supabase/supabase-js";\n');

  const serverOnly = scanToJson(app, join(work, 'server.md'));
  assert.equal(serverOnly.payload.findings.find(({ id }) => id === 'DATA-1').severity, 'Medium');

  write(app, 'src/lib/firebase-browser.ts', '"use client";\nimport { getFirestore } from "firebase/firestore";\n');
  const unrelatedClientDb = scanToJson(app, join(work, 'firebase.md'));
  assert.equal(unrelatedClientDb.payload.findings.find(({ id }) => id === 'DATA-1').severity, 'Medium');

  write(app, 'src/lib/db-browser.ts', '"use client";\nimport { createClient } from "@supabase/supabase-js";\n');
  const browser = scanToJson(app, join(work, 'browser.md'));
  assert.equal(browser.payload.findings.find(({ id }) => id === 'DATA-1').severity, 'Critical');
});

test('requested dependency audits record failures and DEP-1 parsing is explicit', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  makeFixture(app);
  const audited = scanToJson(app, join(work, 'audit.md'), ['--audit']);
  assert.equal(audited.result.status, 2);
  assert.equal(audited.payload.audit.status, 'failed');
  assert.match(readFileSync(join(work, 'audit.md'), 'utf8'), /Dependency audit: Failed/);

  const finding = dependencyAuditFinding({
    metadata: { vulnerabilities: { critical: 1, high: 2, moderate: 3 } },
  }, '/repo/package.json');
  assert.equal(finding.id, 'DEP-1');
  assert.equal(finding.severity, 'High');
  assert.match(finding.title, /^3 high or critical/);

  const hostileDetail = 'registry https://user:private-token@example.invalid/npm\n/work/private-project';
  const safeDetail = dependencyAuditFailureDetail({ error: { detail: hostileDetail } });
  assert.equal(safeDetail, 'npm audit returned an error response without vulnerability metadata');
  assert.doesNotMatch(safeDetail, /private-token|private-project/);
});

test('Launch Triage can scan itself without app-only false positives', (t) => {
  const work = workspace(t);
  const self = scanToJson(repo, join(work, 'self.md'));
  assert.equal(self.result.status, 0, self.result.stderr);
  assert.deepEqual(self.payload.findings, []);
});

test('npm pack metadata supports npm 11 and npm 12 JSON output', () => {
  const metadata = { filename: 'launch-triage.tgz', files: [] };
  assert.deepEqual(packedPackageMetadata(JSON.stringify([metadata])), metadata);
  assert.deepEqual(packedPackageMetadata(JSON.stringify({ 'launch-triage': metadata })), metadata);
  assert.throws(
    () => packedPackageMetadata(JSON.stringify({})),
    /expected exactly one packed package/,
  );
  assert.throws(
    () => packedPackageMetadata(JSON.stringify({ first: metadata, second: metadata })),
    /expected exactly one packed package/,
  );
});

test('packed CLI and composite action execute the release payload', (t) => {
  const work = workspace(t);
  const app = join(work, 'app');
  makeFixture(app);
  const npmEnv = { ...process.env, npm_config_dry_run: 'false' };

  const packed = packedPackageMetadata(runNpm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', work,
  ], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: npmEnv,
  }));

  const packedFiles = new Map(packed.files.map((file) => [file.path, file]));
  assert.deepEqual([...packedFiles.keys()].sort(), [
    'CHANGELOG.md',
    'CONTRIBUTING.md',
    'LICENSE',
    'README.md',
    'SECURITY.md',
    'examples/sample-report.md',
    'package.json',
    'scan.mjs',
  ]);
  assert.notEqual(packedFiles.get('scan.mjs').mode & 0o111, 0, 'scan.mjs must be executable');

  const packagePath = join(work, packed.filename);
  const installRoot = join(work, 'installed-package');
  runNpm([
    'install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund', packagePath,
  ], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'], env: npmEnv });
  const packageReport = join(work, 'package-report.md');
  const installedBin = join(
    installRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'launch-triage.cmd' : 'launch-triage',
  );
  const packagedRun = spawnSync(installedBin, [
    app, '--out', packageReport, '--fail-on', 'none',
  ], {
    cwd: work,
    encoding: 'utf8',
    env: npmEnv,
    shell: process.platform === 'win32',
  });
  assert.equal(packagedRun.status, 0, packagedRun.stderr);
  assert.equal(existsSync(packageReport), true, 'packaged CLI must write its report');

  const actionYaml = readFileSync(join(repo, 'action.yml'), 'utf8');
  assert.match(actionYaml, /bash \"\$GITHUB_ACTION_PATH\/action\/run\.sh\"/);
  assert.doesNotMatch(actionYaml, /launch-triage@latest/);

  const runAction = (shouldAnnotate) => {
    const runnerTemp = join(work, `action-${shouldAnnotate}`);
    mkdirSync(runnerTemp, { recursive: true });
    return {
      runnerTemp,
      result: spawnSync('bash', [join(repo, 'action', 'run.sh')], {
        cwd: work,
        encoding: 'utf8',
        env: {
          ...npmEnv,
          GITHUB_ACTIONS: 'true',
          GITHUB_ACTION_PATH: repo,
          GITHUB_STEP_SUMMARY: join(runnerTemp, 'summary.md'),
          RUNNER_TEMP: runnerTemp,
          LT_PATH: app,
          LT_FAIL_ON: 'none',
          LT_AUDIT: 'false',
          LT_ANNOTATE: String(shouldAnnotate),
        },
      }),
    };
  };

  const actionOff = runAction(false);
  assert.equal(actionOff.result.status, 0, actionOff.result.stderr);
  assert.doesNotMatch(actionOff.result.stdout, /::(?:error|warning) file=/);
  assert.equal(existsSync(join(actionOff.runnerTemp, 'launch-triage.md')), true);
  assert.equal(existsSync(join(actionOff.runnerTemp, 'summary.md')), true);

  const actionOn = runAction(true);
  assert.equal(actionOn.result.status, 0, actionOn.result.stderr);
  assert.match(actionOn.result.stdout, /::(?:error|warning) file=/);
  assert.equal(existsSync(join(actionOn.runnerTemp, 'launch-triage.md')), true);
  assert.equal(existsSync(join(actionOn.runnerTemp, 'summary.md')), true);
});

test('redaction handles punctuation-heavy and URL credentials', () => {
  assert.equal(redact('DB_PASSWORD=p@ssw0rd!'), 'DB_PASSWORD=<redacted>');
  assert.equal(redact('DATABASE_URL=postgres://alice:hunter2@db/acme'), 'DATABASE_URL=<redacted>');
});
