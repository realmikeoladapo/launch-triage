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
 * Run `launch-triage --help` for the complete option and exit-code contract.
 *
 * Design rules:
 *   - Zero dependencies. Node stdlib only.
 *   - Never executes client code. Reading and pattern matching only.
 *   - Every finding carries file, line, and an excerpt. No claim without evidence.
 *   - Rules are capped so one noisy pattern cannot pad the report.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, extname, basename, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PACKAGE = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const VERSION = PACKAGE.version;

const USAGE = `Launch Triage v${VERSION}

Static production-readiness triage for web and mobile codebases.

Usage:
  launch-triage <repo-path> [options]

Options:
  --out <file>          Write the Markdown report to this path
  --client <name>       Client name in the report header
  --product <name>      Product name in the report header
  --prepared-by <name>  Reviewer or organisation in the report header
  --date <YYYY-MM-DD>   Override the local review date (useful for reproducible reports)
  --audit               Also run npm audit in the target repository
  --json                Write versioned JSON beside the Markdown report
  --fail-on <severity>  Exit 1 on critical, high, medium, or none
  --annotate            Emit GitHub Actions annotations
  --no-annotate         Suppress automatic GitHub Actions annotations
  -h, --help            Show this help
  -v, --version         Show the version

Exit codes:
  0  Scan completed
  1  Scan completed and --fail-on threshold was met
  2  Invalid input, incomplete coverage, or operational failure`;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.output', '.astro',
  'output', 'coverage', '.turbo', '.vercel', '.netlify', 'vendor', '__pycache__', '.venv',
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
  '.json', '.yml', '.yaml', '.toml', '.pem', '.key', '.p8',
]);

const SENSITIVE_FILENAMES = new Set(['.npmrc', 'id_rsa', 'id_ecdsa', 'id_ed25519']);
const GENERATED_LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock',
  'bun.lock', 'bun.lockb', 'composer.lock', 'Podfile.lock', 'Cargo.lock', 'Gemfile.lock',
]);

const MAX_FILE_BYTES = 600 * 1024;
const MAX_PER_RULE = 6;
const MAX_REPORTED_SKIPS = 50;

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function collect(root) {
  const files = [];
  const skipped = [];
  let skippedCount = 0;
  const recordSkip = (file, reason) => {
    skippedCount++;
    if (skipped.length < MAX_REPORTED_SKIPS) {
      skipped.push({ file: relative(root, file).replace(/\\/g, '/') || '.', reason });
    }
  };
  (function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { recordSkip(dir, 'directory could not be read'); return; }
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        if (GENERATED_LOCKFILES.has(e.name)) continue;
        const ext = extname(e.name);
        const isEnv = e.name.startsWith('.env');
        if (!CODE_EXT.has(ext) && !isEnv && !SENSITIVE_FILENAMES.has(e.name)) continue;
        let st;
        try { st = statSync(full); } catch { recordSkip(full, 'file metadata could not be read'); continue; }
        if (st.size > MAX_FILE_BYTES) { recordSkip(full, `larger than the ${MAX_FILE_BYTES}-byte limit`); continue; }
        files.push(full);
      }
    }
  })(root);
  return { files: files.sort((a, b) => a < b ? -1 : a > b ? 1 : 0), skipped, skippedCount };
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
  return s
    // Environment-style evidence is safest when the entire value is hidden.
    .replace(/^(\s*[A-Z][A-Z0-9_]*\s*=\s*).+$/gm, '$1<redacted>')
    // JSON/object credentials may contain punctuation that generic token
    // redaction misses, so redact by sensitive field name first.
    .replace(/((?:["']?)(?:private[_-]?key|password|passwd|secret|token|api[_-]?key|credential)(?:["']?)\s*[:=]\s*)("[^"]*(?:"|$)|'[^']*(?:'|$)|[^,\s;}]+)/gi, (_match, prefix, value) => {
      const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
      return `${prefix}${quote}<redacted>${quote}`;
    })
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----.*$/gi, `${['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')} <redacted>`)
    .replace(/\b((?:AKIA|ASIA))[0-9A-Z]{16}\b/g, '$1<redacted>')
    .replace(/\b((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{8,}\b/g, '$1<redacted>')
    .replace(/\b(sk-(?:proj-|svcacct-)?)[A-Za-z0-9_-]{20,}\b/g, '$1<redacted>')
    .replace(/\b(gh[pousr]_)[A-Za-z0-9]{20,}\b/g, '$1<redacted>')
    .replace(/\b(github_pat_)[A-Za-z0-9_]{30,}\b/g, '$1<redacted>')
    .replace(/\b(whsec_)[A-Za-z0-9]{16,}\b/g, '$1<redacted>')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s/]+)(@)/gi, '$1<redacted>$3');
}

function stripComments(text) {
  let out = '';
  let state = 'code';
  let quote = '';
  let lineHasCode = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (state === 'line-comment') {
      if (char === '\n') {
        out += '\n';
        state = 'code';
        lineHasCode = false;
      } else {
        out += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        out += '  ';
        i++;
        state = 'code';
      } else if (char === '\n') {
        out += '\n';
        lineHasCode = false;
      } else {
        out += ' ';
      }
      continue;
    }

    if (state === 'string') {
      out += char;
      if (char === '\\' && next !== undefined) {
        out += next;
        i++;
      } else if (char === quote) {
        state = 'code';
      }
      if (char === '\n') lineHasCode = false;
      else if (!/\s/.test(char)) lineHasCode = true;
      continue;
    }

    if (char === '/' && next === '/') {
      out += '  ';
      i++;
      state = 'line-comment';
      continue;
    }
    if (char === '/' && next === '*') {
      out += '  ';
      i++;
      state = 'block-comment';
      continue;
    }
    if (char === '#' && !lineHasCode) {
      out += ' ';
      state = 'line-comment';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      state = 'string';
    }
    out += char;
    if (char === '\n') lineHasCode = false;
    else if (!/\s/.test(char)) lineHasCode = true;
  }

  return out;
}

function stripCommentsAndStrings(text) {
  return stripComments(text).replace(/(["'`])(?:\\.|(?!\1)[\s\S])*?\1/g, (literal) => literal.replace(/[^\n]/g, ' '));
}

function localDate(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// ---------------------------------------------------------------------------
// Rule helpers
// ---------------------------------------------------------------------------

const findings = [];

function add(f) {
  findings.push(f);
}

function scanPattern({ files, texts, re, ext, id, severity, title, consequence, action, filter, prodOnly, root, gitMatcher, gitExposedSeverity }) {
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
      add({
        id, severity, title,
        file, line: lineOf(text, m.index),
        excerpt: redact(excerptAt(text, m.index)),
        consequence, action,
        gitMatcher: gitMatcher ? gitMatcher(m, text, file) : undefined,
        gitExposedSeverity: gitExposedSeverity ? gitExposedSeverity(m, text, file) : undefined,
      });
      if (++hits >= MAX_PER_RULE) return;
      break; // one hit per file keeps the report readable
    }
  }
}

// Git reality. A tracked path is not proof that the value currently on disk was
// committed: it may only be staged, or it may be a new edit to an old file.
// Inspect the committed blob and reachable patches for the same credential
// pattern before making an exposure claim.
function gitFacts(root) {
  const run = (cwd, args) => {
    try {
      return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
      });
    } catch { return null; }
  };
  const topLevel = run(root, ['rev-parse', '--show-toplevel']);
  const prefixOutput = run(root, ['rev-parse', '--show-prefix']);
  if (topLevel === null || prefixOutput === null) {
    return {
      isRepo: false,
      exposure: () => ({
        severity: 'Medium',
        state: 'present locally; git exposure could not be verified because the target is not inside a git repository',
      }),
    };
  }

  const gitRoot = topLevel.trim();
  const prefix = prefixOutput.trim().replace(/\\/g, '/').replace(/\/$/, '');
  const toRepoPath = (targetPath) => prefix ? `${prefix}/${targetPath}` : targetPath;
  const cache = new Map();

  return {
    isRepo: true,
    exposure(targetPath, matcher, ruleId) {
      const repoPath = toRepoPath(targetPath);
      const cacheKey = `${ruleId}:${repoPath}`;
      if (cache.has(cacheKey)) return cache.get(cacheKey);

      const head = run(gitRoot, ['show', `HEAD:${repoPath}`]);
      if (head !== null && matcher(head)) {
        const result = { severity: 'Critical', state: 'present in the current git commit' };
        cache.set(cacheKey, result);
        return result;
      }

      const history = run(gitRoot, ['log', '--all', '--format=', '-p', '--', repoPath]);
      if (history !== null && matcher(history.replace(/^[+-]/gm, ''))) {
        const result = {
          severity: 'Critical',
          state: 'matched in reachable git history even though it is not present in the current commit',
        };
        cache.set(cacheKey, result);
        return result;
      }

      const result = {
        severity: 'Medium',
        state: history === null
          ? 'present locally; reachable git history could not be inspected'
          : 'present in the working tree or index, with no matching value detected in the current commit or reachable history',
      };
      cache.set(cacheKey, result);
      return result;
    },
  };
}

// A module that imports Node built-ins, or declares itself server-only, cannot
// end up in a browser bundle. Checking the source beats guessing from the path,
// which is what made lib/supabase/admin.ts a standing false positive.
const isServerOnlySource = (text) => {
  if (!text) return false;
  const code = stripComments(text);
  return /^\s*import\s+['"]server-only['"]|^\s*['"]use server['"]/m.test(code)
    || /from\s+['"](node:)?(fs|fs\/promises|child_process|net|dgram|worker_threads|cluster)['"]/.test(code)
    || /require\(\s*['"](node:)?(fs|child_process)['"]\s*\)/.test(code);
};

const isExplicitClientSource = (text) => /^\s*['"]use client['"]/m.test(stripComments(text || ''));

const isClientReachable = (f, text) => {
  const p = f.replace(/\\/g, '/');
  // Explicit bundle intent is stronger evidence than a filename. A file named
  // admin-client.ts is unsafe if it declares itself client-side.
  if (isExplicitClientSource(text)) return true;
  if (isServerOnlySource(text)) return false;
  if (!/(^|\/)(src|app|components|pages|screens|lib|hooks)\//.test(p)) return false;
  if (/(^|\/)(api|server|actions|functions|edge)\//.test(p)) return false;
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
const PUBLIC_ROUTE_SEGMENTS = new Set([
  'login', 'logout', 'signin', 'sign-in', 'signup', 'sign-up', 'register',
  'auth', 'callback', 'oauth', 'session', 'reset-password', 'forgot', 'verify',
  'confirm', 'webhook', 'webhooks', 'health', 'status', 'ping', 'contact',
  'newsletter', 'subscribe', 'waitlist', 'lead', 'public',
]);

const isPublicByDesign = (f) => {
  const p = f.replace(/\\/g, '/').toLowerCase();
  return p.split('/').some((segment) => PUBLIC_ROUTE_SEGMENTS.has(segment.replace(/\.[^.]+$/, '')));
};

const isApiHandlerPath = (f) => {
  const p = f.replace(/\\/g, '/');
  return /(^|\/)app\/.*\/route\.[^/]+$/i.test(p)
    || /(^|\/)pages\/api\//i.test(p)
    || /(^|\/)api\//i.test(p);
};

const EXPORTED_MUTATING_HANDLER = String.raw`export\s+(?:(?:async\s+)?function\s+(?:POST|PUT|PATCH|DELETE)\b|const\s+(?:POST|PUT|PATCH|DELETE)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)`;
const DEFAULT_API_HANDLER = String.raw`export\s+default\s+(?:async\s+)?function\s+handler\b`;

function requestHandlerMatch(text) {
  const code = stripCommentsAndStrings(text);
  return new RegExp(`${EXPORTED_MUTATING_HANDLER}|${DEFAULT_API_HANDLER}|(?:app|router)\\.(?:post|put|patch|delete)\\s*\\(|@(?:app|router)\\.(?:post|put|patch|delete|route)\\b|func\\s+\\w+\\s*\\([^)]*(?:ResponseWriter|\\*http\\.Request)|function\\s+\\w+\\s*\\([^)]*\\$request`, 'i').exec(code);
}

function exportedMutatingHandlerMatches(code) {
  return [...code.matchAll(new RegExp(`${EXPORTED_MUTATING_HANDLER}|${DEFAULT_API_HANDLER}`, 'gi'))];
}

function balancedBlockEnd(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    if (code[i] === '}' && --depth === 0) return i + 1;
  }
  return code.length;
}

function handlerBounds(code, match, fallbackEnd = code.length) {
  const afterMatch = match.index + match[0].length;
  if (match[0].includes('=>')) {
    const nextToken = /\S/.exec(code.slice(afterMatch));
    if (!nextToken) return [match.index, fallbackEnd];
    const bodyStart = afterMatch + nextToken.index;
    if (code[bodyStart] === '{') return [match.index, balancedBlockEnd(code, bodyStart)];
    const semicolon = code.indexOf(';', bodyStart);
    return [match.index, semicolon === -1 || semicolon >= fallbackEnd ? fallbackEnd : semicolon + 1];
  }

  let parenDepth = 0;
  let sawParams = false;
  for (let i = afterMatch; i < fallbackEnd; i++) {
    if (code[i] === '(') { parenDepth++; sawParams = true; continue; }
    if (code[i] === ')') { parenDepth = Math.max(0, parenDepth - 1); continue; }
    if (code[i] === '{' && sawParams && parenDepth === 0) {
      return [match.index, balancedBlockEnd(code, i)];
    }
  }
  return [match.index, fallbackEnd];
}

function verifierCallMatch(code) {
  const verifier = /(?:webhooks?\.)?constructEvent(?:Async)?\s*\(|\bverify(?:Webhook|Header|Signature)\w*\s*\(|\btimingSafeEqual\s*\(|crypto\.subtle\.verify\s*\(|new\s+(?:Webhook|Svix)\s*\([^)]*\)[\s\S]{0,160}?\.verify\s*\(/gi;
  let match;
  while ((match = verifier.exec(code)) !== null) {
    if (/^verify/i.test(match[0])) {
      const prefix = code.slice(Math.max(0, match.index - 80), match.index);
      if (/\b(?:function|def|func)\s+$/.test(prefix)) continue;
      const afterOpen = code.slice(match.index + match[0].length);
      const close = afterOpen.indexOf(')');
      if (close !== -1 && /^\s*(?::[^={;]+)?\s*\{/.test(afterOpen.slice(close + 1))) continue;
    }
    return match;
  }
  return null;
}

function hasIdempotencyGuard(code) {
  const eventIds = [...code.matchAll(/\b(?:(?:event|payload)\s*(?:\.\s*id|\[\s*['"]id['"]\s*\])|event[_-]?id)\b/gi)];
  if (!eventIds.length) return false;
  const controls = [
    /\b(?:saveIfNew|claimEvent|reserveEvent|alreadyProcessed|hasProcessed|isProcessed|dedupe|deduplicate)\w*\s*\(/gi,
    /\.(?:upsert|insertOrIgnore|findOrCreate)\s*\(|\bon[_-]?conflict\b/gi,
    /\bprocessed[_A-Z-]?events?\b[\s\S]{0,240}?\.(?:insert|create|select|find|set)\s*\(/gi,
    /\.(?:set|put)\s*\([^)]*(?:nx\s*:\s*true|ifNoneMatch|if_not_exists)/gi,
  ].flatMap((pattern) => [...code.matchAll(pattern)]);
  return controls.some((control) => eventIds.some((eventId) => Math.abs(control.index - eventId.index) <= 400));
}

const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/;
const PROVIDER_CREDENTIAL_RE = /\b(?:(?:AKIA|ASIA)[0-9A-Z]{16}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|whsec_[A-Za-z0-9]{24,})\b/;
const ENV_SECRET_KEY = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DSN|SALT|CLIENT_ID|ACCESS|AUTH|SIGNING|WEBHOOK)/;
const PUBLIC_ENV_PREFIX = /^(NEXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP|PUBLIC)_/;

function normalizePemText(value) {
  return value
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
}

function privateKeyBlock(text, index) {
  // A shared header or payload prefix cannot identify a specific key. Only a
  // complete BEGIN..END block is strong enough to ground a git exposure claim.
  const header = PRIVATE_KEY_RE.exec(text.slice(index))?.[0];
  if (!header) return null;
  const endMarker = header.replace('BEGIN', 'END');
  const end = text.indexOf(endMarker, index + header.length);
  if (end === -1) return null;
  return normalizePemText(text.slice(index, end + endMarker.length));
}

function envAssignment(line) {
  const kv = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!kv) return null;
  const [, key, rawValue] = kv;
  return { key, value: rawValue.replace(/^['"]|['"]$/g, '').trim() };
}

function findEnvSecret(text) {
  let offset = 0;
  for (const line of text.split('\n')) {
    const assignment = envAssignment(line);
    if (!assignment) { offset += line.length + 1; continue; }
    const { key, value } = assignment;
    const publicName = key.replace(PUBLIC_ENV_PREFIX, '');
    const isSensitiveName = ENV_SECRET_KEY.test(publicName);
    const isPublicNonSecret = PUBLIC_ENV_PREFIX.test(key) && !isSensitiveName;
    const isPlaceholder = !value
      || /^(true|false|\d+|localhost|development|production|test|null|undefined|changeme|replace[_-]?me)$/i.test(value)
      || /^\$\{[^}]+\}$/.test(value)
      || /example|your[_-](?:key|secret|token|password)/i.test(value);
    const hasCredentialUrl = /^[a-z][a-z0-9+.-]*:\/\/[^:\s/]+:[^@\s/]+@/i.test(value);
    const looksOpaque = value.length >= 24 && /^[A-Za-z0-9_./+\-=]+$/.test(value);
    const looksProviderIssued = PROVIDER_CREDENTIAL_RE.test(value);

    if (!isPlaceholder && !isPublicNonSecret && (isSensitiveName || hasCredentialUrl || looksOpaque || looksProviderIssued)) {
      return { index: offset, key, value };
    }
    offset += line.length + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function runRules(root, files, texts) {
  const rel = (f) => relative(root, f).replace(/\\/g, '/');
  const relFiles = files.map((f) => ({ abs: f, rel: rel(f) }));
  const productionFiles = relFiles.filter(({ rel: r }) => !isNonProduction(r));

  // Does an untrusted client talk to the database directly? This changes what
  // missing row level security actually means, so it is detected once here
  // rather than assumed.
  const usesDirectClientPostgres = productionFiles.some(({ abs, rel: r }) => {
    const text = texts.get(abs) || '';
    if (!isClientReachable(r, text)) return false;
    return /(?:from\s+|require\(\s*)['"]@supabase\/(?:supabase-js|ssr|auth-helpers|postgrest-js)['"]|createClientComponentClient|createBrowserClient/i.test(stripComments(text));
  });

  // Exposure of a secret depends on whether git actually has it.
  const git = gitFacts(root);

  // 1. Private keys and credential blocks
  scanPattern({
    files, texts, id: 'SEC-1', severity: 'Critical',
    re: PRIVATE_KEY_RE,
    gitMatcher: (match, text) => {
      const block = privateKeyBlock(text, match.index);
      return block ? (candidate) => normalizePemText(candidate).includes(block) : () => false;
    },
    title: 'Private key present in the repository workspace',
    consequence: 'Anyone with repository access, including any past collaborator or a leaked clone, holds the key permanently. Rotation is the only remedy after exposure.',
    action: 'Remove the key, rotate the credential at the provider, and move it to environment configuration.',
  });

  // 2. Cloud provider access keys
  scanPattern({
    files, texts, id: 'SEC-2', severity: 'Critical',
    re: PROVIDER_CREDENTIAL_RE,
    gitMatcher: (match) => {
      const value = match[0];
      return (candidate) => candidate.includes(value);
    },
    gitExposedSeverity: (match) => /^(?:sk|rk)_test_/i.test(match[0]) ? 'High' : 'Critical',
    title: 'Provider credential found in source',
    consequence: 'A provider credential in source may allow unauthorised API access, disclose test or production data, and consume account resources.',
    action: 'Rotate the credential immediately, then remove it from the working tree and from git history.',
    filter: (_m, _text, file) => !basename(file).startsWith('.env'),
  });

  // 3. Environment files carrying secret-like values
  let envHits = 0;
  for (const { abs, rel: r } of relFiles) {
    if (envHits >= MAX_PER_RULE) break;
    if (!basename(r).startsWith('.env')) continue;
    if (basename(r).includes('example') || basename(r).includes('sample')) continue;
    const text = texts.get(abs);
    if (!text) continue;
    const m = findEnvSecret(text);
    if (!m) continue;
    add({
      id: 'SEC-3', severity: 'Critical',
      title: 'Environment file contains a secret-like value',
      file: abs, line: lineOf(text, m.index), excerpt: redact(excerptAt(text, m.index)),
      consequence: 'Every secret in this file is disclosed to anyone who can read the repository, and it stays in git history after deletion.',
      action: 'Delete the file from the tree, add it to .gitignore, rotate every value, and purge it from history.',
      gitMatcher: (candidate) => candidate.split('\n').some((line) => {
        const assignment = envAssignment(line);
        return assignment?.key === m.key && assignment.value === m.value;
      }),
    });
    envHits++;
  }

  // 4. Secrets exposed through public build-time prefixes
  scanPattern({
    files, texts, id: 'SEC-4', severity: 'Critical',
    re: /\b(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP|PUBLIC)_[A-Z0-9_]*(?:SECRET(?:_KEY)?|SERVICE_ROLE(?:_KEY)?|PRIVATE_KEY|PASSWORD)\b/,
    title: 'Secret exposed through a public environment prefix',
    consequence: 'Variables with a public prefix are compiled into the browser bundle. This value is readable by every visitor with developer tools open.',
    action: 'Move the value to a server-only variable and access it from a server route or action.',
    filter: (_m, _text, file) => {
      const name = basename(file).toLowerCase();
      return !(name.startsWith('.env') && /(?:example|sample|template)/.test(name));
    },
    prodOnly: true, root,
  });

  // 5. Supabase service role key reachable from client code
  scanPattern({
    files, texts, id: 'SEC-5', severity: 'Critical',
    re: /SUPABASE_SERVICE_ROLE(_KEY)?|service_role/,
    title: 'Supabase service role key referenced in client-reachable code',
    consequence: 'The service role key bypasses row level security entirely. In a client bundle it grants any visitor full read and write access to every table.',
    action: 'Restrict the service role key to server routes, and use the anon key with row level security from the client.',
    filter: (match, text, file) => isClientReachable(rel(file), text)
      && Boolean(stripComments(text).slice(match.index, match.index + match[0].length).trim()),
    prodOnly: true, root,
  });

  // 6. Tables created without row level security
  const tableCreations = new Map();
  const rlsEnabled = new Set();
  for (const { abs, rel: r } of productionFiles) {
    if (extname(r) !== '.sql') continue;
    const text = texts.get(abs);
    if (!text) continue;
    for (const match of text.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:["`]?(\w+)["`]?\s*\.\s*)?["`]?(\w+)["`]?/gi)) {
      const schema = match[1]?.toLowerCase();
      if (schema && schema !== 'public') continue;
      const key = match[2].toLowerCase();
      if (!tableCreations.has(key)) tableCreations.set(key, { name: match[2], abs, index: match.index });
    }
    for (const match of text.matchAll(/alter\s+table\s+(?:["`]?(\w+)["`]?\s*\.\s*)?["`]?(\w+)["`]?\s+(enable|disable)\s+row\s+level\s+security/gi)) {
      const schema = match[1]?.toLowerCase();
      if (schema && schema !== 'public') continue;
      const table = match[2].toLowerCase();
      if (match[3].toLowerCase() === 'enable') rlsEnabled.add(table);
      else rlsEnabled.delete(table);
    }
  }

  const missingRls = [...tableCreations.entries()].filter(([name]) => !rlsEnabled.has(name));
  if (missingRls.length) {
    const [, first] = missingRls[0];
    const text = texts.get(first.abs) || '';
    const names = missingRls.slice(0, 6).map(([, item]) => item.name);
    // The severity of missing RLS depends entirely on whether the database is
    // reachable by an untrusted client. With Supabase the anon key hits Postgres
    // directly, so no RLS is full exposure. Behind a server-only ORM it is
    // defence in depth rather than proof of direct exposure.
    add(usesDirectClientPostgres ? {
      id: 'DATA-1', severity: 'Critical',
      title: `Tables created without row level security: ${names.join(', ')}`,
      file: first.abs, line: lineOf(text, first.index), excerpt: redact(excerptAt(text, first.index)),
      consequence: 'Client-reachable database code was detected. With row level security disabled, an untrusted client may be able to read or write rows outside its account.',
      action: 'Enable row level security on each table and add explicit policies for select, insert, update, and delete.',
    } : {
      id: 'DATA-1', severity: 'Medium',
      title: `Tables created without row level security: ${names.join(', ')}`,
      file: first.abs, line: lineOf(text, first.index), excerpt: redact(excerptAt(text, first.index)),
      consequence: 'No production client-reachable database SDK usage was detected. Missing row level security is therefore defence in depth rather than proof of direct exposure, and becomes critical if a client is later given direct access.',
      action: 'Enable row level security before exposing the database to any client, and keep all access behind server routes until then.',
    });
  }

  // 7. Policies that are effectively public
  scanPattern({
    files, texts, ext: ['.sql'], id: 'DATA-2', severity: 'Critical',
    re: /create\s+policy[\s\S]{0,240}?using\s*\(\s*true\s*\)/i,
    title: 'Row level security policy evaluates to true for everyone',
    consequence: 'A policy of USING (true) satisfies row level security while granting universal access. The protection appears enabled and is not.',
    action: 'Scope the policy to the authenticated owner, for example USING (auth.uid() = user_id).',
    prodOnly: true, root,
  });

  // 8. Route handlers with no authorisation check
  {
    let hits = 0;
    for (const { abs, rel: r } of relFiles) {
      if (hits >= MAX_PER_RULE) break;
      if (!isApiHandlerPath(r)) continue;
      if (!['.ts', '.js', '.tsx', '.jsx'].includes(extname(r))) continue;
      if (isNonProduction(r) || isPublicByDesign(r)) continue;
      const text = texts.get(abs);
      if (!text) continue;
      const code = stripCommentsAndStrings(text);
      const handlers = exportedMutatingHandlerMatches(code);
      for (let i = 0; i < handlers.length; i++) {
        const m = handlers[i];
        const next = handlers[i + 1]?.index ?? code.length;
        const [start, end] = handlerBounds(code, m, next);
        const handlerCode = code.slice(start, end);
        // Guard names count only when called inside this handler. An import or a
        // protected sibling method is not evidence that the current method is safe.
        if (/\b(?:getServerSession|auth|getUser|verifyToken|currentUser|withApiAuth|isAuthenticated|getSession|getAuth)\w*\s*\(/i.test(handlerCode)) continue;
        if (/\b(require|assert|ensure|check|verify)\w*(User|Session|Auth|Authenticated|Staff|Admin|Member|Owner|Actor|Account|Tenant|Workspace|Permission|Role|Access|Identity|Login)\w*\s*\(/.test(handlerCode)) continue;
        if (/\b(authorize|authorise|protectRoute|withAuth|guard)\w*\s*\(/i.test(handlerCode)) continue;
        if (/\b(is|has|can)(Authorized|Authorised|Authed|Admin|Staff|Access|Permission|Permitted|Owner)\w*\s*[({]/i.test(handlerCode)) continue;
        if (/status:\s*(401|403)\b|\.status\(\s*(401|403)\s*\)|\b(401|403)\s*\)|['"](Unauthorized|Unauthorised|Forbidden)['"]/i.test(handlerCode)) continue;
        add({
          id: 'AUTH-1', severity: 'Critical',
          title: 'Mutating API route has no recognised authentication guard',
          file: abs, line: lineOf(text, m.index), excerpt: redact(excerptAt(text, m.index)),
          consequence: 'No recognised authentication guard was found. If the route is reachable without another platform-level control, an unauthenticated caller may be able to change data directly.',
          action: 'Confirm the effective access control, then resolve the session at the top of the handler, reject when absent, and verify the caller owns the affected record.',
        });
        hits++;
        break;
      }
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
      const m = requestHandlerMatch(text);
      if (!m) continue;
      const code = stripCommentsAndStrings(text);
      const [start, end] = handlerBounds(code, m);
      const handlerCode = code.slice(start, end);
      const verification = verifierCallMatch(handlerCode);
      const sideEffect = /\b(?:fulfil|fulfill|credit|grant|insert|update|upsert|send)\w*\s*\(/i.exec(handlerCode);
      if (verification && (!sideEffect || verification.index <= sideEffect.index)) continue;
      add({
        id: 'PAY-1', severity: 'Critical',
        title: 'Webhook endpoint has no recognised signature verification',
        file: abs, line: lineOf(text, m.index), excerpt: redact(excerptAt(text, m.index)),
        consequence: 'No recognised verifier call was found before side effects. If no external gateway verifies the request, anyone who learns the URL may be able to post a forged event.',
        action: 'Verify the provider signature against the raw request body before any handling, reject on failure, and keep the verifier call visible in this handler.',
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
      const mi = requestHandlerMatch(text);
      if (!mi) continue;
      const structuralCode = stripCommentsAndStrings(text);
      const [start, end] = handlerBounds(structuralCode, mi);
      const handlerCode = stripComments(text).slice(start, end);
      if (hasIdempotencyGuard(handlerCode)) continue;
      add({
        id: 'PAY-2', severity: 'High',
        title: 'Webhook handler has no recognised idempotency guard',
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
        const hasDeployableRuntime = /(^|\s)(next|nuxt|react|react-dom|vue|svelte|@sveltejs\/kit|expo|react-native|express|fastify|hono|koa|@nestjs\/core|@angular\/core)(\s|$)/i.test(names);
        const hasPublicRequestSurface = productionFiles.some(({ abs, rel: r }) =>
          isApiHandlerPath(r) && Boolean(requestHandlerMatch(texts.get(abs) || '')))
          || /(^|\s)(express|fastify|hono|koa|@nestjs\/core)(\s|$)/i.test(names);

        if (hasDeployableRuntime && !/sentry|bugsnag|rollbar|datadog|logtail|highlight|posthog|honeybadger/i.test(names)) {
          add({
            id: 'OPS-2', severity: 'High',
            title: 'No recognised error-monitoring package detected',
            file: pkgPath, line: 1, excerpt: 'dependencies: no monitoring package found',
            consequence: 'No common monitoring integration was found in this deployable application. Confirm whether the platform supplies equivalent coverage; otherwise production failures may only surface through user reports.',
            action: 'Confirm platform-level monitoring or add an error reporting service, then verify that a deliberate test error reaches the dashboard before launch.',
          });
        }
        if (hasPublicRequestSurface && !/(ratelimit|rate-limit|upstash|bottleneck|express-rate-limit|limiter)/i.test(names)) {
          add({
            id: 'OPS-3', severity: 'Medium',
            title: 'No recognised rate-limiting package detected for request handlers',
            file: pkgPath, line: 1, excerpt: 'dependencies: no rate limiting package found',
            consequence: 'No common rate-limiting integration was found. Confirm whether an API gateway or platform supplies equivalent protection, especially for authentication and paid model routes.',
            action: 'Confirm the external control or apply a per-identifier rate limit to authentication, contact, and model-backed routes.',
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
      const config = stripComments(raw);
      const explicitlyFalse = /"strict"\s*:\s*false/.test(config);
      const explicitlyTrue = /"strict"\s*:\s*true/.test(config);
      const mayInherit = /"extends"\s*:/.test(config);
      if (explicitlyFalse || (!explicitlyTrue && !mayInherit)) {
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
    const expoConfig = ['app.json', 'app.config.js', 'app.config.ts'].find((name) => existsSync(join(root, name)));
    let isExpo = false;
    try {
      const pkg = JSON.parse(readSafe(join(root, 'package.json')) || '{}');
      isExpo = Boolean(pkg.dependencies?.expo || pkg.devDependencies?.expo);
    } catch { /* invalid package.json is outside this rule */ }
    if (isExpo && expoConfig && !existsSync(join(root, 'eas.json'))) {
      add({
        id: 'REL-1', severity: 'High',
        title: 'Expo project without a build configuration',
        file: join(root, expoConfig), line: 1, excerpt: 'eas.json not present',
        consequence: 'There is no reproducible path to a signed build. Release becomes a manual sequence that works once and cannot be repeated under deadline.',
        action: 'Add eas.json with development, preview, and production profiles, and produce one signed build before committing to a launch date.',
      });
    }
  }

  // Ground every secret finding in what git actually contains. Severity and
  // wording both depend on it, and a gitignored file is not a breach.
  for (const f of findings) {
    if (!['SEC-1', 'SEC-2', 'SEC-3'].includes(f.id)) continue;
    const e = git.exposure(rel(f.file), f.gitMatcher, f.id);
    const exposureConfirmed = e.severity === 'Critical';
    f.severity = exposureConfirmed ? (f.gitExposedSeverity || 'Critical') : 'Medium';
    f.consequence = `A value matching this rule is ${e.state}. ${
      exposureConfirmed
        ? 'Anyone with the affected commit or clone may retain it after deletion. Treat it as exposed until the provider confirms rotation or revocation.'
        : 'The scanner did not verify distribution through reachable git history, so this is a local hygiene and near-miss finding rather than a confirmed repository disclosure.'
    }`;
    f.action = exposureConfirmed
      ? 'Rotate or revoke the credential at the provider first, then remove it from the tree and purge the affected history where appropriate.'
      : 'Keep the file ignored, remove the value from the working tree or index, and rotate it if the machine or any backup has been shared.';
    delete f.gitMatcher;
    delete f.gitExposedSeverity;
  }
}

// ---------------------------------------------------------------------------
// Optional dependency audit
// ---------------------------------------------------------------------------

function dependencyAuditFinding(data, pkgPath) {
  const v = data?.metadata?.vulnerabilities;
  if (!v) return null;
  const bad = (v.critical || 0) + (v.high || 0);
  if (bad === 0) return null;
  return {
    id: 'DEP-1', severity: 'High',
    title: `${bad} high or critical dependency vulnerabilities`,
    file: pkgPath, line: 1,
    excerpt: `critical: ${v.critical || 0}, high: ${v.high || 0}, moderate: ${v.moderate || 0}`,
    consequence: 'Known vulnerable dependency versions are present in the lockfile. Their practical exploitability still depends on how the affected packages are used.',
    action: 'Review npm audit details, upgrade or replace affected packages, and document any deliberately accepted risk.',
  };
}

function dependencyAuditFailureDetail(data) {
  return data?.error
    ? 'npm audit returned an error response without vulnerability metadata'
    : 'npm audit did not return vulnerability metadata';
}

function runAudit(root) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return { status: 'not-applicable', detail: 'package.json not present' };
  if (!existsSync(join(root, 'package-lock.json')) && !existsSync(join(root, 'npm-shrinkwrap.json'))) {
    return { status: 'failed', detail: 'npm audit requires package-lock.json or npm-shrinkwrap.json' };
  }
  let out;
  try {
    out = execFileSync('npm', ['audit', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
  } catch (e) {
    out = e.stdout || '';
  }
  if (!out) return { status: 'failed', detail: 'npm audit produced no JSON output' };
  let data;
  try { data = JSON.parse(out); } catch { return { status: 'failed', detail: 'npm audit returned malformed JSON' }; }
  if (!data.metadata?.vulnerabilities) {
    return { status: 'failed', detail: dependencyAuditFailureDetail(data) };
  }
  const finding = dependencyAuditFinding(data, pkgPath);
  if (finding) add(finding);
  return { status: 'completed', detail: finding ? finding.title : 'no high or critical vulnerabilities reported' };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const ORDER = { Critical: 0, High: 1, Medium: 2 };

function sortFindings(root, input) {
  const rel = (f) => relative(root, f).replace(/\\/g, '/');
  return [...input].sort((a, b) =>
    ORDER[a.severity] - ORDER[b.severity]
    || a.id.localeCompare(b.id)
    || rel(a.file).localeCompare(rel(b.file))
    || a.line - b.line);
}

function countFindings(input) {
  return input.reduce((acc, f) => (acc[f.severity] = (acc[f.severity] || 0) + 1, acc), {});
}

function safeMetadata(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function markdownCell(value) {
  return String(value).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/`/g, "'");
}

function auditSummary(audit) {
  if (audit.status === 'not-requested') return 'Not requested';
  if (audit.status === 'completed') return `Completed: ${audit.detail}`;
  if (audit.status === 'not-applicable') return `Not applicable: ${audit.detail}`;
  return `Failed: ${audit.detail}`;
}

function coverageSummary(coverage, fileCount) {
  return coverage.status === 'complete'
    ? `Complete: ${fileCount} supported files read`
    : `Partial: ${coverage.skippedCount} supported path${coverage.skippedCount === 1 ? '' : 's'} skipped`;
}

function buildReport({ client, product, preparedBy, reviewDate, root, findings, fileCount, audit, coverage }) {
  const sorted = sortFindings(root, findings);
  const counts = countFindings(sorted);
  const rel = (f) => relative(root, f).replace(/\\/g, '/');

  const critical = counts.Critical || 0;
  const high = counts.High || 0;
  const recommendation = critical > 0
    ? 'Repair and verify the critical findings before the affected journey is launched.'
    : high > 0
      ? 'Review and repair the high findings before making the launch decision.'
      : 'No critical or high pattern was detected. Continue with human verification; this scan is not launch approval.';

  const rows = sorted.length
    ? sorted.map((f) =>
        `| ${f.severity} | **${markdownCell(f.title)}**<br>\`${markdownCell(rel(f.file))}:${f.line}\`<br>\`${markdownCell(f.excerpt)}\` | ${markdownCell(f.consequence)} | ${markdownCell(f.action)} |`
      ).join('\n')
    : '| | No pattern matched in the inspected surface | | |';

  const skippedRows = coverage.skipped.map(({ file, reason }) => `- \`${markdownCell(file)}\`: ${markdownCell(reason)}`);
  if (coverage.skippedCount > coverage.skipped.length) {
    skippedRows.push(`- ${coverage.skippedCount - coverage.skipped.length} additional skipped paths omitted from this report`);
  }
  const coverageDetails = coverage.status === 'complete'
    ? 'Every discovered file within the supported collection boundary was read.'
    : `This scan is incomplete and exits with code 2. Review or split the skipped paths, then rerun before relying on the result.\n\n${skippedRows.join('\n')}`;

  return `# Launch Triage report

Client: ${safeMetadata(client)}
Product: ${safeMetadata(product)}
Review date: ${reviewDate}
Prepared by: ${safeMetadata(preparedBy)}
Generated with: Launch Triage v${VERSION}
Dependency audit: ${safeMetadata(auditSummary(audit))}
Coverage: ${safeMetadata(coverageSummary(coverage, fileCount))}

## Automated triage

Automated static review of ${fileCount} supported source files found ${critical} critical, ${high} high, and ${counts.Medium || 0} medium findings.

Recommended next action: ${recommendation}

Human confirmation is required before sharing this report or making a launch decision.

## Findings

| Severity | Finding and evidence | Production consequence | Recommended action |
| --- | --- | --- | --- |
${rows}

## Human verification checklist

- [ ] Open every flagged file and confirm the matched pattern is a real defect.
- [ ] Reproduce the highest-severity failure in the affected user journey.
- [ ] Record the owner, target date, and acceptance test for each confirmed finding.
- [ ] Remove false positives before sharing the report with a client or team.

## Evidence boundary

### File coverage

${coverageDetails}

### Analysis boundary

This report records static patterns found in the inspected files. It is not a
penetration test, legal certification, third-party approval, or guarantee about
surfaces outside the repository.

Automated static analysis covered ${fileCount} files. It does not execute the
product, test authenticated flows by hand, or inspect infrastructure,
third-party dashboards, or anything outside this repository.
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { _: [] };
  const valueOptions = new Map([
    ['--out', 'out'],
    ['--client', 'client'],
    ['--product', 'product'],
    ['--prepared-by', 'preparedBy'],
    ['--date', 'date'],
    ['--fail-on', 'failOn'],
  ]);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      args._.push(...argv.slice(i + 1));
      break;
    }
    if (token === '-h' || token === '--help') { args.help = true; continue; }
    if (token === '-v' || token === '--version') { args.version = true; continue; }
    if (token === '--audit') { args.audit = true; continue; }
    if (token === '--json') { args.json = true; continue; }
    if (token === '--annotate') { args.annotate = true; continue; }
    if (token === '--no-annotate') { args.noAnnotate = true; continue; }

    if (token.startsWith('--')) {
      const equal = token.indexOf('=');
      const flag = equal === -1 ? token : token.slice(0, equal);
      const key = valueOptions.get(flag);
      if (!key) throw new UsageError(`Unknown option: ${flag}`);
      const value = equal === -1 ? argv[++i] : token.slice(equal + 1);
      if (!value || (equal === -1 && value.startsWith('-'))) {
        throw new UsageError(`${flag} requires a value`);
      }
      args[key] = value;
      continue;
    }

    if (token.startsWith('-')) throw new UsageError(`Unknown option: ${token}`);
    args._.push(token);
  }

  if (args._.length > 1) throw new UsageError('Provide exactly one repository path');
  if (args.failOn) {
    args.failOn = args.failOn.toLowerCase();
    if (!['critical', 'high', 'medium', 'none'].includes(args.failOn)) {
      throw new UsageError('--fail-on must be critical, high, medium, or none');
    }
  }
  if (args.annotate && args.noAnnotate) {
    throw new UsageError('Use either --annotate or --no-annotate, not both');
  }
  if (args.date && !isValidDate(args.date)) throw new UsageError('--date must be a real date in YYYY-MM-DD format');
  return args;
}

function jsonOutputPath(outPath) {
  return /\.md$/i.test(outPath) ? outPath.replace(/\.md$/i, '.json') : `${outPath}.json`;
}

function jsonReport({ root, product, client, preparedBy, reviewDate, fileCount, audit, coverage, findings: input }) {
  const sorted = sortFindings(root, input);
  const counts = countFindings(sorted);
  return {
    schemaVersion: 1,
    tool: { name: PACKAGE.name, version: VERSION },
    reviewDate,
    target: basename(root),
    product,
    client,
    preparedBy,
    fileCount,
    coverage,
    counts: {
      critical: counts.Critical || 0,
      high: counts.High || 0,
      medium: counts.Medium || 0,
    },
    audit,
    findings: sorted.map((finding) => ({
      ...finding,
      file: relative(root, finding.file).replace(/\\/g, '/'),
    })),
  };
}

function thresholdMet(input, threshold) {
  if (!threshold || threshold === 'none') return false;
  const target = ORDER[threshold[0].toUpperCase() + threshold.slice(1)];
  return input.some((finding) => ORDER[finding.severity] <= target);
}

function annotate(input, root) {
  const escape = (value) => String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  for (const finding of sortFindings(root, input)) {
    const level = finding.severity === 'Medium' ? 'warning' : 'error';
    const file = relative(root, finding.file).replace(/\\/g, '/');
    const message = escape(`${finding.title}. ${finding.consequence} Fix: ${finding.action}`);
    const title = escape(`${finding.id} ${finding.severity}`);
    console.log(`::${level} file=${file},line=${finding.line},title=${title}::${message}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  if (args.version) { console.log(VERSION); return 0; }

  const target = args._[0];
  if (!target) throw new UsageError('A repository path is required');
  const root = resolve(target);
  if (!existsSync(root)) throw new UsageError(`Path not found: ${root}`);
  if (!statSync(root).isDirectory()) throw new UsageError(`Target must be a directory: ${root}`);

  const collected = collect(root);
  const files = collected.files;
  const skipped = [...collected.skipped];
  let skippedCount = collected.skippedCount;
  const texts = new Map();
  for (const file of files) {
    const text = readSafe(file);
    if (text !== null) {
      texts.set(file, text);
    } else {
      skippedCount++;
      if (skipped.length < MAX_REPORTED_SKIPS) {
        skipped.push({ file: relative(root, file).replace(/\\/g, '/'), reason: 'file contents could not be read' });
      }
    }
  }
  if (texts.size === 0) throw new UsageError('No supported source files were found in the target directory');
  const coverage = { status: skippedCount ? 'partial' : 'complete', skippedCount, skipped };

  findings.length = 0;
  runRules(root, files, texts);
  const audit = args.audit ? runAudit(root) : { status: 'not-requested', detail: 'run with --audit to request npm audit' };

  const reviewDate = args.date || localDate();
  const client = args.client || 'Not specified';
  const product = args.product || basename(root);
  const preparedBy = args.preparedBy || 'Not specified';
  const report = buildReport({ client, product, preparedBy, reviewDate, root, findings, fileCount: texts.size, audit, coverage });

  const outPath = resolve(args.out || join(process.cwd(), 'output', `triage-${basename(root)}-${reviewDate}.md`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, report, 'utf8');

  let jsonPath = null;
  if (args.json) {
    jsonPath = jsonOutputPath(outPath);
    const payload = jsonReport({ root, product, client, preparedBy, reviewDate, fileCount: texts.size, audit, coverage, findings });
    writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  const counts = countFindings(findings);
  console.log(`Scanned ${texts.size} files in ${root}`);
  console.log(`Critical: ${counts.Critical || 0}  High: ${counts.High || 0}  Medium: ${counts.Medium || 0}`);
  console.log(`Coverage: ${coverageSummary(coverage, texts.size)}`);
  console.log(`Report: ${outPath}`);
  if (jsonPath) console.log(`JSON: ${jsonPath}`);
  if (audit.status === 'failed') console.error(`Audit failed: ${audit.detail}`);
  if (coverage.status === 'partial') console.error('Coverage incomplete: review skipped paths in the report before relying on this scan.');
  if (!findings.length) console.log(`No patterns matched${coverage.status === 'partial' ? ' in the files that were read' : ''}. Human verification is still required.`);

  const inActions = process.env.GITHUB_ACTIONS === 'true';
  if (findings.length && (args.annotate || (inActions && !args.noAnnotate))) {
    annotate(findings, root);
  }
  if (inActions && process.env.GITHUB_STEP_SUMMARY) {
    try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`); } catch { /* non-fatal */ }
  }

  if (audit.status === 'failed' || coverage.status === 'partial') return 2;
  return thresholdMet(findings, args.failOn) ? 1 : 0;
}

let entryPath = null;
if (process.argv[1]) {
  try { entryPath = realpathSync(process.argv[1]); } catch { entryPath = resolve(process.argv[1]); }
}
const isMain = entryPath && import.meta.url === pathToFileURL(entryPath).href;
if (isMain) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    if (error instanceof UsageError) console.error('Run with --help for usage.');
    process.exitCode = 2;
  }
}

export { dependencyAuditFailureDetail, dependencyAuditFinding, jsonOutputPath, main, redact };
