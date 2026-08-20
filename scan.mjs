#!/usr/bin/env node
/**
 * AUTO-1. Production readiness triage engine.
 *
 * Static analysis of a client repository or prototype export. Produces
 * severity-ranked, evidence-backed findings in the shape of
 * a severity-ranked Markdown report.
 *
 * Usage:
 *   node scan.mjs <repo-path> [options]
 *
 * Options:
 *   --out <file>     Write the report here. Default: output/triage-<name>-<date>.md
 *   --client <name>  Client name for the report header
 *   --product <name> Product name for the report header
 *   --audit          Also run `npm audit` in the target repo (network, slower)
 *   --json           Also emit the raw findings as JSON next to the report
 *
 * Design rules:
 *   - Zero dependencies. Node stdlib only.
 *   - Never executes client code. Reading and pattern matching only.
 *   - Every finding carries file, line, and an excerpt. No claim without evidence.
 *   - Rules are capped so one noisy pattern cannot pad the report.
 */

import { readFileSync, readdirSync, statSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, extname, basename, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output', '.astro',
  'coverage', '.turbo', '.vercel', '.netlify', 'vendor', '__pycache__', '.venv',
  'Pods', 'DerivedData', '.expo', '.cache', 'out', 'target',
  // Agent and editor working copies. A git worktree under .claude/ is a second
  // copy of the same source, so scanning it reports every finding twice.
  '.claude', 'worktrees', '.worktrees', '.idea', '.vscode', '.husky',
]);

// Files that can never be a request handler. Used to keep endpoint rules off
// schema, migration, and documentation files.
const HANDLER_EXT = new Set(['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.php']);
const isHandlerFile = (f) => HANDLER_EXT.has(extname(f)) && !/(^|\/)migrations?\//i.test(f);

const CODE_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.astro', '.vue', '.svelte',
  '.sql', '.py', '.rb', '.go', '.php', '.swift', '.kt', '.java', '.env',
  '.json', '.yml', '.yaml', '.toml',
]);

const MAX_FILE_BYTES = 600 * 1024;
const MAX_PER_RULE = 6;

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function collect(root) {
  const files = [];
  (function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.git')) continue;
        walk(full);
      } else if (e.isFile()) {
        const ext = extname(e.name);
        const isEnv = e.name.startsWith('.env');
        if (!CODE_EXT.has(ext) && !isEnv) continue;
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) continue;
        files.push(full);
      }
    }
  })(root);
  return files;
}

function readSafe(f) {
  try { return readFileSync(f, 'utf8'); } catch { return null; }
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function excerptAt(text, index, max = 160) {
  const start = text.lastIndexOf('\n', index) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = text.length;
  let line = text.slice(start, end).trim();
  if (line.length > max) line = line.slice(0, max) + ' ...';
  return line;
}

function redact(s) {
  return s.replace(/([A-Za-z0-9_\-]{12})[A-Za-z0-9_\-]{8,}/g, '$1<redacted>');
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

const findings = [];

function add(f) {
  findings.push(f);
}

function scanPattern({ files, texts, re, ext, id, severity, title, consequence, action, filter, prodOnly, root, trackGit }) {
  let hits = 0;
  for (const file of files) {
    if (ext && !ext.includes(extname(file))) continue;
    if (prodOnly && isNonProduction(root ? relative(root, file) : file)) continue;
    const text = texts.get(file);
    if (!text) continue;
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (filter && !filter(m, text, file)) continue;
      const finding = {
        id, severity, title,
        file, line: lineOf(text, m.index),
        excerpt: redact(excerptAt(text, m.index)),
        consequence, action,
      };
      if (trackGit) {
        Object.defineProperty(finding, '_evidenceToken', { value: m[0], enumerable: false });
      }
      add(finding);
      if (++hits >= MAX_PER_RULE) return;
      break; // one hit per file keeps the report readable
    }
  }
}

// Git reality. A tracked path is not proof that the value currently on disk was
// committed. Check the exact detected value against HEAD, the index, and prior
// history before describing its exposure.
function gitFacts(root) {
  const run = (args) => {
    try {
      return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
      });
    } catch { return null; }
  };
  const inside = run(['rev-parse', '--is-inside-work-tree']);
  if (inside?.trim() !== 'true') return { isRepo: false };

  const contains = (text, token) => typeof text === 'string' && token && text.includes(token);
  return {
    isRepo: true,
    exposure(relPath, token) {
      if (contains(run(['show', `HEAD:${relPath}`]), token)) return 'committed';

      // Pickaxe searches for commits where this exact string was introduced or
      // removed. It avoids treating an old version of the same path as proof
      // that the current value was ever committed.
      const history = run(['log', '--all', '--format=%H', `-S${token}`, '--', relPath]);
      if (history?.trim()) return 'history';

      if (contains(run(['show', `:${relPath}`]), token)) return 'staged';
      return 'working';
    },
  };
}

// A module that imports Node built-ins, or declares itself server-only, cannot
// end up in a browser bundle. Checking the source beats guessing from the path,
// which is what made lib/supabase/admin.ts a standing false positive.
const isServerOnlySource = (text) => !text ? false :
  /^\s*import\s+['"]server-only['"]|^\s*['"]use server['"]/m.test(text) ||
  /from\s+['"](node:)?(fs|fs\/promises|child_process|net|dgram|worker_threads|cluster)['"]/.test(text) ||
  /require\(\s*['"](node:)?(fs|child_process)['"]\s*\)/.test(text);

const isClientReachable = (f, text) => {
  const p = f.replace(/\\/g, '/');
  if (!/(^|\/)(src|app|components|pages|screens|lib|hooks)\//.test(p)) return false;
  if (/(^|\/)(api|server|actions|functions|edge)\//.test(p)) return false;
  if (/(^|[/.\-_])(admin|service-role|server)([/.\-_]|$)/i.test(p)) return false;
  if (isServerOnlySource(text)) return false;
  return true;
};

// Not a production request surface. Tests, fixtures, and build or marketing
// scripts must never appear as findings. A false critical in front of a buyer
// costs more than a missed medium.
const isNonProduction = (f) => {
  const p = f.replace(/\\/g, '/');
  return /(^|\/)(tests?|__tests__|__mocks__|e2e|cypress|fixtures|mocks|stories|examples?|scripts|marketing|docs)\//.test(p)
    || /\.(test|spec|stories)\.[jt]sx?$/.test(p)
    || /(^|\/)(stress_|test_|seed|migrate)/.test(p);
};

// Endpoints that are unauthenticated by design. Flagging these as missing
// authorisation is wrong and reads as an automated scan to a technical buyer.
const isPublicByDesign = (f) => {
  const p = f.replace(/\\/g, '/').toLowerCase();
  return /(login|logout|signin|sign-in|signup|sign-up|register|auth|callback|oauth|session|reset-password|forgot|verify|confirm|webhook|health|status|ping|contact|newsletter|subscribe|waitlist|lead|public)/.test(p);
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function runRules(root, files, texts) {
  const rel = (f) => relative(root, f).replace(/\\/g, '/');
  const relFiles = files.map((f) => ({ abs: f, rel: rel(f) }));

  // Does an untrusted client talk to the database directly? This changes what
  // missing row level security actually means, so it is detected once here
  // rather than assumed.
  const usesDirectClientDb = [...texts.values()].some((t) =>
    /@supabase\/(supabase-js|ssr|auth-helpers)|createClientComponentClient|createBrowserClient|firebase\/firestore|PocketBase/.test(t));

  // Exposure of a secret depends on which git layer contains the exact value.
  const git = gitFacts(root);

  // 1. Private keys and credential blocks
  scanPattern({
    files, texts, id: 'SEC-1', severity: 'Critical',
    re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    title: 'Private key found',
    consequence: 'A private key is present. Its git state determines whether it has been distributed.',
    action: 'Remove the key, rotate the credential at the provider, and move it to environment configuration.',
    trackGit: true,
  });

  // 2. Cloud provider access keys
  scanPattern({
    files, texts, id: 'SEC-2', severity: 'Critical',
    re: /\b(AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{30,})\b/,
    title: 'Live provider credential found in source',
    consequence: 'A live secret in source allows direct billable use of the account and, for payment keys, movement of real money.',
    action: 'Rotate the credential immediately, then remove it from the working tree and from git history.',
    prodOnly: true, root, trackGit: true,
  });

  // 3. Committed .env files carrying values
  for (const { abs, rel: r } of relFiles) {
    if (!basename(r).startsWith('.env')) continue;
    if (basename(r).includes('example') || basename(r).includes('sample')) continue;
    const text = texts.get(abs);
    if (!text) continue;
    // A committed .env is only a critical when it actually carries a secret.
    // Public-prefixed URLs, ports, and booleans are not secrets, and calling
    // them "every secret in this file is disclosed" is a false critical.
    const SECRET_KEY = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DSN|SALT|CLIENT_ID|ACCESS|AUTH|SIGNING|WEBHOOK)/;
    const PUBLIC_PREFIX = /^(NEXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP|PUBLIC)_/;
    let m = null;
    let evidenceToken = null;
    for (const line of text.split('\n')) {
      const kv = /^\s*([A-Z0-9_]+)\s*=\s*["']?([^\s"']+)/.exec(line);
      if (!kv) continue;
      const [, key, value] = kv;
      if (/^(https?:\/\/|true|false|\d+|localhost|development|production|test)$/i.test(value)) continue;
      if (PUBLIC_PREFIX.test(key) && !SECRET_KEY.test(key.replace(PUBLIC_PREFIX, ''))) continue;
      if (!SECRET_KEY.test(key) && value.length < 16) continue;
      m = { index: text.indexOf(line) };
      evidenceToken = value;
      break;
    }
    if (!m) continue;
    const finding = {
      id: 'SEC-3', severity: 'Critical',
      title: 'Environment file contains a secret',
      file: abs, line: lineOf(text, m.index), excerpt: redact(excerptAt(text, m.index)),
      consequence: 'An environment secret is present. Its git state determines whether it has been distributed.',
      action: 'Delete the file from the tree, add it to .gitignore, rotate every value, and purge it from history.',
    };
    Object.defineProperty(finding, '_evidenceToken', { value: evidenceToken, enumerable: false });
    add(finding);
    break;
  }

  // 4. Secrets exposed through public build-time prefixes
  scanPattern({
    files, texts, id: 'SEC-4', severity: 'Critical',
    re: /\b(NEXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP|PUBLIC)_[A-Z0-9_]*(SECRET|SERVICE_ROLE|PRIVATE|PASSWORD)[A-Z0-9_]*/,
    title: 'Secret exposed through a public environment prefix',
    consequence: 'Variables with a public prefix are compiled into the browser bundle. This value is readable by every visitor with developer tools open.',
    action: 'Move the value to a server-only variable and access it from a server route or action.',
    prodOnly: true, root,
  });

  // 5. Supabase service role key reachable from client code
  scanPattern({
    files, texts, id: 'SEC-5', severity: 'Critical',
    re: /SUPABASE_SERVICE_ROLE(_KEY)?|service_role/,
    title: 'Supabase service role key referenced in client-reachable code',
    consequence: 'The service role key bypasses row level security entirely. In a client bundle it grants any visitor full read and write access to every table.',
    action: 'Restrict the service role key to server routes, and use the anon key with row level security from the client.',
    filter: (_m, _t, file) => isClientReachable(rel(file), texts.get(file)),
    prodOnly: true, root,
  });

  // 6. Tables created without row level security
  for (const { abs, rel: r } of relFiles) {
    if (extname(r) !== '.sql') continue;
    const text = texts.get(abs);
    if (!text) continue;
    const created = [...text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?(?:public\.)?["`]?(\w+)/gi)].map((m) => m[1].toLowerCase());
    if (!created.length) continue;
    const rlsOn = new Set([...text.matchAll(/alter\s+table\s+["`]?(?:public\.)?["`]?(\w+)["`]?\s+enable\s+row\s+level\s+security/gi)].map((m) => m[1].toLowerCase()));
    const missing = [...new Set(created)].filter((t) => !rlsOn.has(t));
    if (!missing.length) continue;
    const m = /create\s+table/i.exec(text);
    // The severity of missing RLS depends entirely on whether the database is
    // reachable by an untrusted client. With Supabase the anon key hits Postgres
    // directly, so no RLS is full exposure. Behind a server-only ORM such as
    // Prisma against a private database, RLS is defence in depth, not a breach.
    add(usesDirectClientDb ? {
      id: 'DATA-1', severity: 'Critical',
      title: `Tables created without row level security: ${missing.slice(0, 6).join(', ')}`,
      file: abs, line: lineOf(text, m.index), excerpt: redact(excerptAt(text, m.index)),
      consequence: 'With row level security disabled, the anon key can read and write every row in these tables. This is the most common cause of full data exposure in Supabase products.',
      action: 'Enable row level security on each table and add explicit policies for select, insert, update, and delete.',
    } : {
      id: 'DATA-1', severity: 'Medium',
      title: `Tables created without row level security: ${missing.slice(0, 6).join(', ')}`,
      file: abs, line: lineOf(text, m.index), excerpt: redact(excerptAt(text, m.index)),
      consequence: 'No client-facing database SDK was detected, so these tables appear to be reachable only through server code. Missing row level security is therefore defence in depth rather than direct exposure, and it becomes critical the moment any client is given direct database access.',
      action: 'Enable row level security before exposing the database to any client, and keep all access behind server routes until then.',
    });
    break;
  }

  // 7. Policies that are effectively public
  scanPattern({
    files, texts, ext: ['.sql'], id: 'DATA-2', severity: 'Critical',
    re: /create\s+policy[\s\S]{0,240}?using\s*\(\s*true\s*\)/i,
    title: 'Row level security policy evaluates to true for everyone',
    consequence: 'A policy of USING (true) satisfies row level security while granting universal access. The protection appears enabled and is not.',
    action: 'Scope the policy to the authenticated owner, for example USING (auth.uid() = user_id).',
  });

  // 8. Route handlers with no authorisation check
  {
    let hits = 0;
    for (const { abs, rel: r } of relFiles) {
      if (hits >= MAX_PER_RULE) break;
      if (!/(^|\/)(app|pages)\/.*(route|api)/.test(r) && !/(^|\/)api\//.test(r)) continue;
      if (!['.ts', '.js', '.tsx', '.jsx'].includes(extname(r))) continue;
      if (isNonProduction(r) || isPublicByDesign(r)) continue;
      const text = texts.get(abs);
      if (!text) continue;
      const m = /export\s+(?:async\s+)?function\s+(POST|PUT|PATCH|DELETE)|export\s+default\s+async\s+function\s+handler/.exec(text);
      if (!m) continue;
      // Recognise the common guard conventions before claiming a route is open.
      // The require*/assert*/ensure* helper pattern is widespread and missing it
      // produces false criticals, which cost more than a missed medium.
      if (/(getServerSession|auth\(\)|getUser|verifyToken|currentUser|clerk|withApiAuth|isAuthenticated|getSession|getAuth)/i.test(text)) continue;
      // \w* not [A-Z]\w*: the latter consumes the capital letter, so a name that
      // starts with the noun (requireUserId) can never match the alternation.
      if (/\b(require|assert|ensure|check|verify)\w*(User|Session|Auth|Authenticated|Staff|Admin|Member|Owner|Actor|Account|Tenant|Workspace|Permission|Role|Access|Identity|Login)\w*\s*\(/.test(text)) continue;
      if (/\b(authorize|authorise|protectRoute|withAuth|guard)\w*\s*\(/i.test(text)) continue;
      if (/\b(is|has|can)(Authorized|Authorised|Authed|Admin|Staff|Access|Permission|Permitted|Owner)\w*\s*[({]/i.test(text)) continue;
      // A handler that can return 401 or 403 has an access control, whatever it
      // is called. Language-agnostic and the least fragile signal available.
      if (/status:\s*(401|403)\b|\.status\(\s*(401|403)\s*\)|\b(401|403)\s*\)|['"](Unauthorized|Unauthorised|Forbidden)['"]/i.test(text)) continue;
      add({
        id: 'AUTH-1', severity: 'Critical',
        title: 'Mutating API route with no visible authorisation check',
        file: abs, line: lineOf(text, m.index), excerpt: redact(excerptAt(text, m.index)),
        consequence: 'Any unauthenticated caller can invoke this endpoint directly and change data. The user interface hiding the button is not a control.',
        action: 'Resolve the session at the top of the handler, reject when absent, and verify the caller owns the record being changed.',
      });
      hits++;
    }
  }

  // 9. Webhooks without signature verification
  {
    let hits = 0;
    for (const { abs, rel: r } of relFiles) {
      if (hits >= MAX_PER_RULE) break;
      if (!/webhook/i.test(r) || isNonProduction(r)) continue;
      if (!isHandlerFile(r)) continue; // schema and migration files are not endpoints
      const text = texts.get(abs);
      if (!text) continue;
      if (/(constructEvent|verifyHeader|createHmac|verifySignature|svix|Webhook\s*\(|x-signature|stripe-signature|hmac|signature)/i.test(text)) continue;
      const m = /(export\s+(?:async\s+)?function\s+POST|export\s+default|async\s+def\s+\w+|def\s+\w+)/.exec(text) || { index: 0 };
      add({
        id: 'PAY-1', severity: 'Critical',
        title: 'Webhook endpoint without signature verification',
        file: abs, line: lineOf(text, m.index), excerpt: redact(excerptAt(text, m.index)),
        consequence: 'Anyone who learns the URL can post a forged event. For payment webhooks that means granting paid access or crediting an account without a real payment.',
        action: 'Verify the provider signature against the raw request body before any handling, and reject on failure.',
      });
      hits++;
    }
  }

  // 10. Webhooks without idempotency
  {
    let hits = 0;
    for (const { abs, rel: r } of relFiles) {
      if (hits >= MAX_PER_RULE) break;
      if (!/webhook/i.test(r) || isNonProduction(r)) continue;
      if (!isHandlerFile(r)) continue; // schema and migration files are not endpoints
      const text = texts.get(abs);
      if (!text) continue;
      if (/(idempoten|event\.id|event_id|alreadyProcessed|processed_events|dedupe|upsert|on_conflict)/i.test(text)) continue;
      const mi = /(export\s+(?:async\s+)?function\s+POST|export\s+default|async\s+def\s+\w+|def\s+\w+)/.exec(text) || { index: 0 };
      add({
        id: 'PAY-2', severity: 'High',
        title: 'Webhook handler has no idempotency guard',
        file: abs, line: lineOf(text, mi.index), excerpt: redact(excerptAt(text, mi.index)),
        consequence: 'Providers retry on timeout or non-2xx responses. Without a guard a retry double-credits the account, duplicates the order, or sends the email twice.',
        action: 'Persist the provider event id and return early when it has already been handled.',
      });
      hits++;
    }
  }

  // 11. Unbounded queries
  scanPattern({
    files, texts, ext: ['.ts', '.tsx', '.js', '.jsx'], id: 'PERF-1', prodOnly: true, root, severity: 'Medium',
    re: /\.from\(['"`]\w+['"`]\)\s*\.select\((?:[^)]*)\)(?![\s\S]{0,120}?\.(limit|range|single|maybeSingle))/,
    title: 'Query selects without a limit or range',
    consequence: 'The query returns the whole table. It is fast on seed data and degrades in production as rows accumulate, until the page times out.',
    action: 'Add an explicit limit or range and paginate the interface.',
  });

  // 12. Sequential awaits inside a loop
  scanPattern({
    files, texts, ext: ['.ts', '.tsx', '.js', '.jsx', '.mjs'], id: 'PERF-2', prodOnly: true, root, severity: 'Medium',
    re: /for\s*\((?:const|let|var)\s+\w+\s+of\s+[\w.[\]]+\s*\)\s*\{[^}]{0,400}?await\s+/,
    title: 'Awaited call inside a loop',
    consequence: 'Each iteration waits for the previous one. Latency grows linearly with the collection and the request eventually exceeds the platform timeout.',
    action: 'Batch the work into a single query, or run the calls concurrently with Promise.all where ordering does not matter.',
  });

  // 13. Silent error handling
  scanPattern({
    files, texts, ext: ['.ts', '.tsx', '.js', '.jsx', '.mjs'], id: 'OPS-1', prodOnly: true, root, severity: 'High',
    re: /catch\s*\([^)]*\)\s*\{\s*(\}|\/\/[^\n]*\n\s*\})/,
    title: 'Empty catch block swallows the failure',
    consequence: 'The operation fails and nothing records it. The user sees a success state, and the failure is invisible until a customer reports it.',
    action: 'Log the error with context, surface an honest failure state, and report it to monitoring.',
  });

  // 14. No monitoring configured
  {
    const pkgPath = join(root, 'package.json');
    if (existsSync(pkgPath)) {
      const raw = readSafe(pkgPath);
      let pkg = null;
      try { pkg = JSON.parse(raw); } catch { /* ignore */ }
      if (pkg) {
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const names = Object.keys(deps).join(' ');
        if (!/sentry|bugsnag|rollbar|datadog|logtail|highlight|posthog|honeybadger/i.test(names)) {
          add({
            id: 'OPS-2', severity: 'High',
            title: 'No error monitoring dependency present',
            file: pkgPath, line: 1, excerpt: 'dependencies: no monitoring package found',
            consequence: 'Production failures are only discovered when a user reports them. There is no way to tell whether a release made things worse.',
            action: 'Add an error reporting service and verify that a deliberate test error reaches the dashboard before launch.',
          });
        }
        if (!/(ratelimit|rate-limit|upstash|bottleneck|express-rate-limit|limiter)/i.test(names)) {
          add({
            id: 'OPS-3', severity: 'Medium',
            title: 'No rate limiting on public endpoints',
            file: pkgPath, line: 1, excerpt: 'dependencies: no rate limiting package found',
            consequence: 'Public endpoints, especially those calling a paid model API, can be called in a loop by anyone. The first symptom is usually the bill.',
            action: 'Apply a per-identifier rate limit to authentication, contact, and any model-backed route.',
          });
        }
      }
    }
  }

  // 15. TypeScript strictness
  {
    const tsconfig = join(root, 'tsconfig.json');
    if (existsSync(tsconfig)) {
      const raw = readSafe(tsconfig) || '';
      if (/"strict"\s*:\s*false/.test(raw) || !/"strict"\s*:\s*true/.test(raw)) {
        add({
          id: 'QUAL-1', severity: 'Medium',
          title: 'TypeScript strict mode is not enabled',
          file: tsconfig, line: 1, excerpt: 'compilerOptions.strict is not true',
          consequence: 'Null and undefined errors reach runtime instead of the compiler. These are the most common crash class in generated code.',
          action: 'Enable strict mode and resolve the resulting errors before launch.',
        });
      }
    }
  }

  // 16. Mobile release readiness
  {
    const hasExpo = existsSync(join(root, 'app.json')) || existsSync(join(root, 'app.config.js')) || existsSync(join(root, 'app.config.ts'));
    const isRN = existsSync(join(root, 'package.json')) && /react-native|expo/i.test(readSafe(join(root, 'package.json')) || '');
    if (isRN && hasExpo && !existsSync(join(root, 'eas.json'))) {
      add({
        id: 'REL-1', severity: 'High',
        title: 'Expo project without a build configuration',
        file: join(root, 'app.json'), line: 1, excerpt: 'eas.json not present',
        consequence: 'There is no reproducible path to a signed build. Release becomes a manual sequence that works once and cannot be repeated under deadline.',
        action: 'Add eas.json with development, preview, and production profiles, and produce one signed build before committing to a launch date.',
      });
    }
  }

  // Ground every secret finding in what git actually contains. Severity,
  // title, and wording all depend on the layer holding this exact value.
  const labels = {
    'SEC-1': 'Private key',
    'SEC-2': 'Provider credential',
    'SEC-3': 'Environment secret',
  };
  for (const f of findings) {
    if (!['SEC-1', 'SEC-2', 'SEC-3'].includes(f.id)) continue;
    const label = labels[f.id];
    const state = git.isRepo ? git.exposure(rel(f.file), f._evidenceToken) : 'unverified';

    if (state === 'committed') {
      f.severity = 'Critical';
      f.title = `${label} is committed in HEAD`;
      f.consequence = 'This exact value exists in the current committed revision. Anyone with repository access can recover it, and deleting the working file will not remove that exposure.';
      f.action = 'Rotate the credential at the provider first, remove it from the tree, and purge it from git history.';
    } else if (state === 'history') {
      f.severity = 'Critical';
      f.title = `${label} remains in git history`;
      f.consequence = 'This exact value was found in repository history. It remains recoverable from existing clones even if the current revision no longer contains it.';
      f.action = 'Rotate the credential at the provider first, then purge the value from git history and coordinate replacement clones.';
    } else if (state === 'staged') {
      f.severity = 'High';
      f.title = `${label} is staged for commit`;
      f.consequence = 'This exact value is in the git index but not in HEAD or prior history. It has not been committed yet, but the next commit would distribute it.';
      f.action = 'Remove the value from the index and working tree, add the correct ignore rule, and rotate it if the staged content was shared elsewhere.';
    } else if (state === 'working') {
      f.severity = 'Medium';
      f.title = `${label} is present only in the working tree`;
      f.consequence = 'This exact value is on this machine but was not found in HEAD, the git index, or repository history. This is a local near miss, not evidence of repository disclosure.';
      f.action = 'Remove it from the working tree or confirm the ignore rule covers it, and rotate it if this machine or its backups were shared.';
    } else {
      f.severity = 'High';
      f.title = `${label} is present, but git state cannot be verified`;
      f.consequence = 'This exact value is in the working tree, but the target is not a git repository. The scanner cannot determine whether it was distributed elsewhere.';
      f.action = 'Move the value out of the project, establish how the directory was shared, and rotate it if any copy left this machine.';
    }
  }
}

// ---------------------------------------------------------------------------
// Optional dependency audit
// ---------------------------------------------------------------------------

function runAudit(root) {
  if (!existsSync(join(root, 'package.json'))) return;
  let out;
  try {
    out = execFileSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
  } catch (e) {
    out = e.stdout || '';
  }
  if (!out) return;
  let data;
  try { data = JSON.parse(out); } catch { return; }
  const v = data.metadata?.vulnerabilities;
  if (!v) return;
  const bad = (v.critical || 0) + (v.high || 0);
  if (bad === 0) return;
  add({
    id: 'DEP-1', severity: bad >= 1 && v.critical ? 'High' : 'Medium',
    title: `${bad} high or critical dependency vulnerabilities`,
    file: join(root, 'package.json'), line: 1,
    excerpt: `critical: ${v.critical || 0}, high: ${v.high || 0}, moderate: ${v.moderate || 0}`,
    consequence: 'Known exploitable versions are shipping in the build. These are discoverable from the public lockfile by anyone.',
    action: 'Run npm audit fix, upgrade what remains, and record anything deliberately accepted.',
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ORDER = { Critical: 0, High: 1, Medium: 2 };

function buildReport({ client, product, root, findings, fileCount }) {
  const today = new Date().toISOString().slice(0, 10);
  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const counts = sorted.reduce((acc, f) => (acc[f.severity] = (acc[f.severity] || 0) + 1, acc), {});
  const rel = (f) => relative(root, f).replace(/\\/g, '/');

  const critical = counts.Critical || 0;
  const high = counts.High || 0;
  const recommendation = critical > 0
    ? 'Repair first. Do not launch the affected journey until the critical findings are closed.'
    : high > 0
      ? 'Repair first, then proceed. The high findings will surface as production incidents rather than launch blockers.'
      : 'Proceed with the launch decision. No critical or high blocker was found in the inspected surface.';

  const rows = sorted.length
    ? sorted.map((f) =>
        `| ${f.severity} | **${f.title}**<br>\`${rel(f.file)}:${f.line}\`<br>\`${f.excerpt.replace(/\|/g, '\\|')}\` | ${f.consequence} | ${f.action} |`
      ).join('\n')
    : '| | No verified finding in the inspected surface | | |';

  return `# Launch Triage report

Client: ${client}
Product: ${product}
Review date: ${today}
Prepared by: Mike Oladapo
Decision requested: [the launch or product decision this report must support]

## One-page decision

Current state: Automated static review of ${fileCount} source files found ${critical} critical, ${high} high, and ${counts.Medium || 0} medium findings. [Add the one-paragraph human summary here.]

Recommended next action: ${recommendation}

Why: [the smallest evidence-backed explanation, naming the one finding that drives the decision]

## Critical journey

Start: [where the user begins]

Success: [observable end state]

Failure observed: [what happened, with a screenshot, log, test, or code excerpt]

Acceptance test: [the exact result that proves the blocker is resolved]

## Findings

| Severity | Finding and evidence | Production consequence | Recommended action |
| --- | --- | --- | --- |
${rows}

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

Automated static analysis covered ${fileCount} files. It does not execute the
product, test authenticated flows by hand, or inspect infrastructure,
third-party dashboards, or anything outside this repository.
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  const booleanFlags = new Set(['audit', 'json', 'annotate', 'no-annotate']);
  const valueFlags = new Set(['out', 'client', 'product', 'fail-on']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }

    const name = a.slice(2);
    if (booleanFlags.has(name)) {
      args[name] = true;
      continue;
    }
    if (!valueFlags.has(name)) throw new Error(`Unknown option: ${a}`);

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${a}`);
    }
    args[name] = value;
    i++;
  }
  if (args._.length > 1) throw new Error(`Unexpected argument: ${args._[1]}`);
  if (args.annotate && args['no-annotate']) throw new Error('Use either --annotate or --no-annotate, not both.');
  return args;
}

const RANK = { Critical: 3, High: 2, Medium: 1 };
const THRESHOLD = { critical: 3, high: 2, medium: 1, none: 99 };

/**
 * GitHub Actions workflow commands. Findings render inline on the pull request
 * diff, which is the difference between a report someone opens and a report
 * someone reads.
 */
function annotate(findings, root) {
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  for (const f of findings) {
    const level = f.severity === 'Medium' ? 'warning' : 'error';
    const file = relative(root, f.file).replace(/\\/g, '/');
    const msg = esc(`${f.title}. ${f.consequence} Fix: ${f.action}`);
    console.log(`::${level} file=${file},line=${f.line},title=${esc(`${f.id} ${f.severity}`)}::${msg}`);
  }
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const target = args._[0];
  if (!target) {
    console.error('Usage: node scan.mjs <repo-path> [--out file] [--client name] [--product name] [--audit] [--json] [--fail-on critical|high|medium|none] [--annotate|--no-annotate]');
    process.exit(2);
  }
  const root = resolve(target);
  if (!existsSync(root)) {
    console.error(`Path not found: ${root}`);
    process.exit(2);
  }

  // Validate before scanning. A typo should not cost a full scan, and in CI a
  // tool error must be distinguishable from a real finding.
  const failOn = String(args['fail-on'] || 'none').toLowerCase();
  const threshold = THRESHOLD[failOn];
  if (threshold === undefined) {
    console.error(`Unknown --fail-on value: ${failOn}. Use critical, high, medium, or none.`);
    process.exit(2);
  }

  const files = collect(root);
  const texts = new Map();
  for (const f of files) {
    const t = readSafe(f);
    if (t !== null) texts.set(f, t);
  }

  runRules(root, files, texts);
  if (args.audit) runAudit(root);

  const client = args.client || '[name]';
  const product = args.product || basename(root);
  const report = buildReport({ client, product, root, findings, fileCount: texts.size });

  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = resolve(args.out || join(process.cwd(), 'output', `triage-${basename(root)}-${stamp}.md`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report, 'utf8');

  if (args.json) {
    const jsonPath = outPath.replace(/\.md$/, '.json');
    writeFileSync(jsonPath, JSON.stringify({ root, fileCount: texts.size, findings }, null, 2), 'utf8');
  }

  const counts = findings.reduce((a, f) => (a[f.severity] = (a[f.severity] || 0) + 1, a), {});
  console.log(`Scanned ${texts.size} files in ${root}`);
  console.log(`Critical: ${counts.Critical || 0}  High: ${counts.High || 0}  Medium: ${counts.Medium || 0}`);
  console.log(`Report: ${outPath}`);
  if (!findings.length) {
    console.log('No findings. Confirm the scan reached real source before sending anything to a client.');
  }

  const inActions = process.env.GITHUB_ACTIONS === 'true';

  if (findings.length && (args.annotate || (inActions && !args['no-annotate']))) annotate(findings, root);

  // Render the whole report on the workflow run page.
  if (inActions && process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n'); } catch { /* non-fatal */ }
  }

  const worst = findings.reduce((m, f) => Math.max(m, RANK[f.severity] || 0), 0);
  if (worst >= threshold) {
    console.error(`Failing: found a finding at or above "${failOn}".`);
    process.exit(1);
  }
}

main();
