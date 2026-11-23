#!/usr/bin/env node
/**
 * Deterministic Drift-Healer CLI (`npx cortex heal`).
 *
 * Capabilities:
 *   1. Parses Playwright failure artifacts (`test-results/<run>/error-context.md`, `playwright-report/results.json`)
 *      or explicit `--spec` / `--error` inputs alongside `.agent-browser/page-*.yml` (or legacy `.playwright-cli/`) snapshots.
 *   2. Classifies failures into Auth Drift, Genuine App Regression (never weakening `expect()`),
 *      or UI/Locator Drift.
 *   3. Scores YAML snapshot candidates against the broken locator & Component property.
 *   4. With `--apply`, writes `defects/DEFECT-*.md` for regressions or safely patches high-confidence
 *      (or `--to`-specified) Component locators & Session Tapes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCompactMode } from './lib/cli-output.mjs';
import { getFileImpact } from './impact-graph.mjs';
import { runFastVerify } from './verify-fast.mjs';

const MAX_FILE_BYTES = 1024 * 1024;
const HIGH_CONFIDENCE_THRESHOLD = 0.65;

function isWithinDir(targetPath, baseDir) {
  const rel = path.relative(baseDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readTextSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function walkFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git'].includes(entry.name)) continue;
      out.push(...walkFiles(full, predicate));
    } else if (predicate(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

function tokenize(raw) {
  return String(raw || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !['get', 'by', 'role', 'name', 'exact', 'true', 'false', 'locator', 'page', 'root', 'this'].includes(t));
}

function slugifyKebab(raw) {
  return String(raw || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'defect';
}

function escapeSingleQuote(val) {
  return String(val || '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const ALLOWED_LOCATOR_METHODS = new Set([
  'getByRole',
  'getByTestId',
  'getByLabel',
  'getByPlaceholder',
  'getByText',
  'getByAltText',
  'getByTitle',
  'locator',
  'frameLocator',
  'first',
  'last',
  'nth',
  'filter',
]);

const ALLOWED_ROOT_LOCATOR_METHODS = new Set([
  'getByRole',
  'getByTestId',
  'getByLabel',
  'getByPlaceholder',
  'getByText',
  'getByAltText',
  'getByTitle',
  'locator',
  'frameLocator',
]);

const ALLOWED_LOCATOR_OPTION_KEYS = new Set([
  'name',
  'exact',
  'checked',
  'disabled',
  'expanded',
  'includeHidden',
  'level',
  'pressed',
  'selected',
  'hasText',
  'hasNotText',
]);

/**
 * Strict recursive-descent validator for Playwright locator expressions.
 * Permits ONLY chained calls to allowlisted Playwright locator methods whose arguments
 * are strictly literals (string, regex, boolean, integer) or flat options objects with
 * allowlisted Playwright keys. Rejects arbitrary JS calls, IIFEs, arrow functions,
 * member accesses, and template literals.
 */
export function assertSafePlaywrightLocatorExpr(rawExpr) {
  const expr = String(rawExpr || '').trim();
  if (!expr || expr.length > 512 || /[\r\n\u2028\u2029\u202A-\u202E\u2066-\u2069`\x00-\x1f\x7f]/.test(expr)) {
    throw new Error(
      `Security Error: Unsafe Playwright locator expression '${rawExpr}'. Must be a single-line semantic locator call.`
    );
  }

  const stripped = expr.replace(/^(?:page|this\.root)\./, '');
  let pos = 0;

  const fail = (reason) => {
    throw new Error(`Security Error: Unsafe Playwright locator expression '${rawExpr}' (${reason}).`);
  };

  const skipWs = () => {
    while (pos < stripped.length && (stripped[pos] === ' ' || stripped[pos] === '\t')) pos++;
  };

  const parseIdentifier = () => {
    skipWs();
    const start = pos;
    if (pos < stripped.length && /[A-Za-z_]/.test(stripped[pos])) {
      pos++;
      while (pos < stripped.length && /[A-Za-z0-9_]/.test(stripped[pos])) pos++;
      return stripped.slice(start, pos);
    }
    return '';
  };

  const parseStringLiteral = () => {
    const quote = stripped[pos];
    if (quote !== "'" && quote !== '"') fail('expected string literal');
    pos++;
    while (pos < stripped.length) {
      const ch = stripped[pos++];
      if (ch === '\\') {
        if (pos >= stripped.length) fail('unterminated escape');
        pos++;
        continue;
      }
      if (ch === quote) return;
    }
    fail('unterminated string literal');
  };

  const parseRegexLiteral = () => {
    if (stripped[pos] !== '/') fail('expected regex literal');
    pos++;
    let inCharClass = false;
    let bodyLen = 0;
    while (pos < stripped.length) {
      const ch = stripped[pos++];
      if (ch === '\\') {
        if (pos >= stripped.length) fail('unterminated regex escape');
        pos++;
        bodyLen += 2;
        continue;
      }
      if (ch === '[') inCharClass = true;
      else if (ch === ']') inCharClass = false;
      else if (ch === '/' && !inCharClass) {
        if (bodyLen === 0) fail('empty regex literal');
        while (pos < stripped.length && /[gimsuy]/.test(stripped[pos])) pos++;
        return;
      }
      bodyLen++;
    }
    fail('unterminated regex literal');
  };

  const parsePrimitiveValue = () => {
    skipWs();
    if (pos >= stripped.length) fail('unexpected end of argument');
    const ch = stripped[pos];
    if (ch === "'" || ch === '"') {
      parseStringLiteral();
      return;
    }
    if (ch === '/') {
      parseRegexLiteral();
      return;
    }
    if (stripped.startsWith('true', pos) && !/[A-Za-z0-9_$]/.test(stripped[pos + 4] || '')) {
      pos += 4;
      return;
    }
    if (stripped.startsWith('false', pos) && !/[A-Za-z0-9_$]/.test(stripped[pos + 5] || '')) {
      pos += 5;
      return;
    }
    const numMatch = stripped.slice(pos).match(/^-?\d+(?![A-Za-z0-9_$.])/);
    if (numMatch) {
      pos += numMatch[0].length;
      return;
    }
    fail(`disallowed non-literal token near '${stripped.slice(pos, pos + 20)}'`);
  };

  const parseOptionsObject = () => {
    if (stripped[pos] !== '{') fail('expected object literal');
    pos++;
    skipWs();
    if (stripped[pos] === '}') {
      pos++;
      return;
    }
    let count = 0;
    while (pos < stripped.length) {
      skipWs();
      const key = parseIdentifier();
      if (!key || !ALLOWED_LOCATOR_OPTION_KEYS.has(key)) {
        fail(`disallowed option key '${key || stripped.slice(pos, pos + 12)}'`);
      }
      skipWs();
      if (stripped[pos] !== ':') fail(`expected ':' after option '${key}'`);
      pos++;
      parsePrimitiveValue();
      count++;
      if (count > 12) fail('too many options in locator object');
      skipWs();
      if (stripped[pos] === ',') {
        pos++;
        skipWs();
        if (stripped[pos] === '}') {
          pos++;
          return;
        }
        continue;
      }
      if (stripped[pos] === '}') {
        pos++;
        return;
      }
      fail('expected "," or "}" in locator options');
    }
    fail('unterminated options object');
  };

  const parseCallArgs = (methodName) => {
    skipWs();
    if (stripped[pos] !== '(') fail(`expected '(' after ${methodName}`);
    pos++;
    skipWs();
    if (stripped[pos] === ')') {
      if (methodName !== 'first' && methodName !== 'last') {
        fail(`${methodName}() requires at least one literal argument`);
      }
      pos++;
      return;
    }
    let argCount = 0;
    while (pos < stripped.length) {
      skipWs();
      if (stripped[pos] === '{') {
        parseOptionsObject();
      } else {
        parsePrimitiveValue();
      }
      argCount++;
      if (argCount > 2) fail(`too many arguments to ${methodName}()`);
      skipWs();
      if (stripped[pos] === ',') {
        pos++;
        continue;
      }
      if (stripped[pos] === ')') {
        pos++;
        return;
      }
      fail(`unexpected token '${stripped.slice(pos, pos + 12)}' in ${methodName}() arguments`);
    }
    fail(`unterminated argument list for ${methodName}()`);
  };

  const rootMethod = parseIdentifier();
  if (!ALLOWED_ROOT_LOCATOR_METHODS.has(rootMethod)) {
    fail(`disallowed root method '${rootMethod}'`);
  }
  parseCallArgs(rootMethod);

  let chainDepth = 0;
  while (pos < stripped.length) {
    skipWs();
    if (pos >= stripped.length) break;
    if (stripped[pos] !== '.') {
      fail(`unexpected trailing token '${stripped.slice(pos)}'`);
    }
    pos++;
    const nextMethod = parseIdentifier();
    if (!ALLOWED_LOCATOR_METHODS.has(nextMethod)) {
      fail(`disallowed chained method '${nextMethod}'`);
    }
    parseCallArgs(nextMethod);
    chainDepth++;
    if (chainDepth > 8) fail('locator chain exceeds maximum depth');
  }

  return stripped;
}

export function sanitizeDefectErrorExcerpt(rawText) {
  return String(rawText || '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(
      /\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      '[REDACTED_JWT]'
    )
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_PAT]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED_GCP_KEY]')
    .replace(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\bnpm_[A-Za-z0-9]{36}\b/g, '[REDACTED_NPM_TOKEN]')
    .replace(/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, '[REDACTED_SENDGRID_KEY]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(
      /\b(https?:\/\/|postgres(?:ql)?:\/\/|mysql:\/\/|mongodb(?:\+srv)?:\/\/|redis(?:s)?:\/\/)[^/\s:@'"`]+:[^/\s@'"`]+@/gi,
      '$1[REDACTED_CREDENTIALS]@'
    )
    .replace(
      /\b(password|passcode|pin|otp|cvv|cvc|ssn|secret|client[_-]?secret|private[_-]?key|access[_-]?key|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token)\s*([:=])\s*(['"`])([^'"`\n]{4,})\3/gi,
      '$1$2$3[REDACTED]$3'
    );
}

/**
 * Parse `@playwright/cli` YAML snapshot lines into structured accessible nodes.
 */
export function parsePlaywrightSnapshotYaml(yamlText) {
  const nodes = [];
  const lines = String(yamlText || '').split('\n');
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith('- ')) continue;

    // Example: - button "Sign In" [ref=e14]
    // Example: - textbox "Email Address" [ref=e12]
    // Example: - link "Order History" [ref=e5]
    const match = trimmed.match(/^-\s+([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?(.*)$/);
    if (!match) continue;

    const role = match[1].toLowerCase();
    const name = (match[2] || '').trim();
    const attrs = match[3] || '';
    const refMatch = attrs.match(/\bref=([^,\]]+)/);
    const testIdMatch = attrs.match(/\[data-test(?:id)?=["']?([^\]"']+)["']?\]/);

    if (!name && !testIdMatch) continue;
    nodes.push({
      role,
      name,
      ref: refMatch ? refMatch[1] : null,
      testId: testIdMatch ? testIdMatch[1] : null,
      rawLine: trimmed,
    });
  }
  return nodes;
}

/**
 * Extract failing locator expression from Playwright error text.
 */
function extractSemanticCallsBalanced(text) {
  const calls = [];
  const startRe = /getBy(?:Role|TestId|Label|Placeholder|Text|AltText|Title)\(/g;
  let m;
  while ((m = startRe.exec(text)) !== null) {
    let i = m.index + m[0].length;
    let depth = 1;
    let quote = null;
    let inRegex = false;
    let inCharClass = false;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
      } else if (inRegex) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '[') inCharClass = true;
        else if (ch === ']') inCharClass = false;
        else if (ch === '/' && !inCharClass) inRegex = false;
      } else if (ch === '\'' || ch === '"' || ch === '`') {
        quote = ch;
      } else if (ch === '/' && text[i + 1] !== '/' && text[i + 1] !== '*') {
        inRegex = true;
        inCharClass = false;
      } else if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        depth--;
      }
      i++;
    }
    if (depth === 0) {
      calls.push(text.slice(m.index, i).trim());
    }
  }
  return calls;
}

export function extractFailingLocatorFromError(errorText) {
  const text = String(errorText || '');
  // 1. Prefer the full chained expression on `waiting for ...` and extract its leaf semantic locator (e.g. `locator('body').getByRole(...)`)
  const waitingLine = text.match(/waiting for ([^\n]+)/i);
  if (waitingLine) {
    const chain = waitingLine[1].trim();
    const semanticCalls = extractSemanticCallsBalanced(chain);
    if (semanticCalls.length > 0) {
      return semanticCalls[semanticCalls.length - 1];
    }
    const singleLoc = chain.match(/^locator\(['"`]([^'"`]+)['"`]\)/i);
    if (singleLoc) return singleLoc[1].trim();
    return chain;
  }
  const locLine = text.match(/Locator:\s*([^\n]+)/i);
  if (locLine) {
    const lineCalls = extractSemanticCallsBalanced(locLine[1]);
    return lineCalls.length > 0 ? lineCalls[lineCalls.length - 1] : locLine[1].trim();
  }
  const fallbackCalls = extractSemanticCallsBalanced(text);
  if (fallbackCalls.length > 0) {
    return fallbackCalls[fallbackCalls.length - 1];
  }
  return '';
}

/**
 * Discover Playwright failure artifacts under `test-results/`.
 */
export function parseErrorContextArtifacts(projectRoot) {
  const testResultsDir = path.join(projectRoot, 'test-results');
  const errorFiles = walkFiles(testResultsDir, (name) => name === 'error-context.md');
  const artifacts = [];

  for (const file of errorFiles) {
    const content = readTextSafe(file);
    if (!content) continue;
    const specMatch = content.match(/(?:Test|Spec|File):\s*([^\n]+)/i);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs || 0;
    } catch {
      /* ignore */
    }
    artifacts.push({
      file: path.relative(projectRoot, file).replace(/\\/g, '/'),
      specPath: specMatch ? specMatch[1].trim() : null,
      errorText: content,
      failingLocator: extractFailingLocatorFromError(content),
      mtimeMs,
    });
  }
  artifacts.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  return artifacts;
}

/**
 * Classify root cause using the 8-way differential matrix.
 */
export function classifyFailureRootCause({
  errorText = '',
  consoleErrors = [],
  httpStatuses = [],
  snapshotUrl = '',
  specPath = '',
}) {
  const err = String(errorText || '');
  const has401or403 =
    /(?:HTTP|status|statusCode|responded with)\s*:?\s*(?:401|403)\b|\b(?:unauthorized|forbidden)\b/i.test(err) ||
    httpStatuses.some((s) => s === 401 || s === 403);
  const redirectedToLogin =
    /\/(?:login|signin|sso)\b/i.test(snapshotUrl) && !/login|auth/i.test(String(specPath || ''));

  if (has401or403 || redirectedToLogin) {
    return {
      category: 'auth-drift',
      caseId: 4,
      summary: 'Expired or rejected .auth/<persona>.json session (401/403 or redirect to login).',
      neverWeakenAssertions: true,
    };
  }

  const has5xx =
    /(?:HTTP|status|statusCode|responded with)\s*:?\s*5\d{2}\b/i.test(err) ||
    httpStatuses.some((s) => s >= 500 && s < 600);
  const isMissingLocatorExpect =
    (/Received:\s*(?:<element\(s\) not found>|hidden)/i.test(err) ||
      /\bexpect\(locator\)\.(?:toBeVisible|toBeEnabled|toBeAttached|toBeChecked)\b/i.test(err)) &&
    /waiting for /i.test(err);
  const isAssertionMismatch =
    (/\b(?:Expected|Received):/i.test(err) ||
      /-\s*Expected\s+(?:substring|string|pattern|value)/i.test(err) ||
      /\bexpect\(locator\)\.(?:toContainText|toHaveText|toHaveValue|toHaveURL)\b.*failed/i.test(err)) &&
    !/TimeoutError.*waiting for/i.test(err) &&
    !isMissingLocatorExpect;

  if (has5xx || consoleErrors.length > 0 || isAssertionMismatch) {
    return {
      category: 'app-regression',
      caseId: has5xx ? 6 : consoleErrors.length > 0 && !isAssertionMismatch ? 5 : 7,
      summary: has5xx
        ? 'First-party 5xx API/server error detected during test execution.'
        : consoleErrors.length > 0 && !isAssertionMismatch
          ? 'Uncaught runtime JS/console error detected during test execution.'
          : 'Assertion value mismatch (business logic or state regression) — preserve strict expect().',
      neverWeakenAssertions: true,
    };
  }

  return {
    category: 'locator-drift',
    caseId: 1,
    summary: 'UI / Locator drift detected (TimeoutError / missing selector with clean console & API).',
    neverWeakenAssertions: true,
  };
}

function nodeToPlaywrightExpr(node) {
  if (node.testId) {
    return {
      expr: `getByTestId('${escapeSingleQuote(node.testId)}')`,
      locatorContract: { strategy: 'getByTestId', value: node.testId, nameExact: true },
    };
  }
  const semanticRoles = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'heading',
    'tab',
    'menuitem',
  ]);
  if (semanticRoles.has(node.role) && node.name) {
    return {
      expr: `getByRole('${node.role}', { name: '${escapeSingleQuote(node.name)}', exact: true })`,
      locatorContract: {
        strategy: 'getByRole',
        role: node.role,
        value: node.name,
        nameExact: true,
      },
    };
  }
  return {
    expr: `getByText('${escapeSingleQuote(node.name)}', { exact: true })`,
    locatorContract: { strategy: 'getByText', value: node.name, nameExact: true },
  };
}

/**
 * Score YAML snapshot nodes against the failing locator and Component property name.
 */
export function scoreSnapshotCandidates(failingLocator, propertyName, snapshotNodes) {
  const queryTokens = new Set([
    ...tokenize(failingLocator),
    ...tokenize(propertyName),
  ]);
  const roleHintMatch = String(failingLocator || '').match(/getByRole\(['"]([a-z]+)['"]/i);
  const roleHint = roleHintMatch
    ? roleHintMatch[1].toLowerCase()
    : /btn|button|submit|save|cancel/i.test(propertyName)
      ? 'button'
      : /input|field|textbox/i.test(propertyName)
        ? 'textbox'
        : /link|nav/i.test(propertyName)
          ? 'link'
          : null;

  const scored = [];
  for (const node of snapshotNodes) {
    const nodeTokens = new Set([...tokenize(node.name), ...tokenize(node.testId || '')]);
    let overlap = 0;
    for (const t of queryTokens) {
      if (nodeTokens.has(t)) overlap++;
      else {
        for (const nt of nodeTokens) {
          if (nt.includes(t) || t.includes(nt)) {
            overlap += 0.6;
            break;
          }
        }
      }
    }

    const tokenScore = queryTokens.size > 0 ? Math.min(1, overlap / Math.max(1, Math.min(queryTokens.size, nodeTokens.size || 1))) : 0;
    const roleScore = roleHint && node.role === roleHint ? 0.35 : roleHint ? 0 : 0.15;
    const confidence = Number(Math.min(0.99, tokenScore * 0.65 + roleScore).toFixed(2));
    const { expr, locatorContract } = nodeToPlaywrightExpr(node);

    scored.push({
      node,
      confidence,
      suggestedExpr: expr,
      suggestedLocatorContract: locatorContract,
    });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  return scored;
}

function findMatchingComponentProperty(projectRoot, failingLocator, specPath) {
  const componentFiles = [
    ...walkFiles(path.join(projectRoot, 'src/components'), (n) => n.endsWith('.component.ts') || n.endsWith('.step.ts')),
    ...walkFiles(path.join(projectRoot, 'src/steps'), (n) => n.endsWith('.step.ts')),
    ...walkFiles(path.join(projectRoot, 'src/shared/components'), (n) => n.endsWith('.component.ts') || n.endsWith('.ts')),
    ...walkFiles(path.join(projectRoot, 'src/domains'), (n) => n.endsWith('.component.ts') || n.endsWith('.step.ts')),
  ];

  const locTokens = tokenize(failingLocator);
  for (const file of componentFiles) {
    const content = readTextSafe(file);
    if (!content) continue;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*this\.([a-zA-Z0-9_]+)\s*=\s*(this\.root\.|page\.)(.+);\s*$/);
      if (!m) continue;
      const propName = m[1];
      const basePrefix = m[2];
      const rhs = m[3];
      const exactMatch = failingLocator && rhs.includes(failingLocator);
      const tokenMatch =
        locTokens.length > 0 &&
        locTokens.every((t) => rhs.toLowerCase().includes(t) || propName.toLowerCase().includes(t));

      if (exactMatch || tokenMatch) {
        const frameMatch = rhs.match(/^(frameLocator\([^)]*\)\.)/);
        const prefix = frameMatch ? `${basePrefix}${frameMatch[1]}` : basePrefix;
        return {
          filePath: file,
          relPath: path.relative(projectRoot, file).replace(/\\/g, '/'),
          propertyName: propName,
          lineIndex: i,
          currentExpr: rhs,
          prefix,
        };
      }
    }
  }
  return null;
}

function findMatchingTape(projectRoot, specPath, failingLocator) {
  const tapesDir = path.join(projectRoot, '.exploratory/tapes');
  const tapeFiles = walkFiles(tapesDir, (n) => n.endsWith('.json'));
  const specBase = specPath ? path.basename(specPath, '.spec.ts') : '';

  for (const file of tapeFiles) {
    const raw = readTextSafe(file);
    if (!raw) continue;
    try {
      const tape = JSON.parse(raw);
      if (specBase && tape.scenarioId === specBase) {
        return { filePath: file, relPath: path.relative(projectRoot, file).replace(/\\/g, '/'), tape };
      }
      const locTokens = tokenize(failingLocator);
      if (
        locTokens.length > 0 &&
        Array.isArray(tape.semanticSteps) &&
        tape.semanticSteps.some((s) =>
          locTokens.every((t) => JSON.stringify(s.locatorContract || {}).toLowerCase().includes(t))
        )
      ) {
        return { filePath: file, relPath: path.relative(projectRoot, file).replace(/\\/g, '/'), tape };
      }
    } catch {
      /* skip malformed tape */
    }
  }
  return null;
}

function assertNoSymlinkEscape(rootDir, targetPath, label = 'path') {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (!isWithinDir(resolvedTarget, resolvedRoot)) {
    throw new Error(`Security Error: Path traversal detected for ${label}: '${targetPath}'.`);
  }
  let cur = resolvedTarget;
  while (cur !== resolvedRoot) {
    if (fs.existsSync(cur) && fs.lstatSync(cur).isSymbolicLink()) {
      throw new Error(
        `Security Error: Refusing symlinked path for ${label}: '${path.relative(resolvedRoot, cur)}'.`
      );
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (fs.existsSync(resolvedRoot)) {
    const realRoot = fs.realpathSync(resolvedRoot);
    let existing = resolvedTarget;
    while (!fs.existsSync(existing) && existing !== resolvedRoot) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const realExisting = fs.realpathSync(existing);
    const realRel = path.relative(realRoot, realExisting);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`Security Error: Realpath escapes workspace root for ${label}.`);
    }
  }
  return resolvedTarget;
}

function findLatestSnapshot(projectRoot, explicitSnapshot) {
  if (explicitSnapshot) {
    const resolved = path.resolve(projectRoot, explicitSnapshot);
    if (!isWithinDir(resolved, projectRoot) || !fs.existsSync(resolved)) return null;
    try {
      assertNoSymlinkEscape(projectRoot, resolved, 'snapshot file');
      return resolved;
    } catch {
      return null;
    }
  }
  const candidates = [];
  for (const dirName of ['.agent-browser', '.playwright-cli']) {
    const dirPath = path.join(projectRoot, dirName);
    candidates.push(...walkFiles(dirPath, (n) => n.endsWith('.yml') || n.endsWith('.yaml') || n.endsWith('.txt')));
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

/**
 * Analyze a failing test / artifact and optionally apply safe healing or defect logging.
 */
export function analyzeAndHealDrift(projectRoot, options = {}) {
  if (options.to !== undefined && options.to !== null) {
    assertSafePlaywrightLocatorExpr(options.to);
  }
  const artifacts = parseErrorContextArtifacts(projectRoot);
  let activeArtifact = artifacts[0] || {};
  if (options.spec) {
    const normSpec = String(options.spec).replace(/\\/g, '/').toLowerCase();
    const specBase = path.basename(normSpec, '.spec.ts');
    activeArtifact =
      artifacts.find((a) => {
        const aSpec = String(a.specPath || '').replace(/\\/g, '/').toLowerCase();
        const aFile = String(a.file || '').replace(/\\/g, '/').toLowerCase();
        return (
          (aSpec && (aSpec.includes(normSpec) || normSpec.includes(aSpec))) ||
          aFile.includes(specBase)
        );
      }) || {};
  }
  const errorText = options.error || activeArtifact.errorText || '';
  const specPath = options.spec || activeArtifact.specPath || '';
  const failingLocator = options.locator || extractFailingLocatorFromError(errorText) || activeArtifact.failingLocator || '';

  const snapshotFile = findLatestSnapshot(projectRoot, options.snapshot);
  let snapshotText = snapshotFile ? readTextSafe(snapshotFile) : '';
  if (!snapshotText && errorText) {
    const embeddedYaml = errorText.match(/# Page snapshot[\s\S]*?```yaml\r?\n([\s\S]*?)```/i);
    if (embeddedYaml) {
      snapshotText = embeddedYaml[1];
    }
  }
  const snapshotNodes = parsePlaywrightSnapshotYaml(snapshotText);

  const rootCause = classifyFailureRootCause({
    errorText,
    consoleErrors: options.consoleErrors || [],
    httpStatuses: options.httpStatuses || [],
    snapshotUrl: options.snapshotUrl || '',
    specPath,
  });

  const componentMatch = findMatchingComponentProperty(projectRoot, failingLocator, specPath);
  const tapeMatch = findMatchingTape(projectRoot, specPath, failingLocator);
  const blastRadius = componentMatch
    ? getFileImpact(projectRoot, componentMatch.relPath, {
        sharedThreshold: options.sharedThreshold,
      })
    : null;

  const candidates =
    rootCause.category === 'locator-drift'
      ? scoreSnapshotCandidates(failingLocator, componentMatch?.propertyName || '', snapshotNodes)
      : [];

  const topCandidate = candidates[0] || null;
  const secondCandidate = candidates[1] || null;
  const hasClearWinner =
    topCandidate &&
    topCandidate.confidence >= HIGH_CONFIDENCE_THRESHOLD &&
    (!secondCandidate || topCandidate.confidence - secondCandidate.confidence >= 0.1);

  const result = {
    status: 'diagnosed',
    rootCause,
    specPath: specPath || null,
    failingLocator: failingLocator || null,
    snapshotUsed: snapshotFile ? path.relative(projectRoot, snapshotFile).replace(/\\/g, '/') : null,
    componentMatch: componentMatch
      ? { file: componentMatch.relPath, property: componentMatch.propertyName, currentExpr: componentMatch.currentExpr }
      : null,
    blastRadius,
    tapeMatch: tapeMatch ? { file: tapeMatch.relPath, scenarioId: tapeMatch.tape.scenarioId } : null,
    candidates: candidates.slice(0, 3).map((c) => ({
      role: c.node.role,
      name: c.node.name,
      confidence: c.confidence,
      suggestedExpr: c.suggestedExpr,
    })),
    autoHealReady: Boolean(options.to || (rootCause.category === 'locator-drift' && hasClearWinner)),
    appliedChanges: [],
    defectFile: null,
  };

  if (!options.apply) {
    return result;
  }

  // Apply phase
  if (rootCause.category === 'auth-drift') {
    result.status = 'auth-refresh-required';
    result.nextCommand = 'npx playwright test --project=setup';
    return result;
  }

  if (rootCause.category === 'app-regression') {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = slugifyKebab(specPath ? path.basename(specPath, '.spec.ts') : 'app-regression');
    const defectRel = `defects/DEFECT-${ts}-${slug}.md`;
    const defectFull = assertNoSymlinkEscape(projectRoot, path.join(projectRoot, defectRel), 'defect report');
    const safeExcerpt = sanitizeDefectErrorExcerpt(errorText.slice(0, 1200));
    fs.mkdirSync(path.dirname(defectFull), { recursive: true });
    fs.writeFileSync(
      defectFull,
      [
        `# Defect Report: ${slug}`,
        ``,
        `- **Detected By:** \`npx cortex heal\``,
        `- **Root Cause Category:** Case ${rootCause.caseId} (${rootCause.category})`,
        `- **Spec:** \`${specPath || 'unknown'}\``,
        `- **Summary:** ${rootCause.summary}`,
        ``,
        `## Error Excerpt`,
        `\`\`\``,
        safeExcerpt,
        `\`\`\``,
        ``,
        `## Guardrail Note`,
        `Strict \`expect()\` assertions in the spec were preserved (never weakened).`,
        ``,
      ].join('\n'),
      'utf8'
    );
    result.status = 'defect-logged';
    result.defectFile = defectRel;
    return result;
  }

  // Locator drift apply
  const replacementExpr = options.to || (hasClearWinner ? topCandidate.suggestedExpr : null);
  if (!replacementExpr) {
    result.status = 'needs-human-review';
    return result;
  }

  const cleanExpr = assertSafePlaywrightLocatorExpr(replacementExpr);

  // Blast-radius protection: refuse blind in-place mutation of high-fan-in / shared modules
  if (componentMatch && blastRadius?.isShared && !options.forceShared) {
    const specFlag = specPath ? ` --spec ${specPath}` : '';
    result.status = 'blocked-shared-blast-radius';
    result.nextCommands = [
      `npx cortex heal${specFlag} --apply --verify-affected`,
      `npx cortex heal${specFlag} --apply --force-shared`,
    ];
    return result;
  }

  if (componentMatch) {
    assertNoSymlinkEscape(projectRoot, componentMatch.filePath, 'component file');
    const compLines = fs.readFileSync(componentMatch.filePath, 'utf8').split('\n');
    compLines[componentMatch.lineIndex] = `    this.${componentMatch.propertyName} = ${componentMatch.prefix}${cleanExpr};`;
    fs.writeFileSync(componentMatch.filePath, compLines.join('\n'), 'utf8');
    result.appliedChanges.push(componentMatch.relPath);
  }

  if (tapeMatch && topCandidate && !options.to) {
    assertNoSymlinkEscape(projectRoot, tapeMatch.filePath, 'Session Tape');
    const locTokens = tokenize(failingLocator);
    const updated = { ...tapeMatch.tape };
    let patchedStep = false;
    if (Array.isArray(updated.semanticSteps)) {
      updated.semanticSteps = updated.semanticSteps.map((step) => {
        if (
          !patchedStep &&
          locTokens.length > 0 &&
          locTokens.every((t) => JSON.stringify(step.locatorContract || {}).toLowerCase().includes(t))
        ) {
          patchedStep = true;
          const prevLoc = step.locatorContract || {};
          return {
            ...step,
            locatorContract: {
              ...(prevLoc.parentScope ? { parentScope: prevLoc.parentScope } : {}),
              ...(prevLoc.iframeSelector ? { iframeSelector: prevLoc.iframeSelector } : {}),
              ...(prevLoc.portalScope ? { portalScope: prevLoc.portalScope } : {}),
              ...(prevLoc.force !== undefined ? { force: prevLoc.force } : {}),
              ...topCandidate.suggestedLocatorContract,
            },
          };
        }
        return step;
      });
    }
    if (patchedStep) {
      fs.writeFileSync(tapeMatch.filePath, JSON.stringify(updated, null, 2) + '\n', 'utf8');
      result.appliedChanges.push(tapeMatch.relPath);
    }
  }

  result.status = result.appliedChanges.length > 0 ? 'healed' : 'needs-human-review';
  return result;
}

/**
 * Transactional drift healer with automatic rollback on knock-on regression.
 * When `apply && verifyAffected` is set, snapshots touched files before patching,
 * runs all affected specs (including @regression), and restores exact original
 * file contents if any affected spec fails.
 */
export async function healDriftWithGuardrail(projectRoot, options = {}) {
  if (!options.apply || !options.verifyAffected) {
    return analyzeAndHealDrift(projectRoot, options);
  }

  const dryRun = analyzeAndHealDrift(projectRoot, { ...options, apply: false });
  const backupFiles = new Map();
  const snapshotIfExists = (relPath) => {
    if (!relPath) return;
    const abs = path.resolve(projectRoot, relPath);
    if (isWithinDir(abs, projectRoot) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      backupFiles.set(abs, fs.readFileSync(abs, 'utf8'));
    }
  };

  if (dryRun.componentMatch?.file) snapshotIfExists(dryRun.componentMatch.file);
  if (dryRun.tapeMatch?.file) snapshotIfExists(dryRun.tapeMatch.file);

  const applied = analyzeAndHealDrift(projectRoot, {
    ...options,
    apply: true,
    forceShared: true,
  });

  if (applied.status !== 'healed' || applied.appliedChanges.length === 0) {
    return applied;
  }

  const affectedSpecs = new Set(applied.blastRadius?.affectedSpecs || []);
  if (applied.specPath && applied.specPath.endsWith('.spec.ts')) {
    affectedSpecs.add(applied.specPath.replace(/\\/g, '/').replace(/^\.\//, ''));
  }
  const targetSpecs = [...affectedSpecs].sort();

  let verifyRes;
  try {
    verifyRes =
      typeof options.verifyFn === 'function'
        ? await options.verifyFn({ rootDir: projectRoot, specs: targetSpecs, applied })
        : await runFastVerify({
            rootDir: projectRoot,
            fast: true,
            specs: targetSpecs,
            noAffected: true,
            quiet: true,
            compact: true,
          });
  } catch (err) {
    verifyRes = { ok: false, error: String(err?.message || err) };
  }

  if (!verifyRes?.ok) {
    for (const [absPath, originalContent] of backupFiles.entries()) {
      fs.writeFileSync(absPath, originalContent, 'utf8');
    }
    return {
      ...applied,
      status: 'rolled-back-regression',
      rolledBack: true,
      rolledBackFiles: [...applied.appliedChanges],
      appliedChanges: [],
      verifiedAffectedSpecs: targetSpecs,
      verification: verifyRes,
    };
  }

  return {
    ...applied,
    rolledBack: false,
    verifiedAffectedSpecs: targetSpecs,
    verification: verifyRes,
  };
}

export function formatCompactHealResult(res) {
  const cls = res.rootCause?.category || res.classification || 'unknown';
  const spec = res.specPath || res.spec || '';
  const lines = [
    `HEAL   | status=${res.status} | class=${cls}${spec ? ` | spec=${spec}` : ''}`,
  ];
  if (res.failingLocator) lines.push(`BROKEN | ${res.failingLocator}`);
  const compFile = res.componentMatch?.file || res.componentMatch?.relPath;
  if (compFile) {
    const prop = res.componentMatch.property || res.componentMatch.propertyName || '?';
    lines.push(`COMP   | ${compFile} (${prop})`);
  }
  if (res.blastRadius) {
    const br = res.blastRadius;
    lines.push(
      `BLAST  | fanIn=${br.fanIn} | risk=${br.riskTier}${br.isShared ? ' [SHARED]' : ''} | specs=${br.affectedSpecs.slice(0, 4).join(', ') || 'none'}${br.affectedSpecs.length > 4 ? ` (+${br.affectedSpecs.length - 4} more)` : ''}`
    );
  }
  const top = res.topCandidate || res.candidates?.[0];
  if (top) {
    lines.push(
      `TOP    | score=${top.confidence ?? top.score ?? '?'} | ${top.suggestedExpr || '?'}`
    );
  }
  if (Array.isArray(res.appliedChanges) && res.appliedChanges.length > 0) {
    lines.push(`PATCH  | ${res.appliedChanges.join(', ')}`);
  }
  if (res.rolledBack) {
    lines.push(`ROLLBK | Restored ${(res.rolledBackFiles || []).join(', ')} after regression in affected specs`);
  }
  if (Array.isArray(res.nextCommands) && res.nextCommands.length > 0) {
    lines.push(`NEXT   | ${res.nextCommands.join(' OR ')}`);
  }
  if (res.defectFile) lines.push(`DEFECT | ${res.defectFile}`);
  return lines.join('\n');
}

// CLI execution
const isMain =
  Boolean(process.argv[1]) &&
  (() => {
    try {
      return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
    } catch {
      return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
    }
  })();
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🩹 Cortex Drift-Healer CLI (npx cortex heal)

Usage:
  npx cortex heal [--spec <path>] [--error <msg>] [--snapshot <yml>] [--to <locator>] [--apply] [--verify-affected] [--force-shared] [--compact|--verbose|--json]
`);
    process.exit(0);
  }

  const getArg = (flag) => {
    const eqPrefix = `${flag}=`;
    const eqArg = args.find((a) => a.startsWith(eqPrefix));
    if (eqArg !== undefined) return eqArg.slice(eqPrefix.length) || undefined;
    const idx = args.indexOf(flag);
    return idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--') ? args[idx + 1] : undefined;
  };

  healDriftWithGuardrail(process.cwd(), {
    spec: getArg('--spec'),
    error: getArg('--error'),
    snapshot: getArg('--snapshot'),
    to: getArg('--to'),
    apply: args.includes('--apply'),
    verifyAffected: args.includes('--verify-affected'),
    forceShared: args.includes('--force-shared'),
  })
    .then((res) => {
      if (args.includes('--json')) {
        console.log(JSON.stringify(res, null, 2));
      } else if (isCompactMode(args)) {
        console.log(formatCompactHealResult(res));
      } else {
        console.log(`\n🩹 Cortex Drift-Healer (${res.status}):\n`);
        console.log(JSON.stringify(res, null, 2));
      }
      if (res.status === 'blocked-shared-blast-radius' || res.status === 'rolled-back-regression') {
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error(`❌ heal error: ${err.message}`);
      process.exit(1);
    });
}
