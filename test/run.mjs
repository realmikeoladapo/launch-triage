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
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './make-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
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
for (const id of ['SEC-1', 'SEC-2', 'SEC-3']) {
  const finding = findings.find((item) => item.id === id);
  if (finding?.severity !== 'High' || !finding.title.includes('git state cannot be verified')) {
    console.error(`STATE  ${id} in a non-git directory must be High without claiming it was committed`);
    failed++;
  }
}
for (const f of MUST_NOT_FLAG) {
  if (files.includes(f)) { console.error(`FALSE  ${f} should not have been flagged`); failed++; }
}

// Exit codes. CI has to be able to tell a real finding from a broken tool, so
// tool errors are 2 and findings are 1. Publishing a scanner that fails a
// pipeline incorrectly would undo the whole point of the precision work.
const clean = join(work, 'clean');
makeFixture(clean);
for (const f of ['service-account.json', '.env', 'src/lib/uploader.js', 'src/lib/db-browser.ts',
                 'src/app/config.ts', 'src/app/api/invoices/route.ts',
                 'src/app/api/webhooks/payments/route.ts', 'src/lib/sync.ts',
                 'supabase/migrations/0001_init.sql', 'tsconfig.json']) {
  rmSync(join(clean, f), { force: true });
}

const exitCode = (args) =>
  spawnSync('node', [scan, ...args], { stdio: 'ignore' }).status;

const CODES = [
  ['defects, --fail-on critical', 1, [app, '--out', join(work, 'x1.md'), '--fail-on', 'critical']],
  ['defects, --fail-on none',     0, [app, '--out', join(work, 'x2.md'), '--fail-on', 'none']],
  ['defects, no threshold',       0, [app, '--out', join(work, 'x3.md')]],
  ['clean, --fail-on critical',   0, [clean, '--out', join(work, 'x4.md'), '--fail-on', 'critical']],
  ['unknown --fail-on value',     2, [app, '--out', join(work, 'x5.md'), '--fail-on', 'wrong']],
  ['missing path',                2, [join(work, 'does-not-exist')]],
  ['missing --fail-on value',     2, [app, '--out', join(work, 'x6.md'), '--fail-on']],
  ['missing --out value',         2, [app, '--out']],
  ['unknown option',              2, [app, '--out', join(work, 'x7.md'), '--surprise', 'yes']],
];
for (const [desc, want, args] of CODES) {
  const got = exitCode(args);
  if (got !== want) { console.error(`EXIT   ${desc}: expected ${want}, got ${got}`); failed++; }
}

// A bad threshold must be rejected before any scanning happens.
if (existsSync(join(work, 'x5.md'))) {
  console.error('EXIT   unknown --fail-on wrote a report; it must validate before scanning');
  failed++;
}
for (const file of ['x6.md', 'x7.md']) {
  if (existsSync(join(work, file))) {
    console.error(`EXIT   invalid arguments wrote ${file}; validation must happen before scanning`);
    failed++;
  }
}

// Git exposure states. A tracked path is not proof that a newly added value
// was committed, so exercise HEAD, index, history, and working tree separately.
const gitRepo = join(work, 'git-state');
const gitFile = (path, content) => {
  const full = join(gitRepo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};
const git = (args) => execFileSync('git', args, { cwd: gitRepo, stdio: 'ignore' });
mkdirSync(gitRepo, { recursive: true });
git(['init', '-q']);
git(['config', 'user.name', 'Launch Triage Tests']);
git(['config', 'user.email', 'tests@example.invalid']);
gitFile('src/config.js', 'export const enabled = true;\n');
git(['add', '.']);
git(['commit', '-qm', 'clean baseline']);

const stateKey = 'AKIA' + 'Q'.repeat(16);
const stagedKey = 'AKIA' + 'R'.repeat(16);
const workingKey = 'AKIA' + 'S'.repeat(16);
const scanGitState = (label) => {
  const stateOut = join(work, `${label}.md`);
  execFileSync('node', [scan, gitRepo, '--out', stateOut, '--json'], { stdio: 'ignore' });
  return JSON.parse(readFileSync(stateOut.replace(/\.md$/, '.json'), 'utf8')).findings;
};
const assertState = (label, path, severity, title, consequence) => {
  const finding = scanGitState(label).find((item) => item.id === 'SEC-2' && item.file.endsWith(path));
  if (!finding || finding.severity !== severity || finding.title !== title || !finding.consequence.includes(consequence)) {
    console.error(`STATE  ${label}: expected ${severity} "${title}" for ${path}`);
    failed++;
  }
};

gitFile('src/config.js', `export const key = "${stateKey}";\n`);
assertState('state-working', '/src/config.js', 'Medium', 'Provider credential is present only in the working tree', 'not found in HEAD, the git index, or repository history');
git(['add', 'src/config.js']);
assertState('state-staged', '/src/config.js', 'High', 'Provider credential is staged for commit', 'in the git index but not in HEAD or prior history');
git(['commit', '-qm', 'stage secret for state test']);
assertState('state-committed', '/src/config.js', 'Critical', 'Provider credential is committed in HEAD', 'current committed revision');
gitFile('src/config.js', 'export const enabled = true;\n');
git(['add', 'src/config.js']);
git(['commit', '-qm', 'remove secret for state test']);
gitFile('src/config.js', `export const key = "${stateKey}";\n`);
assertState('state-history', '/src/config.js', 'Critical', 'Provider credential remains in git history', 'found in repository history');

gitFile('src/staged.js', `export const key = "${stagedKey}";\n`);
git(['add', 'src/staged.js']);
assertState('state-new-staged', '/src/staged.js', 'High', 'Provider credential is staged for commit', 'in the git index but not in HEAD or prior history');
gitFile('src/working.js', `export const key = "${workingKey}";\n`);
assertState('state-new-working', '/src/working.js', 'Medium', 'Provider credential is present only in the working tree', 'not found in HEAD, the git index, or repository history');

// Distribution smoke test. The source file working locally is not enough:
// users receive the npm tarball and invoke the executable through npx. Pack the
// exact publish payload, assert its contents, then execute its declared bin.
let packed = null;
const npmEnv = { ...process.env, npm_config_dry_run: 'false' };
try {
  [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: npmEnv,
  }));
} catch (error) {
  console.error(`PACK   npm pack failed: ${error.stderr || error.message}`);
  failed++;
}

if (packed) {
  const packedFiles = new Map(packed.files.map((file) => [file.path, file]));
  for (const path of ['LICENSE', 'README.md', 'package.json', 'scan.mjs']) {
    if (!packedFiles.has(path)) {
      console.error(`PACK   ${path} is missing from the npm tarball`);
      failed++;
    }
  }
  if ((packedFiles.get('scan.mjs')?.mode & 0o111) === 0) {
    console.error('PACK   scan.mjs is not executable in the npm tarball');
    failed++;
  }

  const packageReport = join(work, 'package-report.md');
  const packagedRun = spawnSync('npm', [
    'exec', '--offline', '--yes', '--package', join(work, packed.filename), '--',
    'launch-triage', clean, '--out', packageReport, '--fail-on', 'none',
  ], { cwd: work, encoding: 'utf8', env: npmEnv });

  if (packagedRun.status !== 0) {
    console.error(`PACK   packaged launch-triage command exited ${packagedRun.status}: ${packagedRun.stderr || packagedRun.error || ''}`);
    failed++;
  } else if (!existsSync(packageReport)) {
    console.error('PACK   packaged launch-triage command did not write a report');
    failed++;
  }

  // Exercise the same shell entrypoint used by the composite action. The false
  // case is important because GitHub sets GITHUB_ACTIONS=true automatically.
  const actionYaml = readFileSync(join(repo, 'action.yml'), 'utf8');
  if (!actionYaml.includes("LT_PACKAGE_SPEC: 'launch-triage@1.1.0'") || actionYaml.includes("default: 'latest'")) {
    console.error('ACTION action.yml must pin the npm package to launch-triage@1.1.0');
    failed++;
  }

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
          GITHUB_STEP_SUMMARY: join(runnerTemp, 'summary.md'),
          RUNNER_TEMP: runnerTemp,
          LT_PACKAGE_SPEC: join(work, packed.filename),
          LT_PATH: app,
          LT_FAIL_ON: 'none',
          LT_AUDIT: 'false',
          LT_ANNOTATE: String(shouldAnnotate),
        },
      }),
    };
  };

  const actionOff = runAction(false);
  if (actionOff.result.status !== 0 || /::(?:error|warning) file=/.test(actionOff.result.stdout)) {
    console.error(`ACTION annotate=false failed or emitted annotations: ${actionOff.result.stderr || actionOff.result.stdout}`);
    failed++;
  } else if (!existsSync(join(actionOff.runnerTemp, 'launch-triage.md'))) {
    console.error('ACTION annotate=false did not write the report artifact');
    failed++;
  }

  const actionOn = runAction(true);
  if (actionOn.result.status !== 0 || !/::(?:error|warning) file=/.test(actionOn.result.stdout)) {
    console.error(`ACTION annotate=true did not emit annotations: ${actionOn.result.stderr || actionOn.result.stdout}`);
    failed++;
  } else if (!existsSync(join(actionOn.runnerTemp, 'launch-triage.md'))) {
    console.error('ACTION annotate=true did not write the report artifact');
    failed++;
  }
}

rmSync(work, { recursive: true, force: true });
if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log(`ok. ${MUST_FIND.length} rules fired, ${MUST_NOT_FLAG.length} controls stayed clean, ${CODES.length} exit codes correct, git states correct, packaged CLI and action executable.`);
