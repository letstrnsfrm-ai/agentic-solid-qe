#!/usr/bin/env node
/**
 * Deterministic Session-Tape-to-SOLID TypeScript Compiler & Scaffolder (`npx cortex compile`).
 *
 * Bridges `.exploratory/tapes/<scenario-id>.json` and the SOLID Playwright TypeScript suite:
 *   1. Inspects existing `src/` and `src/domains/<squad>/` symbols for reuse vs. missing gaps.
 *   2. Auto-routes between flat (`src/`, `tests/`) and 3-Tier Federated (`src/domains/<squad>/`, `tests/<squad>/`) layouts via `domain-graph.json`.
 *   3. Classifies UI Components (`IdentifiableComponent`, `ErrorBannerContract`, `WizardStepContract<T>`) & enforces the <= 150-line SRP cap.
 *   4. Synthesizes Backend API Clients (`ApiClientContract` + `AuthTokenBridge`), Typed Data Builders (DIP), Page Orchestrators, Fixtures (`test.extend`), and tagged `.spec.ts` files.
 *   5. Synchronizes `**Published Capabilities:**` in the matching Domain Shard so `npm run audit:solid` stays 100% green.
 *
 * Usage:
 *   npx cortex compile [<scenario-id-or-tape-path>] [--squad <squad>] [--apply] [--force-spec]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDomainGraph, seedShardsFromTapes } from './build-domain-graph.mjs';
import { buildSystemMap } from './build-system-map.mjs';
import { isCompactMode } from './lib/cli-output.mjs';
import {
  FORBIDDEN_IDENTIFIERS,
  isSafeClassName,
  isSafeMemberRef,
  validateTapeObject,
} from './validate-tapes.mjs';

let ROOT = process.cwd();
let TAPES_DIR = path.join(ROOT, '.exploratory/tapes');
const MAX_COMPONENT_LINES = 150;
const COMPONENT_WARN_LINES = 130;
const MAX_SCAN_FILE_BYTES = 1024 * 1024;

const ALLOWED_HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head']);
const JS_RESERVED_WORDS = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'let',
  'static',
  'implements',
  'interface',
  'package',
  'private',
  'protected',
  'public',
  'await',
  'eval',
  'arguments',
]);

function isSafeJsIdentifier(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !FORBIDDEN_IDENTIFIERS.has(name) &&
    !JS_RESERVED_WORDS.has(name)
  );
}

function assertSafeJsIdentifier(name, label = 'identifier') {
  if (!isSafeJsIdentifier(name)) {
    throw new Error(`Security Error: Unsafe or reserved JavaScript ${label} '${name}'.`);
  }
  return name;
}

function sanitizeCodeComment(rawText) {
  return String(rawText ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\*\//g, '* /')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
}

function walkFiles(dir, extFilter) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, extFilter));
    } else if (!extFilter || fullPath.endsWith(extFilter)) {
      try {
        const st = fs.lstatSync(fullPath);
        if (st.isFile() && st.size <= MAX_SCAN_FILE_BYTES) {
          files.push(fullPath);
        }
      } catch {
        /* ignore unreadable */
      }
    }
  }
  return files;
}

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function isWithinDir(targetPath, baseDir) {
  const relPath = path.relative(baseDir, targetPath);
  return relPath === '' || (!relPath.startsWith('..') && !path.isAbsolute(relPath));
}

function toKebabCase(str) {
  return String(str || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function toCamelCase(str) {
  const pascal = toPascalCase(str);
  return pascal ? pascal[0].toLowerCase() + pascal.slice(1) : '';
}

function toPascalCase(str) {
  return String(str || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

function stripClassSuffix(className, suffixes) {
  for (const suffix of suffixes) {
    if (className.endsWith(suffix) && className.length > suffix.length) {
      return className.slice(0, -suffix.length);
    }
  }
  return className;
}

/**
 * Parses a symbolic Data Builder reference such as:
 *   - "UserBuilder.standardUser"
 *   - "UserBuilder.standardUser().username"
 *   - "CheckoutBuilder.confirmationHeading()"
 */
function parseBuilderRef(refStr) {
  if (!refStr || typeof refStr !== 'string') return null;
  if (refStr.startsWith('capturedVariable:')) {
    const varName = refStr.slice('capturedVariable:'.length).trim();
    assertSafeJsIdentifier(varName, 'capturedVariable reference');
    return {
      isCapturedVar: true,
      varName,
    };
  }
  const clean = refStr.trim();
  if (!isSafeMemberRef(clean)) {
    throw new Error(`Security Error: Invalid Data Builder reference '${refStr}'.`);
  }
  const parts = clean.split('.');
  if (parts.length < 2) return null;
  const builderClass = assertSafeJsIdentifier(parts[0].replace(/\(\)$/, ''), 'builder class');
  const methodRaw = parts[1];
  const methodName = assertSafeJsIdentifier(methodRaw.replace(/\(\)$/, ''), 'builder method');
  const propChain = parts
    .slice(2)
    .map((p) => assertSafeJsIdentifier(p.replace(/\(\)$/, ''), 'builder property'));
  return {
    isCapturedVar: false,
    builderClass,
    methodName,
    propChain,
    topProperty: propChain[0] || null,
    callExpression:
      propChain.length > 0
        ? `${builderClass}.${methodName}().${propChain.join('.')}`
        : `${builderClass}.${methodName}()`,
  };
}

/**
 * Builds a Playwright locator expression string from a Session Tape locatorContract.
 */
function escapeRegexLiteral(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function buildLocatorExpression(locatorContract, rootExpr = 'this.root') {
  if (!locatorContract) return `${rootExpr}`;
  const effectiveRoot = locatorContract.iframeSelector
    ? `page.frameLocator(${JSON.stringify(String(locatorContract.iframeSelector))})`
    : locatorContract.portalScope
      ? 'page'
      : rootExpr;
  const strat = locatorContract.strategy;
  const rawVal = String(locatorContract.value ?? '');
  const val = JSON.stringify(rawVal);
  const exact = locatorContract.nameExact !== false;
  const nthSuffix = Number.isInteger(locatorContract.nth) ? `.nth(${locatorContract.nth})` : '';

  // #27: Disambiguate duplicate named elements using captured id or data-testid hint
  const hint = typeof locatorContract.hint === 'string' ? locatorContract.hint.trim() : '';
  if (hint) {
    const testIdHint = hint.match(/^testid:([A-Za-z0-9_.:-]+)$/i);
    if (testIdHint) {
      return `${effectiveRoot}.getByTestId(${JSON.stringify(testIdHint[1])})`;
    }
    const idHint = hint.match(/^id:([A-Za-z_][A-Za-z0-9_:-]*)$/i);
    const isDuplicateNamed = Boolean(rawVal.trim()) && (Number.isInteger(locatorContract.nth) || locatorContract.duplicate === true);
    if (idHint && isDuplicateNamed) {
      return `${effectiveRoot}.locator(${JSON.stringify(`#${idHint[1]}`)})`;
    }
  }

  // #32: Dynamic numeric badge counts like "🔖 Saved Quotes ( 4 )" -> regex without exact:true
  const badgeMatch = rawVal.match(/^(.*?)\(\s*\d+\s*\)\s*$/);
  // #39: All-caps labels (likely CSS text-transform: uppercase) -> case-insensitive anchored regex
  const isAllCaps =
    exact &&
    rawVal.length >= 2 &&
    /[A-Z]{2}/.test(rawVal) &&
    rawVal === rawVal.toUpperCase() &&
    !/[a-z]/.test(rawVal);

  const buildNameOption = () => {
    if (badgeMatch) {
      const prefix = badgeMatch[1].replace(/^[^\w]+/, '').trim();
      if (prefix) {
        return `{ name: /${escapeRegexLiteral(prefix)}\\s*\\(\\s*\\d+\\s*\\)/i }`;
      }
    }
    if (isAllCaps) {
      return `{ name: /^${escapeRegexLiteral(rawVal.trim())}$/i }`;
    }
    return `{ name: ${val}, exact: ${exact} }`;
  };

  if (strat === 'getByRole') {
    const role = JSON.stringify(String(locatorContract.role || 'button'));
    if (!rawVal.trim()) {
      return `${effectiveRoot}.getByRole(${role})${nthSuffix}`;
    }
    return `${effectiveRoot}.getByRole(${role}, ${buildNameOption()})${nthSuffix}`;
  }
  if (strat === 'getByLabel') {
    if (isAllCaps) {
      return `${effectiveRoot}.getByLabel(/^${escapeRegexLiteral(rawVal.trim())}$/i)${nthSuffix}`;
    }
    return `${effectiveRoot}.getByLabel(${val}, { exact: ${exact} })${nthSuffix}`;
  }
  if (strat === 'getByPlaceholder') {
    return `${effectiveRoot}.getByPlaceholder(${val}, { exact: ${exact} })${nthSuffix}`;
  }
  if (strat === 'getByText') {
    if (isAllCaps) {
      return `${effectiveRoot}.getByText(/^${escapeRegexLiteral(rawVal.trim())}$/i)${nthSuffix}`;
    }
    return `${effectiveRoot}.getByText(${val}, { exact: ${exact} })${nthSuffix}`;
  }
  if (strat === 'getByTestId') {
    return `${effectiveRoot}.getByTestId(${val})${nthSuffix}`;
  }
  return `${effectiveRoot}.locator(${val})${nthSuffix}`;
}

function buildRootLocatorExpression(parentScope) {
  if (!parentScope) {
    return `page.locator('body')`;
  }
  const strat = parentScope.strategy;
  const val = JSON.stringify(String(parentScope.value ?? ''));
  const exact = parentScope.nameExact !== false;
  if (strat === 'getByRole') {
    const role = JSON.stringify(String(parentScope.role || 'region'));
    return `page.getByRole(${role}, { name: ${val}, exact: ${exact} })`;
  }
  if (strat === 'getByLabel') {
    return `page.getByLabel(${val}, { exact: ${exact} })`;
  }
  if (strat === 'getByTestId') {
    return `page.getByTestId(${val})`;
  }
  return `page.locator(${val})`;
}

function ensureSafeLocatorPropName(candidateName, fallbackIndex = 1) {
  let cleaned = String(candidateName || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!cleaned || /^[0-9]/.test(cleaned)) {
    cleaned = `element${cleaned || fallbackIndex}`;
  }
  if (FORBIDDEN_IDENTIFIERS.has(cleaned) || JS_RESERVED_WORDS.has(cleaned)) {
    cleaned = `${cleaned}Element`;
  }
  return cleaned;
}

/**
 * Derives a clean camelCase Locator property name from a step's locatorContract & action.
 */
function deriveLocatorPropertyName(step) {
  const lc = step.locatorContract || {};
  if (lc.strategy === 'getByRole' && !String(lc.value || '').trim()) {
    const roleCamel = toCamelCase(lc.role || 'element') || 'element';
    const suffix = Number.isInteger(lc.nth) ? String(lc.nth + 1) : String(step.stepIndex);
    return ensureSafeLocatorPropName(`${roleCamel}${suffix}`, step.stepIndex);
  }
  const rawVal = String(lc.value || step.intent || `step${step.stepIndex}`)
    .replace(/^#/, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  const baseCamel = toCamelCase(rawVal) || `element${step.stepIndex}`;

  let prop;
  if (lc.strategy === 'getByRole') {
    const roleSuffix = toPascalCase(lc.role || 'Element');
    prop = baseCamel.toLowerCase().endsWith(roleSuffix.toLowerCase())
      ? baseCamel
      : `${baseCamel}${roleSuffix}`;
  } else if (lc.strategy === 'getByPlaceholder' || lc.strategy === 'getByLabel' || step.action === 'fill') {
    prop = baseCamel.toLowerCase().endsWith('input') ? baseCamel : `${baseCamel}Input`;
  } else if (step.action === 'selectOption') {
    prop = baseCamel.toLowerCase().endsWith('select') ? baseCamel : `${baseCamel}Select`;
  } else if (step.action === 'click' && !baseCamel.toLowerCase().endsWith('button') && !baseCamel.toLowerCase().endsWith('link')) {
    prop = `${baseCamel}Button`;
  } else {
    prop = baseCamel;
  }
  return ensureSafeLocatorPropName(prop, step.stepIndex);
}

/**
 * Scans all existing `.ts` files in `src/` to index exported classes, their file paths,
 * import aliases, line counts, and existing property/method identifiers.
 */
function scanExistingArchitecture() {
  const srcFiles = walkFiles(path.join(ROOT, 'src'), '.ts');
  const classIndex = new Map();

  for (const filePath of srcFiles) {
    const relPath = rel(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').length;
    const importAlias = toImportAlias(relPath);

    for (const m of content.matchAll(/\bexport\s+(?:class|interface)\s+([A-Za-z0-9_]+)/g)) {
      const className = m[1];
      const memberNames = new Set();
      for (const propMatch of content.matchAll(/^\s*(?:readonly\s+|async\s+|static\s+)*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:[:=(<])/gm)) {
        const name = propMatch[1];
        if (!['constructor', 'if', 'for', 'while', 'switch', 'return', 'export', 'import'].includes(name)) {
          memberNames.add(name);
        }
      }
      classIndex.set(className, {
        className,
        filePath,
        relPath,
        importAlias,
        lines,
        members: memberNames,
        content,
      });
    }
  }

  return classIndex;
}

function toImportAlias(relPath) {
  const withoutExt = relPath.replace(/\.ts$/, '');
  if (withoutExt.startsWith('src/contracts/')) return `@contracts/${withoutExt.slice('src/contracts/'.length)}`;
  if (withoutExt.startsWith('src/components/')) return `@components/${withoutExt.slice('src/components/'.length)}`;
  if (withoutExt.startsWith('src/pages/')) return `@pages/${withoutExt.slice('src/pages/'.length)}`;
  if (withoutExt.startsWith('src/flows/')) return `@flows/${withoutExt.slice('src/flows/'.length)}`;
  if (withoutExt.startsWith('src/fixtures/')) return `@fixtures/${withoutExt.slice('src/fixtures/'.length)}`;
  if (withoutExt.startsWith('src/data/')) return `@data/${withoutExt.slice('src/data/'.length)}`;
  if (withoutExt.startsWith('src/domains/')) return `@domains/${withoutExt.slice('src/domains/'.length)}`;
  if (withoutExt.startsWith('src/shared/')) return `@shared/${withoutExt.slice('src/shared/'.length)}`;
  if (withoutExt.startsWith('src/steps/')) return `@steps/${withoutExt.slice('src/steps/'.length)}`;
  if (withoutExt.startsWith('src/seeders/')) return `@seeders/${withoutExt.slice('src/seeders/'.length)}`;
  if (withoutExt.startsWith('src/api/')) return `@api/${withoutExt.slice('src/api/'.length)}`;
  if (withoutExt.startsWith('src/')) return `../${withoutExt.slice('src/'.length)}`;
  return `../${withoutExt}`;
}

function resolveTargetSquad(tape, cliSquad, domainGraph) {
  if (cliSquad) {
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(cliSquad) || cliSquad.includes('..')) {
      throw new Error(
        `Security Error: Invalid --squad '${cliSquad}'. Must be a kebab-case identifier ([a-z0-9-]) with no path traversal.`
      );
    }
    return cliSquad.toLowerCase();
  }
  const scenarioId = tape.scenarioId || '';
  for (const hub of domainGraph.domainHubs || []) {
    if (scenarioId.startsWith(`${hub.squad}-`)) {
      return hub.squad;
    }
    const matchesRoute = (tape.semanticSteps || []).some(
      (s) => typeof s.pageRoute === 'string' && s.pageRoute.startsWith(`/${hub.squad}`)
    );
    if (matchesRoute) {
      return hub.squad;
    }
  }
  for (const shard of domainGraph.shards || []) {
    if (shard.squad && shard.squad !== 'global') {
      if (shard.id === scenarioId || scenarioId.startsWith(`${shard.squad}-`)) {
        return shard.squad;
      }
    }
  }
  return null;
}

const SENSITIVE_BUILDER_PROP_REGEX =
  /(?:password|passcode|^pin$|user[_-]?pin|card[_-]?pin|security[_-]?pin|^otp$|[_-]otp|otp[_-]|cvv|cvc|^ssn$|[_-]ssn|secret|client[_-]?secret|private[_-]?key|access[_-]?key|api[_-]?key|auth[_-]?key|token)/i;

const REQUIRE_ENV_HELPER_CODE = `function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Missing required environment variable: \${name}. Set it in .env or CI secrets.\`);
  }
  return value;
}

`;

/**
 * A tape is "negative auth" when it was explored with the boundary-analysis charter
 * or recorded a 401/403 contract. Redacted passwords in such tapes were deliberately
 * invalid, so they must never resolve to the valid TEST_PASSWORD credential.
 */
export function isNegativeAuthTape(tape) {
  if (String(tape?.charter || '').toLowerCase() === 'boundary-analysis') return true;
  return (tape?.networkContracts || []).some((nc) => [401, 403].includes(Number(nc?.expectedStatus)));
}

export const INVALID_PASSWORD_EXPR = "process.env.TEST_INVALID_PASSWORD ?? 'invalid-test-credential'";

export function inferDefaultValueForProperty(propName, roleHint = 'standard', negativeAuth = false) {
  const lower = String(propName || '').toLowerCase();
  if (lower === 'role') return roleHint;
  if (lower.includes('username')) return 'standard_user';
  if (negativeAuth && lower.includes('password')) return { __envExpr: INVALID_PASSWORD_EXPR };
  if (SENSITIVE_BUILDER_PROP_REGEX.test(toKebabCase(propName).replace(/-/g, '_'))) {
    const envVar = lower.includes('password')
      ? 'TEST_PASSWORD'
      : `TEST_${toKebabCase(propName).replace(/-/g, '_').toUpperCase()}`;
    return { __envExpr: `requireEnv('${envVar}')` };
  }
  if (lower.includes('email')) return 'qe.user@example.com';
  if (lower.includes('firstname')) return 'Ada';
  if (lower.includes('lastname')) return 'Lovelace';
  if (lower.includes('postal') || lower.includes('postcode') || lower.includes('zip')) return '94107';
  if (lower.includes('date') || lower.includes('dob')) return '2026-01-15';
  if (lower.startsWith('has') || lower.startsWith('is') || lower.includes('required')) return true;
  if (lower.includes('count') || lower.includes('amount') || lower.includes('premium') || lower.includes('price')) {
    return '100.00';
  }
  return `sample_${toKebabCase(propName).replace(/-/g, '_')}`;
}

function serializeBuilderPropertyValue(val) {
  if (val && typeof val === 'object' && typeof val.__envExpr === 'string') {
    return val.__envExpr;
  }
  return JSON.stringify(val);
}

export function compileSessionTape({
  tapeInput,
  squadOverride = '',
  apply = false,
  forceSpec = false,
  emitSeeder = false,
  rootDir = process.cwd(),
  domainGraph: providedDomainGraph = null,
  deferGraphRefresh = false,
  skipMap = false,
} = {}) {
  const prevRoot = ROOT;
  const prevTapesDir = TAPES_DIR;
  ROOT = path.resolve(rootDir);
  TAPES_DIR = path.join(ROOT, '.exploratory/tapes');
  try {
  const domainGraph =
    providedDomainGraph || buildDomainGraph({ rootDir: ROOT, writeToDisk: !apply && !deferGraphRefresh });
  const existingClasses = scanExistingArchitecture();

  // 1. Resolve target Session Tape
  let tapePath = null;
  if (tapeInput) {
    const directCandidate = path.resolve(ROOT, tapeInput);
    const cleanId = String(tapeInput).replace(/\.json$/, '');
    const byIdCandidate = path.resolve(TAPES_DIR, `${cleanId}.json`);
    if (isWithinDir(directCandidate, ROOT) && fs.existsSync(directCandidate)) {
      tapePath = directCandidate;
    } else if (isWithinDir(byIdCandidate, TAPES_DIR) && fs.existsSync(byIdCandidate)) {
      tapePath = byIdCandidate;
    } else {
      throw new Error(`Session Tape not found for '${tapeInput}'. Expected file in .exploratory/tapes/<scenario-id>.json.`);
    }
  } else {
    // Auto-select first uncompiled tape (or first available tape if all compiled)
    const allTapeFiles = walkFiles(TAPES_DIR, '.json');
    if (allTapeFiles.length === 0) {
      throw new Error('No Session Tapes found in .exploratory/tapes/. Run /01-cli-explorer first.');
    }
    const specFiles = walkFiles(path.join(ROOT, 'tests'), '.spec.ts');
    const specContents = specFiles.map((f) => fs.readFileSync(f, 'utf8'));
    const uncompiled = allTapeFiles.find((tf) => {
      const id = path.basename(tf, '.json');
      const idRe = new RegExp(`(?<![a-z0-9-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`);
      return !specContents.some((sc) => idRe.test(sc));
    });
    tapePath = uncompiled || allTapeFiles[0];
  }

  const tapeStat = fs.lstatSync(tapePath);
  if (tapeStat.isSymbolicLink() || !tapeStat.isFile() || tapeStat.size > MAX_SCAN_FILE_BYTES) {
    throw new Error(`Security Error: Refusing to compile symbolic link or oversized Session Tape: ${rel(tapePath)}`);
  }

  const tape = JSON.parse(fs.readFileSync(tapePath, 'utf8'));
  const validationErrors = validateTapeObject(tape, path.basename(tapePath), {
    expectedScenarioId: path.basename(tapePath, '.json'),
  });
  if (validationErrors.length > 0) {
    throw new Error(
      `Session Tape failed schema & security validation:\n  - ${validationErrors.join('\n  - ')}`
    );
  }

  const scenarioId = tape.scenarioId;
  const resolvedSquad = resolveTargetSquad(tape, squadOverride, domainGraph);

  const baseSrcDir = resolvedSquad ? `src/domains/${resolvedSquad}` : 'src';
  const baseTestDir = resolvedSquad ? `tests/${resolvedSquad}` : 'tests';
  const fixtureRelPath = resolvedSquad
    ? `src/domains/${resolvedSquad}/fixtures/${resolvedSquad}.fixture.ts`
    : 'src/fixtures/app.fixture.ts';

  const plannedOperations = [];
  const warnings = [];
  const publishedCapabilities = new Set();

  // 2. Analyze Data Builder Requirements (DIP)
  const builderRequirements = new Map(); // BuilderClass -> Map(methodName -> Map(propName -> sampleVal))
  const negativeAuth = isNegativeAuthTape(tape);
  function registerBuilderRef(refStr, roleHint = 'standard') {
    const parsed = parseBuilderRef(refStr);
    if (!parsed || parsed.isCapturedVar) return;
    if (!builderRequirements.has(parsed.builderClass)) {
      builderRequirements.set(parsed.builderClass, new Map());
    }
    const methodMap = builderRequirements.get(parsed.builderClass);
    if (!methodMap.has(parsed.methodName)) {
      methodMap.set(parsed.methodName, new Map());
    }
    const propMap = methodMap.get(parsed.methodName);
    if (parsed.topProperty) {
      if (!propMap.has(parsed.topProperty)) {
        propMap.set(parsed.topProperty, inferDefaultValueForProperty(parsed.topProperty, roleHint, negativeAuth));
      }
    }
  }

  if (tape.persona?.dataBuilderRef) {
    registerBuilderRef(tape.persona.dataBuilderRef, tape.persona.role || 'standard');
    registerBuilderRef(`${tape.persona.dataBuilderRef}.role`, tape.persona.role || 'standard');
  }
  for (const actor of tape.actors || []) {
    if (actor.dataBuilderRef) {
      registerBuilderRef(actor.dataBuilderRef, actor.role || 'standard');
      registerBuilderRef(`${actor.dataBuilderRef}.role`, actor.role || 'standard');
    }
  }
  for (const step of tape.semanticSteps || []) {
    if (step.inputDataRef) registerBuilderRef(step.inputDataRef);
    if (step.conditionRef) registerBuilderRef(step.conditionRef);
    if (step.locatorContract?.parentScope?.filterTextRef) {
      registerBuilderRef(step.locatorContract.parentScope.filterTextRef);
    }
  }
  for (const nc of tape.networkContracts || []) {
    if (nc.requestBuilderRef) registerBuilderRef(nc.requestBuilderRef);
  }
  for (const state of tape.expectedStates || []) {
    const isLiteralUrlPath =
      state.assertionType === 'toHaveURL' &&
      typeof state.expectedValueRef === 'string' &&
      state.expectedValueRef.startsWith('/');
    if (state.expectedValueRef && state.assertionType !== 'toHaveStatus' && !isLiteralUrlPath) {
      registerBuilderRef(state.expectedValueRef);
    }
  }

  const builderImports = new Map(); // BuilderClass -> importAlias
  for (const [builderClass, methodMap] of builderRequirements.entries()) {
    assertSafeJsIdentifier(builderClass, 'Data Builder class');
    publishedCapabilities.add(builderClass);
    const existing = existingClasses.get(builderClass);
    if (existing) {
      builderImports.set(builderClass, existing.importAlias);
      const missingMethods = [...methodMap.keys()].filter((m) => !existing.members.has(m));
      let baseBuilderContent = existing.content;
      const addedProps = [];

      // Also inject any missing properties into already-existing static builder methods
      for (const [mName, props] of methodMap.entries()) {
        if (!existing.members.has(mName) || !props || props.size === 0) continue;
        const methodRegex = new RegExp(
          `(static\\s+${mName}\\s*\\([^)]*\\)[^{]*\\{\\s*return\\s*\\{)([\\s\\S]*?)(\\n\\s*\\};)`
        );
        const mm = baseBuilderContent.match(methodRegex);
        if (mm) {
          const missingPropLines = [...props.entries()]
            .filter(([k]) => !new RegExp(`\\b${k}\\s*:`).test(mm[2]))
            .map(([k, v]) => {
              addedProps.push(`${mName}.${k}`);
              return `      ${assertSafeJsIdentifier(k, 'Data Builder property')}: ${serializeBuilderPropertyValue(v)},`;
            });
          if (missingPropLines.length > 0) {
            const sep = mm[2].trimEnd().endsWith(',') || mm[2].trim() === '' ? '' : ',';
            const propBlock = missingPropLines.join('\n');
            baseBuilderContent = baseBuilderContent.replace(
              methodRegex,
              (_, m1, m2, m3) => `${m1}${m2}${sep}\n${propBlock}${m3}`
            );
          }
        }
      }

      if (missingMethods.length > 0 || addedProps.length > 0) {
        const injectedMethodsCode = missingMethods
          .map((mName) => {
            assertSafeJsIdentifier(mName, 'Data Builder method');
            const props = methodMap.get(mName);
            if (!props || props.size === 0) {
              return `  static ${mName}(): Record<string, string> {\n    return { role: 'standard' };\n  }`;
            }
            const propLines = [...props.entries()]
              .map(([k, v]) => `      ${assertSafeJsIdentifier(k, 'Data Builder property')}: ${serializeBuilderPropertyValue(v)},`)
              .join('\n');
            return `  static ${mName}() {\n    return {\n${propLines}\n    };\n  }`;
          })
          .join('\n\n');

        if (
          (baseBuilderContent.includes('requireEnv(') || injectedMethodsCode.includes('requireEnv(')) &&
          !/\bfunction\s+requireEnv\b/.test(baseBuilderContent)
        ) {
          baseBuilderContent = `${REQUIRE_ENV_HELPER_CODE}${baseBuilderContent}`;
        }
        const updatedContent = injectedMethodsCode
          ? baseBuilderContent.replace(/\}\s*$/, () => `\n${injectedMethodsCode}\n}\n`)
          : baseBuilderContent;
        plannedOperations.push({
          layer: 'data-builder',
          action: 'extend-existing',
          className: builderClass,
          file: existing.relPath,
          addedMembers: [...missingMethods, ...addedProps],
          codeContent: updatedContent,
        });
      } else {
        plannedOperations.push({
          layer: 'data-builder',
          action: 'reuse-existing',
          className: builderClass,
          file: existing.relPath,
          addedMembers: [],
        });
      }
    } else {
      const kebabStem = toKebabCase(stripClassSuffix(builderClass, ['Builder']));
      const targetRel = `${baseSrcDir}/data/${kebabStem}.builder.ts`;
      const importAlias = toImportAlias(targetRel);
      builderImports.set(builderClass, importAlias);

      const methodsCode = [...methodMap.entries()]
        .map(([mName, props]) => {
          assertSafeJsIdentifier(mName, 'Data Builder method');
          if (!props || props.size === 0) {
            return `  static ${mName}() {\n    return {\n      role: 'standard',\n    };\n  }`;
          }
          const propLines = [...props.entries()]
            .map(([k, v]) => `      ${assertSafeJsIdentifier(k, 'Data Builder property')}: ${serializeBuilderPropertyValue(v)},`)
            .join('\n');
          return `  static ${mName}() {\n    return {\n${propLines}\n    };\n  }`;
        })
        .join('\n\n');

      const needsRequireEnv = methodsCode.includes('requireEnv(');
      const codeContent = `${needsRequireEnv ? REQUIRE_ENV_HELPER_CODE : ''}/**
 * Typed Data Builder (DIP) synthesized from Session Tape '${sanitizeCodeComment(scenarioId)}'.
 */
export class ${builderClass} {
${methodsCode}
}
`;
      plannedOperations.push({
        layer: 'data-builder',
        action: 'create',
        className: builderClass,
        file: targetRel,
        addedMembers: [...methodMap.keys()],
        codeContent,
      });
    }
  }

  // 3. Analyze Backend API Clients (`ApiClientContract` + `AuthTokenBridge`)
  const apiClientCandidates = new Map(); // ClientClass -> { endpoints: [] }
  for (const step of tape.semanticSteps || []) {
    if (step.action === 'apiCall' && step.componentCandidate) {
      if (!apiClientCandidates.has(step.componentCandidate)) {
        apiClientCandidates.set(step.componentCandidate, []);
      }
      apiClientCandidates.get(step.componentCandidate).push({
        method: 'POST',
        endpoint: step.locatorContract?.value || '/api/v1/resource',
        intent: step.intent,
      });
    }
  }
  for (const nc of tape.networkContracts || []) {
    if (nc.clientCandidate) {
      if (!apiClientCandidates.has(nc.clientCandidate)) {
        apiClientCandidates.set(nc.clientCandidate, []);
      }
      apiClientCandidates.get(nc.clientCandidate).push({
        method: nc.method || 'POST',
        endpoint: nc.urlPattern || '/api/v1/resource',
        responseSchemaSummary: nc.responseSchemaSummary,
      });
    }
  }
  if (tape.resumesFrom?.handoffStrategy === 'api-seed' && tape.resumesFrom?.seedClientRef) {
    const rawSeedClass = String(tape.resumesFrom.seedClientRef).trim().split('.')[0];
    if (
      /^[A-Z][A-Za-z0-9_]*$/.test(rawSeedClass) &&
      !rawSeedClass.endsWith('Seeder') &&
      !rawSeedClass.endsWith('Builder') &&
      !apiClientCandidates.has(rawSeedClass)
    ) {
      apiClientCandidates.set(rawSeedClass, [
        { method: 'POST', endpoint: '/api/v1/seed', intent: `Seed state via ${rawSeedClass}` },
      ]);
    }
  }

  const apiClientImports = new Map(); // ClientClass -> { importAlias, fixtureProp }
  for (const [clientClass, endpoints] of apiClientCandidates.entries()) {
    if (!isSafeClassName(clientClass)) {
      throw new Error(`Security Error: Unsafe API Client class name '${clientClass}'.`);
    }
    publishedCapabilities.add(clientClass);
    const existing = existingClasses.get(clientClass);
    const fixtureProp = assertSafeJsIdentifier(
      toCamelCase(stripClassSuffix(clientClass, ['Client'])) || 'apiClient',
      'API Client fixture property'
    );
    if (existing) {
      apiClientImports.set(clientClass, { importAlias: existing.importAlias, fixtureProp });
      plannedOperations.push({
        layer: 'api-client',
        action: 'reuse-existing',
        className: clientClass,
        file: existing.relPath,
        addedMembers: [],
      });
    } else {
      const kebabStem = toKebabCase(stripClassSuffix(clientClass, ['ApiClient', 'Client']));
      const targetRel = `${baseSrcDir}/api/${kebabStem}.client.ts`;
      const importAlias = toImportAlias(targetRel);
      apiClientImports.set(clientClass, { importAlias, fixtureProp });
      const primaryEndpoint =
        endpoints[0]?.endpoint?.replace(/^\*\*\/?/, '/').replace(/^\/\//, '/').replace(/\*+$/, '') ||
        '/api/v1/resource';
      const rawMethod = String(endpoints[0]?.method || 'POST').toLowerCase();
      if (!ALLOWED_HTTP_METHODS.has(rawMethod)) {
        throw new Error(`Security Error: Unsupported HTTP method '${endpoints[0]?.method}'.`);
      }
      const httpMethod = rawMethod;

      const codeContent = `import type { APIRequestContext } from '@playwright/test';
import type { ApiClientContract, ApiResponseEnvelope } from '@contracts/api-client.contract';
import { AuthTokenBridge } from '@shared/api/auth-token.bridge';

/**
 * SOLID Backend API Client (SRP: zero expect() calls, LSP: implements ApiClientContract).
 * Compiled from Session Tape '${sanitizeCodeComment(scenarioId)}'.
 */
export class ${clientClass} implements ApiClientContract {
  constructor(
    readonly request: APIRequestContext,
    readonly baseUrl: string,
    private readonly storageStatePath?: string
  ) {}

  async executeRequest<TPayload = unknown, TResponse = Record<string, unknown>>(
    endpoint = ${JSON.stringify(primaryEndpoint)},
    payload?: TPayload,
    extraHeaders?: Record<string, string>
  ): Promise<ApiResponseEnvelope<TResponse>> {
    const baseOrigin = new URL(this.baseUrl).origin;
    const resolvedUrl = new URL(endpoint, this.baseUrl);
    if (resolvedUrl.origin !== baseOrigin) {
      throw new Error(\`Security Error: Cross-origin API client request to '\${resolvedUrl.origin}' is blocked (expected '\${baseOrigin}').\`);
    }
    const url = resolvedUrl.toString();
    const baseHeaders = this.storageStatePath
      ? AuthTokenBridge.extractAuthHeaders(this.storageStatePath, { targetOrigin: url })
      : {};
    const headers = { ...baseHeaders, ...extraHeaders };
    const res = await this.request.${httpMethod}(url, {
      ...(payload !== undefined ? { data: payload } : {}),
      headers,
    });
    let body: TResponse;
    try {
      body = (await res.json()) as TResponse;
    } catch {
      body = ({} as unknown) as TResponse;
    }
    return {
      status: res.status(),
      ok: res.ok(),
      headers: res.headers(),
      body,
    };
  }
}
`;
      plannedOperations.push({
        layer: 'api-client',
        action: 'create',
        className: clientClass,
        file: targetRel,
        addedMembers: ['executeRequest'],
        codeContent,
      });
    }
  }

  // 4. Analyze UI Components & Conditional Wizard Steps (`IdentifiableComponent`, `ErrorBannerContract`, `WizardStepContract`)
  const componentStepsMap = new Map(); // ComponentClass -> steps[]
  for (const step of tape.semanticSteps || []) {
    if (step.action === 'apiCall') continue;
    const candidate = step.componentCandidate;
    if (!candidate || candidate.endsWith('Page') || candidate.endsWith('ApiClient')) continue;
    if (!componentStepsMap.has(candidate)) {
      componentStepsMap.set(candidate, []);
    }
    if (step.action !== 'goto' && step.locatorContract?.strategy !== 'url') {
      componentStepsMap.get(candidate).push(step);
    }
  }

  // Also inspect expectedStates to ensure any referenced targetProperty exists on the target component
  const expectedPropsBySubProp = new Map(); // subPropName -> Map(targetProperty -> locatorContract|null)
  for (const state of tape.expectedStates || []) {
    const parts = String(state.targetComponent || '').split('.');
    const subProp = parts.length >= 2 ? parts[1] : parts[0];
    if (subProp) {
      if (!expectedPropsBySubProp.has(subProp)) {
        expectedPropsBySubProp.set(subProp, new Map());
      }
      const propMap = expectedPropsBySubProp.get(subProp);
      if (!propMap.has(state.targetProperty) || (!propMap.get(state.targetProperty) && state.locatorContract)) {
        propMap.set(state.targetProperty, state.locatorContract || null);
      }
      if (subProp.endsWith('Component') && !componentStepsMap.has(subProp)) {
        componentStepsMap.set(subProp, []);
      }
    }
  }

  const componentDescriptors = new Map(); // ComponentClass -> { className, propNameOnPage, importAlias, stepLocators }
  for (const [compClass, steps] of componentStepsMap.entries()) {
    assertSafeJsIdentifier(compClass, 'Component class');
    publishedCapabilities.add(compClass);
    const isWizardStep =
      compClass.endsWith('Step') ||
      compClass.endsWith('StepComponent') ||
      steps.some((s) => Boolean(s.conditionRef));
    const isErrorComponent = /error/i.test(compClass);

    const stem = stripClassSuffix(compClass, ['StepComponent', 'Component', 'Step']);
    const propNameOnPage = ensureSafeLocatorPropName(toCamelCase(stem) || 'widget');
    const existing = existingClasses.get(compClass);

    // Map each step to a locator property name (disambiguating colliding names with different expressions)
    const stepLocatorProps = new Map(); // propName -> locatorExpr
    for (const s of steps) {
      const basePropName = deriveLocatorPropertyName(s);
      const expr = buildLocatorExpression(s.locatorContract, 'this.root');
      let propName = basePropName;
      let suffix = 2;
      while (stepLocatorProps.has(propName) && stepLocatorProps.get(propName) !== expr) {
        propName = `${basePropName}${suffix++}`;
      }
      s.__compiledComponentProp = propNameOnPage;
      s.__compiledLocatorProp = propName;
      stepLocatorProps.set(propName, expr);
    }

    // Add any expectedState targetProperty that maps to this component's propNameOnPage or className (#32)
    for (const [subProp, propMap] of expectedPropsBySubProp.entries()) {
      if (
        subProp === compClass ||
        subProp.toLowerCase() === propNameOnPage.toLowerCase() ||
        propNameOnPage.toLowerCase().endsWith(subProp.toLowerCase())
      ) {
        for (const [reqProp, locContract] of propMap.entries()) {
          const safeReqProp = assertSafeJsIdentifier(reqProp, 'expectedState targetProperty');
          if (safeReqProp !== 'root' && !stepLocatorProps.has(safeReqProp)) {
            stepLocatorProps.set(
              safeReqProp,
              locContract ? buildLocatorExpression(locContract, 'this.root') : `this.root`
            );
          }
        }
      }
    }

    if (existing) {
      if (existing.lines >= COMPONENT_WARN_LINES) {
        warnings.push(
          `${existing.relPath} is at ${existing.lines}/${MAX_COMPONENT_LINES} lines. Consider splitting new steps into a separate atomic component.`
        );
      }
      const missingProps = [...stepLocatorProps.entries()].filter(
        ([pName]) => !existing.members.has(pName)
      );
      if (missingProps.length > 0 && existing.lines + missingProps.length * 2 <= MAX_COMPONENT_LINES) {
        let updated = existing.content;
        const propDecls = missingProps.map(([pName]) => `  readonly ${pName}: Locator;`).join('\n');
        const propInits = missingProps
          .map(([pName, expr]) => `    this.${pName} = ${expr};`)
          .join('\n');

        updated = updated.replace(/(readonly\s+root\s*:\s*Locator\s*;)/, (_, m1) => `${m1}\n${propDecls}`);
        updated = updated.replace(/(this\.root\s*=\s*[^;]+;)/, (_, m1) => `${m1}\n${propInits}`);

        plannedOperations.push({
          layer: 'component',
          action: 'extend-existing',
          className: compClass,
          file: existing.relPath,
          addedMembers: missingProps.map(([p]) => p),
          codeContent: updated,
        });
      } else {
        plannedOperations.push({
          layer: 'component',
          action: 'reuse-existing',
          className: compClass,
          file: existing.relPath,
          addedMembers: [],
        });
      }
      componentDescriptors.set(compClass, {
        className: compClass,
        propNameOnPage,
        importAlias: existing.importAlias,
        isWizardStep,
      });
    } else {
      const kebabStem = toKebabCase(stem);
      const subFolder = isWizardStep ? 'steps' : 'components';
      const fileSuffix = isWizardStep ? '.step.ts' : '.component.ts';
      const targetRel = `${baseSrcDir}/${subFolder}/${kebabStem}${fileSuffix}`;
      const importAlias = toImportAlias(targetRel);

      const firstParentScope = steps.find((s) => s.locatorContract?.parentScope)?.locatorContract
        ?.parentScope;
      const rootInitExpr = buildRootLocatorExpression(firstParentScope);

      const propDecls = [...stepLocatorProps.keys()]
        .map((pName) => `  readonly ${pName}: Locator;`)
        .join('\n');
      const propInits = [...stepLocatorProps.entries()]
        .map(([pName, expr]) => `    this.${pName} = ${expr};`)
        .join('\n');

      let contractImport = `import type { IdentifiableComponent } from '@contracts/identifiable-component.contract';`;
      let implementsClause = 'IdentifiableComponent';
      let extraMethods = '';

      let extraInits = '';
      if (isWizardStep) {
        contractImport = `import type { WizardStepContract } from '@contracts/wizard-step.contract';`;
        implementsClause = 'WizardStepContract<Record<string, unknown>>';
        extraMethods = `\n  readonly stepId = ${JSON.stringify(kebabStem)};\n\n  isApplicable(profile: Record<string, unknown>): boolean {\n    return Boolean(profile);\n  }\n\n  async completeStep(_profile: Record<string, unknown>): Promise<void> {\n    // Step actions orchestrated via semantic locators\n  }\n`;
      } else if (isErrorComponent) {
        contractImport = `import type { ErrorBannerContract } from '@contracts/error-banner.contract';`;
        implementsClause = 'ErrorBannerContract';
        const extraDecls = [];
        const initLines = [];
        if (!stepLocatorProps.has('errorBanner')) {
          extraDecls.push('  readonly errorBanner: Locator;');
          initLines.push("    this.errorBanner = this.root.getByRole('alert');");
        }
        if (!stepLocatorProps.has('dismissErrorButton')) {
          extraDecls.push('  readonly dismissErrorButton: Locator;');
          initLines.push("    this.dismissErrorButton = this.errorBanner.getByRole('button');");
        }
        extraInits = initLines.join('\n');
        extraMethods = `${extraDecls.length ? `\n${extraDecls.join('\n')}\n` : '\n'}  async dismissError(): Promise<void> {\n    await this.dismissErrorButton.click();\n  }\n`;
      }

      const codeContent = `import type { Locator, Page } from '@playwright/test';
${contractImport}

/**
 * Atomic SRP Component (<= 150 lines, zero expect() calls).
 * Compiled from Session Tape '${sanitizeCodeComment(scenarioId)}'.
 */
export class ${compClass} implements ${implementsClause} {
  readonly root: Locator;
${propDecls ? propDecls + '\n' : ''}${extraMethods}
  constructor(page: Page) {
    this.root = ${rootInitExpr};
${propInits ? propInits + '\n' : ''}${extraInits ? extraInits + '\n' : ''}  }
}
`;
      plannedOperations.push({
        layer: 'component',
        action: 'create',
        className: compClass,
        file: targetRel,
        contract: implementsClause,
        addedMembers: [...stepLocatorProps.keys()],
        codeContent,
      });

      componentDescriptors.set(compClass, {
        className: compClass,
        propNameOnPage,
        importAlias,
        isWizardStep,
      });
    }
  }

  // 5. Analyze Composed Page Object(s) & Actor Mapping
  // Determine required Page classes from expectedStates (`targetComponent: "loginPage.form"`) or default scenario Page
  const pageRequirements = new Map(); // pageFixtureProp -> { pageClassName, subComponents: Map(subProp -> CompDescriptor), actorId }
  const rawDefaultStem = toPascalCase(
    resolvedSquad ? scenarioId.replace(new RegExp(`^${resolvedSquad}-`), '') : scenarioId
  );
  const defaultStem = /^\d/.test(rawDefaultStem) ? `Scenario${rawDefaultStem}` : rawDefaultStem;
  const defaultPageClass = `${defaultStem}Page`;
  const defaultPageFixture = toCamelCase(defaultPageClass);

  for (const state of tape.expectedStates || []) {
    const parts = String(state.targetComponent || '').split('.');
    const rootTarget = parts[0];
    if (rootTarget && rootTarget.endsWith('Page')) {
      assertSafeJsIdentifier(rootTarget, 'Page fixture property');
      const pageClass = assertSafeJsIdentifier(toPascalCase(rootTarget), 'Page class');
      if (!pageRequirements.has(rootTarget)) {
        pageRequirements.set(rootTarget, {
          fixtureProp: rootTarget,
          pageClassName: pageClass,
          subComponents: new Map(),
          actorId: state.actor || null,
        });
      }
      if (parts[1]) {
        const subProp = assertSafeJsIdentifier(parts[1], 'Page sub-component property');
        // Match component descriptor whose propNameOnPage ends with or matches subProp
        const matchedComp = [...componentDescriptors.values()].find(
          (cd) =>
            cd.propNameOnPage.toLowerCase() === subProp.toLowerCase() ||
            cd.propNameOnPage.toLowerCase().endsWith(subProp.toLowerCase())
        );
        if (matchedComp) {
          matchedComp.propNameOnPage = subProp;
          pageRequirements.get(rootTarget).subComponents.set(subProp, matchedComp);
        }
      }
    }
  }

  if (pageRequirements.size === 0 && componentDescriptors.size > 0) {
    // Check if all steps already map to an existing Page in src/pages
    pageRequirements.set(defaultPageFixture, {
      fixtureProp: defaultPageFixture,
      pageClassName: defaultPageClass,
      subComponents: new Map(),
      actorId: null,
    });
  }

  // Assign any unassigned componentDescriptors to the primary pageRequirement
  const primaryPageReq = pageRequirements.values().next().value;
  if (primaryPageReq) {
    for (const cd of componentDescriptors.values()) {
      const alreadyAssigned = [...pageRequirements.values()].some((pr) =>
        [...pr.subComponents.values()].includes(cd)
      );
      if (!alreadyAssigned) {
        primaryPageReq.subComponents.set(cd.propNameOnPage, cd);
      }
    }
  }

  const pageFixtureDescriptors = new Map(); // fixtureProp -> { pageClassName, importAlias, actor }
  for (const [fixtureProp, pageReq] of pageRequirements.entries()) {
    const { pageClassName, subComponents, actorId } = pageReq;
    assertSafeJsIdentifier(fixtureProp, 'Page fixture property');
    assertSafeJsIdentifier(pageClassName, 'Page class');
    publishedCapabilities.add(pageClassName);
    const existing = existingClasses.get(pageClassName);
    const actorObj = (tape.actors || []).find((a) => a.actorId === actorId) || null;

    if (existing) {
      pageFixtureDescriptors.set(fixtureProp, {
        fixtureProp,
        pageClassName,
        importAlias: existing.importAlias,
        actor: actorObj,
      });
      plannedOperations.push({
        layer: 'page',
        action: 'reuse-existing',
        className: pageClassName,
        file: existing.relPath,
        addedMembers: [],
      });
    } else {
      const kebabStem = toKebabCase(stripClassSuffix(pageClassName, ['Page']));
      const targetRel = `${baseSrcDir}/pages/${kebabStem}.page.ts`;
      const importAlias = toImportAlias(targetRel);
      pageFixtureDescriptors.set(fixtureProp, {
        fixtureProp,
        pageClassName,
        importAlias,
        actor: actorObj,
      });

      const compImports = [...subComponents.values()]
        .map((cd) => `import { ${cd.className} } from '${cd.importAlias}';`)
        .join('\n');
      const compProps = [...subComponents.entries()]
        .map(([prop, cd]) => `  readonly ${prop}: ${cd.className};`)
        .join('\n');
      const compInits = [...subComponents.entries()]
        .map(([prop, cd]) => `    this.${prop} = new ${cd.className}(page);`)
        .join('\n');

      const codeContent = `import type { Page } from '@playwright/test';
${compImports ? compImports + '\n' : ''}
/**
 * Composed Page Object (SRP: zero expect() calls).
 * Compiled from Session Tape '${sanitizeCodeComment(scenarioId)}'.
 */
export class ${pageClassName} {
${compProps ? compProps + '\n' : ''}
  constructor(private readonly page: Page) {
${compInits ? compInits + '\n' : ''}  }

  async open(routePath = ${JSON.stringify(
        (() => {
          if (tape.baseUrl && domainGraph?.targetApp?.baseUrl) {
            try {
              if (new URL(tape.baseUrl).origin !== new URL(domainGraph.targetApp.baseUrl).origin) {
                const firstGoto = (tape.semanticSteps || []).find((s) => s.action === 'goto');
                const rawRoute = firstGoto?.locatorContract?.value || firstGoto?.pageRoute || '/';
                return rawRoute.startsWith('http') ? rawRoute : new URL(rawRoute, tape.baseUrl).toString();
              }
            } catch {
              /* fallback '/' */
            }
          }
          return '/';
        })()
      )}): Promise<void> {
    const resolved = ${(() => {
      if (tape.baseUrl && domainGraph?.targetApp?.baseUrl) {
        try {
          const tapeOrigin = new URL(tape.baseUrl).origin;
          const appOrigin = new URL(domainGraph.targetApp.baseUrl).origin;
          if (tapeOrigin !== appOrigin) {
            return `routePath.startsWith('/') ? new URL(routePath, ${JSON.stringify(tapeOrigin)}).toString() : routePath`;
          }
        } catch {
          /* ignore */
        }
      }
      return 'routePath';
    })()};
    await this.page.goto(resolved);
  }
}
`;
      plannedOperations.push({
        layer: 'page',
        action: 'create',
        className: pageClassName,
        file: targetRel,
        addedMembers: ['open', ...subComponents.keys()],
        codeContent,
      });
    }
  }

  // 6. Wire Target Fixture (`src/fixtures/app.fixture.ts` or `src/domains/<squad>/fixtures/<squad>.fixture.ts`)
  const fixtureFullPath = path.join(ROOT, fixtureRelPath);
  const fixtureAlias = toImportAlias(fixtureRelPath);
  const allFixtureEntries = [];

  for (const [fixtureProp, pDesc] of pageFixtureDescriptors.entries()) {
    allFixtureEntries.push({
      propName: fixtureProp,
      typeName: pDesc.pageClassName,
      importAlias: pDesc.importAlias,
      kind: 'page',
      actor: pDesc.actor,
    });
  }
  for (const [clientClass, cDesc] of apiClientImports.entries()) {
    allFixtureEntries.push({
      propName: cDesc.fixtureProp,
      typeName: clientClass,
      importAlias: cDesc.importAlias,
      kind: 'api',
      apiBaseUrl: tape.apiBaseUrl || tape.baseUrl,
      storageStatePath: tape.persona?.storageStatePath || null,
    });
  }

  // 5b. State Seeder Layer (StateSeederContract<TInput, THandle> + fixture auto-teardown)
  const seederImports = new Map(); // SeederClass -> { importAlias, fixtureProp }
  if (tape.resumesFrom?.seedClientRef) {
    const rawSeed = String(tape.resumesFrom.seedClientRef).trim();
    const parsedSeed = parseBuilderRef(rawSeed);
    const seedCls =
      parsedSeed?.builderClass || (/^[A-Z][A-Za-z0-9_]*$/.test(rawSeed) ? rawSeed : null);
    if (seedCls && seedCls.endsWith('Seeder') && isSafeClassName(seedCls)) {
      const seederClass = seedCls;
      const stem = stripClassSuffix(seederClass, ['Seeder']) || 'State';
      const fixtureProp = `seeded${stem}`;
      publishedCapabilities.add(seederClass);
      const existingSeeder = existingClasses.get(seederClass);
      if (existingSeeder) {
        seederImports.set(seederClass, { importAlias: existingSeeder.importAlias, fixtureProp });
        plannedOperations.push({
          layer: 'seeder',
          action: 'reuse-existing',
          className: seederClass,
          file: existingSeeder.relPath,
          addedMembers: [],
        });
      } else {
        const kebabStem = toKebabCase(stem);
        const targetRel = `${baseSrcDir}/seeders/${kebabStem}.seeder.ts`;
        const importAlias = toImportAlias(targetRel);
        seederImports.set(seederClass, { importAlias, fixtureProp });
        const codeContent = `import crypto from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { StateSeederContract } from '@contracts/state-seeder.contract';

/**
 * Composable Domain State Seeder (SRP <= 150 lines, zero expect(), LSP: StateSeederContract).
 * Compiled from Session Tape '${sanitizeCodeComment(scenarioId)}'.
 */
export class ${seederClass} implements StateSeederContract<void, Record<string, unknown>> {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string
  ) {}

  async seed(): Promise<Record<string, unknown>> {
    void this.request;
    void this.baseUrl;
    return { id: crypto.randomUUID() };
  }

  async teardown(handle: Record<string, unknown>): Promise<void> {
    void handle;
  }
}
`;
        plannedOperations.push({
          layer: 'seeder',
          action: 'create',
          className: seederClass,
          file: targetRel,
          contract: 'StateSeederContract',
          addedMembers: ['seed', 'teardown'],
          codeContent,
        });
      }
      allFixtureEntries.push({
        propName: fixtureProp,
        typeName: seederClass,
        fixtureType: 'Record<string, unknown>',
        importAlias: seederImports.get(seederClass).importAlias,
        kind: 'seeder',
        apiBaseUrl: tape.apiBaseUrl || tape.baseUrl,
      });
    }
  }

  // 5c. Reusable SOLID Flow Layer (FlowContract<void, Record<string, string>>) for ui-prereq handoff
  const flowImports = new Map(); // FlowClass -> { importAlias, fixtureProp }
  if (tape.resumesFrom && typeof tape.resumesFrom === 'object') {
    const rf = tape.resumesFrom;
    const strategy =
      rf.handoffStrategy ||
      (rf.checkpointPath ? 'checkpoint-state' : rf.seedClientRef ? 'api-seed' : 'ui-prereq');
    if (strategy === 'ui-prereq') {
      const parsedFlow = rf.flowRef ? parseBuilderRef(rf.flowRef) : null;
      const rawFlowClass =
        parsedFlow?.builderClass ||
        `${toPascalCase(rf.scenarioId || path.basename(rf.specFile || 'prerequisite', '.spec.ts'))}Flow`;
      const flowClass = rawFlowClass.endsWith('Flow') ? rawFlowClass : `${rawFlowClass}Flow`;
      if (isSafeClassName(flowClass)) {
        const stem = stripClassSuffix(flowClass, ['Flow']) || 'Prerequisite';
        const fixtureProp = `${toCamelCase(stem)}Flow`;
        publishedCapabilities.add(flowClass);
        const existingFlow = existingClasses.get(flowClass);
        if (existingFlow) {
          flowImports.set(flowClass, { importAlias: existingFlow.importAlias, fixtureProp });
          plannedOperations.push({
            layer: 'flow',
            action: 'reuse-existing',
            className: flowClass,
            file: existingFlow.relPath,
            addedMembers: [],
          });
        } else {
          const kebabStem = toKebabCase(stem);
          const targetRel = `${baseSrcDir}/flows/${kebabStem}.flow.ts`;
          const importAlias = toImportAlias(targetRel);
          flowImports.set(flowClass, { importAlias, fixtureProp });
          const parentComment = sanitizeCodeComment(rf.specFile || rf.scenarioId || 'point-a');
          const codeContent = `import type { Page } from '@playwright/test';
import type { FlowContract } from '@contracts/flow.contract';

/**
 * Reusable Point-A UI Prerequisite Flow (SRP <= 150 lines, zero expect(), LSP: FlowContract).
 * Extracted from prerequisite '${parentComment}' for scenario '${sanitizeCodeComment(scenarioId)}'.
 */
export class ${flowClass} implements FlowContract<void, Record<string, string>> {
  constructor(private readonly page: Page) {}

  async execute(): Promise<Record<string, string>> {
    await this.page.goto(${JSON.stringify(tape.baseUrl || '/')});
    return {};
  }
}
`;
          plannedOperations.push({
            layer: 'flow',
            action: 'create',
            className: flowClass,
            file: targetRel,
            contract: 'FlowContract',
            addedMembers: ['execute'],
            codeContent,
          });
        }
        allFixtureEntries.push({
          propName: fixtureProp,
          typeName: flowClass,
          importAlias: flowImports.get(flowClass).importAlias,
          kind: 'flow',
        });
      }
    }
  }

  // 6b. Optional --emit-seeder: promote mutating networkContracts into a <300ms StateSeederContract and register in app.fixture.ts (#34, #51)
  if (emitSeeder) {
    const mutatingContracts = (tape.networkContracts || []).filter((nc) =>
      ['POST', 'PUT', 'PATCH'].includes(String(nc?.method || '').toUpperCase())
    );
    if (mutatingContracts.length > 0) {
      const primary = mutatingContracts[0];
      const httpMethod = String(primary.method || 'POST').toLowerCase();
      const seederStem = toPascalCase(scenarioId);
      const seederClass = seederStem.endsWith('Seeder') ? seederStem : `${seederStem}Seeder`;
      const seederRel = `${baseSrcDir}/seeders/${toKebabCase(scenarioId)}-seeder.ts`;
      const endpointPath = String(primary.urlPattern || '/api/v1/seed');
      const fallbackBaseUrl = String(tape.apiBaseUrl || tape.baseUrl || '');
      const urlLine = /^https?:\/\//i.test(endpointPath)
        ? `    const url = ${JSON.stringify(endpointPath)};`
        : `    const url = \`\${this.baseUrl.replace(/\\/$/, '')}${endpointPath}\`;`;
      const seederCode = `import type { APIRequestContext } from '@playwright/test';
import type { StateSeederContract } from '@contracts/state-seeder.contract';

export class ${seederClass} implements StateSeederContract<Record<string, unknown>, Record<string, unknown>> {
  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string = process.env.API_BASE_URL || process.env.BASE_URL || ${JSON.stringify(fallbackBaseUrl)}
  ) {}

  async seed(payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
${urlLine}
    const res = await this.request.${httpMethod}(url, { data: payload });
    if (!res.ok()) {
      throw new Error(\`${seederClass} failed (\${res.status()}): \${await res.text()}\`);
    }
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  async teardown(_handle: Record<string, unknown>): Promise<void> {
    // Optional post-test cleanup hook
  }
}
`;
      plannedOperations.push({
        layer: 'seeder',
        action: fs.existsSync(path.join(ROOT, seederRel)) ? 'overwrite' : 'create',
        className: seederClass,
        file: seederRel,
        addedMembers: ['seed', 'teardown'],
        codeContent: seederCode,
      });
      allFixtureEntries.push({
        propName: ensureSafeLocatorPropName(toCamelCase(seederClass)),
        typeName: seederClass,
        fixtureType: 'Record<string, unknown>',
        importAlias: toImportAlias(seederRel),
        kind: 'seeder',
        apiBaseUrl: fallbackBaseUrl,
      });
    } else {
      warnings.push('--emit-seeder requested, but tape has no mutating POST/PUT/PATCH networkContracts.');
    }
  }

  if (fs.existsSync(fixtureFullPath)) {
    let fixtureContent = fs.readFileSync(fixtureFullPath, 'utf8');
    const missingEntries = allFixtureEntries.filter(
      (entry) => !new RegExp(`\\b${entry.propName}\\s*:`).test(fixtureContent)
    );
    if (missingEntries.length > 0) {
      const importLines = [
        ...new Set(
          missingEntries
            .filter((e) => !fixtureContent.includes(`from '${e.importAlias}'`))
            .map((e) => `import { ${e.typeName} } from '${e.importAlias}';`)
        ),
      ].join('\n');
      if (importLines) {
        fixtureContent = `${importLines}\n${fixtureContent}`;
      }
      const interfaceLines = missingEntries
        .map((e) => `  ${e.propName}: ${e.fixtureType || e.typeName};`)
        .join('\n');
      fixtureContent = fixtureContent.replace(
        /(export\s+interface\s+[A-Za-z0-9_]+\s*\{)/,
        `$1\n${interfaceLines}`
      );

      const implLines = missingEntries
        .map((e) => {
          if (e.kind === 'seeder') {
            return `  ${e.propName}: async ({ request }, use) => {\n    const seeder = new ${e.typeName}(request, process.env.API_BASE_URL || process.env.BASE_URL || ${JSON.stringify(e.apiBaseUrl)});\n    const handle = await seeder.seed();\n    try {\n      await use(handle);\n    } finally {\n      await seeder.teardown?.(handle);\n    }\n  },`;
          }
          if (e.kind === 'api') {
            const storageArg = e.storageStatePath ? `, ${JSON.stringify(e.storageStatePath)}` : '';
            return `  ${e.propName}: async ({ request }, use) => {\n    await use(new ${e.typeName}(request, process.env.API_BASE_URL || process.env.BASE_URL || ${JSON.stringify(e.apiBaseUrl)}${storageArg}));\n  },`;
          }
          if (e.actor?.storageStatePath) {
            return `  ${e.propName}: async ({ browser }, use) => {\n    const ctx = await browser.newContext({ storageState: ${JSON.stringify(e.actor.storageStatePath)} });\n    const page = await ctx.newPage();\n    await use(new ${e.typeName}(page));\n    await ctx.close();\n  },`;
          }
          return `  ${e.propName}: async ({ page }, use) => {\n    await use(new ${e.typeName}(page));\n  },`;
        })
        .join('\n');

      fixtureContent = fixtureContent.replace(
        /([A-Za-z_][A-Za-z0-9_]*\.extend<[^>]+>\(\{)/,
        (_, m1) => `${m1}\n${implLines}`
      );

      plannedOperations.push({
        layer: 'fixture',
        action: 'extend-existing',
        file: fixtureRelPath,
        addedMembers: missingEntries.map((e) => e.propName),
        codeContent: fixtureContent,
      });
    } else {
      plannedOperations.push({
        layer: 'fixture',
        action: 'reuse-existing',
        file: fixtureRelPath,
        addedMembers: [],
      });
    }
  } else {
    const importLines = [
      ...new Set(allFixtureEntries.map((e) => `import { ${e.typeName} } from '${e.importAlias}';`)),
    ].join('\n');
    const interfaceName = resolvedSquad
      ? `${toPascalCase(resolvedSquad)}Fixtures`
      : 'AppFixtures';
    const interfaceLines = allFixtureEntries
      .map((e) => `  ${e.propName}: ${e.fixtureType || e.typeName};`)
      .join('\n');
    const implLines = allFixtureEntries
      .map((e) => {
        if (e.kind === 'seeder') {
          return `  ${e.propName}: async ({ request }, use) => {\n    const seeder = new ${e.typeName}(request, process.env.API_BASE_URL || process.env.BASE_URL || ${JSON.stringify(e.apiBaseUrl)});\n    const handle = await seeder.seed();\n    try {\n      await use(handle);\n    } finally {\n      await seeder.teardown?.(handle);\n    }\n  },`;
        }
        if (e.kind === 'api') {
          const storageArg = e.storageStatePath ? `, ${JSON.stringify(e.storageStatePath)}` : '';
          return `  ${e.propName}: async ({ request }, use) => {\n    await use(new ${e.typeName}(request, process.env.API_BASE_URL || process.env.BASE_URL || ${JSON.stringify(e.apiBaseUrl)}${storageArg}));\n  },`;
        }
        if (e.actor?.storageStatePath) {
          return `  ${e.propName}: async ({ browser }, use) => {\n    const ctx = await browser.newContext({ storageState: ${JSON.stringify(e.actor.storageStatePath)} });\n    const page = await ctx.newPage();\n    await use(new ${e.typeName}(page));\n    await ctx.close();\n  },`;
        }
        return `  ${e.propName}: async ({ page }, use) => {\n    await use(new ${e.typeName}(page));\n  },`;
      })
      .join('\n');

    const codeContent = `import { test as base, expect } from '@playwright/test';
${importLines ? importLines + '\n' : ''}
export interface ${interfaceName} {
${interfaceLines}
}

export const test = base.extend<${interfaceName}>({
${implLines}
});

export { expect };
`;
    plannedOperations.push({
      layer: 'fixture',
      action: 'create',
      file: fixtureRelPath,
      addedMembers: allFixtureEntries.map((e) => e.propName),
      codeContent,
    });
  }

  // 7. Synthesize Declarative Spec (`tests/<scenario-id>.spec.ts` or `tests/<squad>/<scenario-id>.spec.ts`)
  const existingSpecs = walkFiles(path.join(ROOT, 'tests'), '.spec.ts');
  const exactSpecPath = path.resolve(ROOT, `${baseTestDir}/${scenarioId}.spec.ts`);
  const scenarioIdBoundaryRe = new RegExp(`(?<![a-z0-9-])${scenarioId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`);
  const matchingExistingSpec = existingSpecs.includes(exactSpecPath)
    ? exactSpecPath
    : existingSpecs.find((sf) => scenarioIdBoundaryRe.test(fs.readFileSync(sf, 'utf8')));
  const specRelPath = matchingExistingSpec
    ? rel(matchingExistingSpec)
    : `${baseTestDir}/${scenarioId}.spec.ts`;

  if (matchingExistingSpec && !forceSpec) {
    plannedOperations.push({
      layer: 'spec',
      action: 'reuse-existing',
      file: specRelPath,
      addedMembers: [],
    });
  } else {
    const tagsList = Array.isArray(tape.tags) && tape.tags.length > 0 ? tape.tags : ['@p0', '@smoke'];
    const tagsSuffix = tagsList.join(' ');
    const injectedFixtures = allFixtureEntries.map((e) => e.propName);
    const builderImportLines = [...builderImports.entries()]
      .map(([cls, alias]) => `import { ${cls} } from '${alias}';`)
      .join('\n');

    const toBusinessStepFallback = (componentCandidate, action) => {
      const base = stripClassSuffix(String(componentCandidate || 'Workflow'), [
        'StepComponent',
        'Component',
        'Page',
        'ApiClient',
        'Client',
        'Wizard',
        'Form',
        'Modal',
        'Dialog',
        'Banner',
        'List',
        'Header',
      ]);
      const words = base
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .toLowerCase();
      const label = words || 'application';
      if (action === 'apiCall') {
        return `Execute ${label} service operation`;
      }
      if (label === 'login' || label === 'auth' || label === 'authentication') {
        return 'Authenticate user session';
      }
      return `Complete ${label} workflow`;
    };

    const capturedVarsDeclared = new Set();
    if (Array.isArray(tape.capturedVariables)) {
      for (const cv of tape.capturedVariables) {
        if (cv?.name) {
          capturedVarsDeclared.add(assertSafeJsIdentifier(cv.name, 'capturedVariables.name'));
        }
      }
    }
    const businessGroups = [];
    const primaryPageFixture = pageFixtureDescriptors.keys().next().value;

    for (const step of tape.semanticSteps || []) {
      const parsedInput = parseBuilderRef(step.inputDataRef);
      const inputExpr = parsedInput?.callExpression || 'undefined';

      let stmt = '';
      const groupMatchKeys = new Set();
      if (step.action === 'apiCall' && step.componentCandidate) {
        const apiDesc = apiClientImports.get(step.componentCandidate);
        const apiFix = apiDesc?.fixtureProp || 'apiClient';
        groupMatchKeys.add(apiFix);
        const payloadArg = step.inputDataRef ? `, ${inputExpr}` : '';
        const endpointArg = JSON.stringify(step.locatorContract?.value || '/api/v1/resource');
        if (step.capturesVariable) {
          const safeCapVar = assertSafeJsIdentifier(step.capturesVariable, 'capturesVariable');
          capturedVarsDeclared.add(safeCapVar);
          const cv = (tape.capturedVariables || []).find((c) => c.name === safeCapVar);
          const jsonSegments = cv?.jsonPath
            ? String(cv.jsonPath)
                .replace(/^\$\.?/, '')
                .split('.')
                .map((s) => s.trim())
                .filter(Boolean)
            : [];
          for (const seg of jsonSegments) {
            assertSafeJsIdentifier(seg, 'jsonPath segment');
          }
          const keyAccessExpr =
            jsonSegments.length > 0
              ? jsonSegments.map((seg) => `?.[${JSON.stringify(seg)}]`).join('') + " ?? ''"
              : '';
          stmt = `const ${safeCapVar}Res = await ${apiFix}.executeRequest(${endpointArg}${payloadArg});\n${safeCapVar} = String((${safeCapVar}Res.body as Record<string, any>)${keyAccessExpr});`;
        } else {
          stmt = `await ${apiFix}.executeRequest(${endpointArg}${payloadArg});`;
        }
      } else if (step.action === 'goto') {
        const targetRoute = step.locatorContract?.value || step.pageRoute || '/';
        const isAbsoluteUrl = /^https?:\/\//i.test(targetRoute);
        let isCrossOriginRelative = false;
        if (targetRoute.startsWith('/') && tape.baseUrl && domainGraph?.targetApp?.baseUrl) {
          try {
            if (new URL(tape.baseUrl).origin !== new URL(domainGraph.targetApp.baseUrl).origin) {
              isCrossOriginRelative = true;
            }
          } catch {
            /* keep relative targetRoute */
          }
        }
        if (primaryPageFixture) {
          groupMatchKeys.add(primaryPageFixture);
          const firstGotoRoute = (tape.semanticSteps || []).find((s) => s.action === 'goto')?.locatorContract?.value || (tape.semanticSteps || []).find((s) => s.action === 'goto')?.pageRoute || '/';
          if (isAbsoluteUrl || (isCrossOriginRelative && targetRoute === firstGotoRoute)) {
            stmt = `await ${primaryPageFixture}.open();`;
          } else {
            stmt = `await ${primaryPageFixture}.open(${JSON.stringify(targetRoute)});`;
          }
        }
      } else if (step.action === 'route') {
        if (!injectedFixtures.includes('page')) injectedFixtures.push('page');
        const rawPattern = step.locatorContract?.value || '/api/**';
        const routeGlob = rawPattern.startsWith('http') || rawPattern.startsWith('**')
          ? rawPattern
          : `**${rawPattern.startsWith('/') ? '' : '/'}${rawPattern}`;
        const chaosNc = (tape.networkContracts || []).find((nc) => nc.chaosFaultInjected) || (tape.networkContracts || [])[0];
        const statusCode = Number(chaosNc?.expectedStatus) || 500;
        stmt = `await page.route(${JSON.stringify(routeGlob)}, (route) => route.fulfill({ status: ${statusCode}, contentType: 'application/json', body: JSON.stringify({ error: 'Injected chaos fault' }) }));`;
      } else if (primaryPageFixture && step.__compiledComponentProp && step.__compiledLocatorProp) {
        let stepPageFixture = primaryPageFixture;
        let stepCompProp = step.__compiledComponentProp;
        const compDesc = step.componentCandidate ? componentDescriptors.get(step.componentCandidate) : null;
        if (compDesc) {
          stepCompProp = compDesc.propNameOnPage;
          for (const [pFix, pReq] of pageRequirements.entries()) {
            for (const [subP, cd] of pReq.subComponents.entries()) {
              if (cd === compDesc || cd.className === compDesc.className) {
                stepPageFixture = pFix;
                stepCompProp = subP;
                break;
              }
            }
          }
        }
        groupMatchKeys.add(stepPageFixture);
        groupMatchKeys.add(`${stepPageFixture}.${stepCompProp}`);
        const locRef = `${stepPageFixture}.${stepCompProp}.${step.__compiledLocatorProp}`;
        const forceArg = step.locatorContract?.force ? '{ force: true }' : '';
        if (step.action === 'fill') {
          stmt = `await ${locRef}.fill(String(${inputExpr}));`;
        } else if (step.action === 'selectOption') {
          stmt = `await ${locRef}.selectOption(String(${inputExpr}));`;
        } else if (step.action === 'upload') {
          stmt = `await ${locRef}.setInputFiles(String(${inputExpr}));`;
        } else if (step.action === 'waitFor') {
          stmt = `await ${locRef}.waitFor();`;
        } else if (step.action === 'press') {
          stmt = `await ${locRef}.press(${JSON.stringify(step.key || 'Enter')});`;
        } else if (step.action === 'check') {
          stmt = `await ${locRef}.check(${forceArg});`;
        } else if (step.action === 'uncheck') {
          stmt = `await ${locRef}.uncheck(${forceArg});`;
        } else if (step.action === 'hover') {
          stmt = `await ${locRef}.hover();`;
        } else {
          stmt = `await ${locRef}.click(${forceArg});`;
        }
        if (step.opensPopup) {
          if (!injectedFixtures.includes('page')) injectedFixtures.push('page');
          const rawCall = stmt.replace(/^await\s+/, '').replace(/;$/, '');
          stmt = `const [popupPage] = await Promise.all([\n  page.waitForEvent('popup'),\n  ${rawCall},\n]);\nawait popupPage.waitForLoadState();\nvoid popupPage;`;
        }
        if (step.dialogAction === 'accept' || step.dialogAction === 'dismiss') {
          if (!injectedFixtures.includes('page')) injectedFixtures.push('page');
          stmt = `page.once('dialog', (d) => d.${step.dialogAction}());\n${stmt}`;
        }
        if (step.capturesVariable) {
          const safeCapVar = assertSafeJsIdentifier(step.capturesVariable, 'capturesVariable');
          capturedVarsDeclared.add(safeCapVar);
          stmt += `\n${safeCapVar} = (await ${locRef}.textContent()) ?? '';`;
        }
      }

      if (stmt) {
        if (step.conditionRef) {
          const condParsed = parseBuilderRef(step.conditionRef);
          const condExpr = condParsed?.callExpression || 'true';
          stmt = `if (${condExpr}) {\n  ${stmt.replace(/\n/g, '\n  ')}\n}`;
        }
        const sanitizeStepTitle = (raw) =>
          sanitizeCodeComment(raw).replace(
            /\b(dropdown|checkboxes?|buttons?|inputs?|textboxes?|selectors?|locators?|xpaths?|css)\b/gi,
            'workflow'
          );
        const stepTitle = step.businessStep
          ? sanitizeStepTitle(step.businessStep)
          : sanitizeStepTitle(toBusinessStepFallback(step.componentCandidate, step.action));
        const lastGroup = businessGroups[businessGroups.length - 1];
        if (lastGroup && lastGroup.title === stepTitle) {
          lastGroup.statements.push(stmt);
          lastGroup.stepIndices.push(step.stepIndex);
          for (const k of groupMatchKeys) lastGroup.matchKeys.add(k);
        } else {
          businessGroups.push({
            title: stepTitle,
            matchKeys: groupMatchKeys,
            statements: [stmt],
            stepIndices: [step.stepIndex],
          });
        }
      }
    }

    const insertStatementInGroup = (group, stmtCode, afterStepIndex) => {
      if (!Array.isArray(group.stepIndices)) {
        group.stepIndices = group.statements.map((_, idx) => idx + 1);
      }
      if (typeof afterStepIndex === 'number' && Number.isFinite(afterStepIndex)) {
        let insertAt = 0;
        for (let i = 0; i < group.stepIndices.length; i++) {
          if (group.stepIndices[i] <= afterStepIndex) {
            insertAt = i + 1;
          }
        }
        group.statements.splice(insertAt, 0, stmtCode);
        group.stepIndices.splice(insertAt, 0, afterStepIndex);
      } else {
        group.statements.push(stmtCode);
        group.stepIndices.push(Infinity);
      }
    };

    for (const state of tape.expectedStates || []) {
      if (!isSafeMemberRef(state.targetComponent) || !isSafeMemberRef(state.targetProperty)) {
        throw new Error(
          `Security Error: Unsafe expectedStates target reference '${state.targetComponent}.${state.targetProperty}'.`
        );
      }
      for (const seg of String(state.targetComponent || '').split('.')) {
        assertSafeJsIdentifier(seg.replace(/\(\)$/, ''), 'expectedStates.targetComponent segment');
      }
      for (const seg of String(state.targetProperty || '').split('.')) {
        assertSafeJsIdentifier(seg.replace(/\(\)$/, ''), 'expectedStates.targetProperty segment');
      }
      let resolvedTargetComponent = state.targetComponent;
      if (
        primaryPageFixture &&
        !resolvedTargetComponent.includes('.') &&
        !injectedFixtures.includes(resolvedTargetComponent)
      ) {
        const directDesc = componentDescriptors.get(resolvedTargetComponent);
        const matchedStep = (tape.semanticSteps || []).find(
          (s) =>
            s.__compiledComponentProp &&
            (s.componentCandidate === resolvedTargetComponent ||
              toCamelCase(s.componentCandidate || '') === resolvedTargetComponent ||
              s.__compiledComponentProp === resolvedTargetComponent)
        );
        if (directDesc) {
          resolvedTargetComponent = `${primaryPageFixture}.${directDesc.propNameOnPage}`;
        } else if (matchedStep) {
          resolvedTargetComponent = `${primaryPageFixture}.${matchedStep.__compiledComponentProp}`;
        }
      }
      const targetExpr = `${resolvedTargetComponent}.${state.targetProperty}`;
      const isLiteralUrlPath =
        state.assertionType === 'toHaveURL' &&
        typeof state.expectedValueRef === 'string' &&
        state.expectedValueRef.startsWith('/');
      const parsedExpected = isLiteralUrlPath ? null : parseBuilderRef(state.expectedValueRef);
      const valExpr = parsedExpected?.isCapturedVar
        ? parsedExpected.varName
        : parsedExpected?.callExpression || '';

      let assertStmt;
      if (state.assertionType === 'toHaveStatus') {
        const apiDesc = apiClientImports.get(state.targetComponent);
        const apiFix = apiDesc?.fixtureProp || 'apiClient';
        const matchingNc = (tape.networkContracts || []).find(
          (nc) => nc.clientCandidate === state.targetComponent
        );
        const endpointArg = JSON.stringify(matchingNc?.urlPattern || '/api/v1/resource');
        const statusMatch = String(state.expectedValueRef || '').match(/(\d{3})/);
        const expectedStatus = statusMatch ? Number(statusMatch[1]) : 200;
        assertStmt = `expect((await ${apiFix}.executeRequest(${endpointArg})).status).toBe(${expectedStatus});`;
      } else if (
        state.assertionType === 'toBeVisible' ||
        state.assertionType === 'toBeHidden' ||
        state.assertionType === 'toBeEnabled' ||
        state.assertionType === 'toBeDisabled' ||
        state.assertionType === 'toBeChecked'
      ) {
        assertStmt = `await expect(${targetExpr}).${state.assertionType}();`;
      } else if (state.assertionType === 'toHaveCount') {
        assertStmt = `await expect(${targetExpr}).toHaveCount(Number(${valExpr}));`;
      } else if (state.assertionType === 'toMatchObject') {
        assertStmt = `await expect(${targetExpr}).toMatchObject(${valExpr});`;
      } else if (state.assertionType === 'toHaveURL') {
        const rawUrl = String(state.expectedValueRef || '').trim();
        const urlArg = valExpr
          ? `new RegExp(String(${valExpr}).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'))`
          : `new RegExp(${JSON.stringify(rawUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))})`;
        assertStmt = `await expect(${targetExpr}.page()).toHaveURL(${urlArg});`;
      } else if (state.assertionType === 'toHaveScreenshot') {
        const ratio =
          typeof state.maxDiffPixelRatio === 'number' &&
          state.maxDiffPixelRatio >= 0 &&
          state.maxDiffPixelRatio <= 1
            ? state.maxDiffPixelRatio
            : 0.02;
        const masks = Array.isArray(state.maskSelectors)
          ? state.maskSelectors
              .filter((s) => typeof s === 'string' && s.trim().length > 0 && !/[`$\r\n]/.test(s))
              .map((s) => `${targetExpr}.page().locator(${JSON.stringify(s.trim())})`)
          : [];
        const maskProp = masks.length > 0 ? `, mask: [${masks.join(', ')}]` : '';
        assertStmt = `await expect(${targetExpr}).toHaveScreenshot(String(${valExpr}), { animations: 'disabled', maxDiffPixelRatio: ${ratio}${maskProp} });`;
      } else {
        assertStmt = `await expect(${targetExpr}).${state.assertionType}(String(${valExpr}));`;
      }

      if (state.businessStep) {
        const targetTitle = sanitizeCodeComment(state.businessStep).replace(
          /\b(dropdown|checkboxes?|buttons?|inputs?|textboxes?|selectors?|locators?|xpaths?|css)\b/gi,
          'workflow'
        );
        const existingGroup = [...businessGroups].reverse().find((g) => g.title === targetTitle);
        if (existingGroup) {
          insertStatementInGroup(existingGroup, assertStmt, state.afterStepIndex);
        } else {
          businessGroups.push({
            title: targetTitle,
            matchKeys: new Set(),
            statements: [assertStmt],
            stepIndices: [typeof state.afterStepIndex === 'number' ? state.afterStepIndex : Infinity],
          });
        }
      } else {
        const matchingGroup = [...businessGroups]
          .reverse()
          .find(
            (g) =>
              g.matchKeys.has(state.targetComponent) ||
              g.matchKeys.has(state.targetComponent.split('.')[0])
          );
        if (matchingGroup) {
          insertStatementInGroup(matchingGroup, assertStmt, state.afterStepIndex);
        } else if (businessGroups.length > 0) {
          insertStatementInGroup(businessGroups[businessGroups.length - 1], assertStmt, state.afterStepIndex);
        } else {
          businessGroups.push({
            title: 'Verify expected business outcomes',
            matchKeys: new Set(),
            statements: [assertStmt],
            stepIndices: [typeof state.afterStepIndex === 'number' ? state.afterStepIndex : Infinity],
          });
        }
      }
    }

    // #27: Auto-emit initial page.open() at start of Step 1 when the tape has no leading goto action
    const hasExplicitGoto = (tape.semanticSteps || []).some(
      (s) => s.action === 'goto' || s.locatorContract?.strategy === 'url'
    );
    const hasUiSteps = (tape.semanticSteps || []).some((s) => s.action !== 'apiCall');
    if (
      !hasExplicitGoto &&
      !tape.resumesFrom &&
      primaryPageFixture &&
      hasUiSteps &&
      businessGroups.length > 0
    ) {
      const openStmt = `await ${primaryPageFixture}.open();`;
      if (!businessGroups[0].statements.includes(openStmt)) {
        businessGroups[0].statements.unshift(openStmt);
      }
    }

    const extraNodeImports = [];
    let resumesFromPreamble = '';
    if (tape.resumesFrom && typeof tape.resumesFrom === 'object') {
      const rf = tape.resumesFrom;
      const strategy =
        rf.handoffStrategy ||
        (rf.checkpointPath ? 'checkpoint-state' : rf.seedClientRef ? 'api-seed' : 'ui-prereq');
      const parentLabel = sanitizeCodeComment(rf.scenarioId || rf.specFile || 'point-a');
      const annotationDesc = `${parentLabel} (${strategy}${rf.resumeStep ? `: ${sanitizeCodeComment(rf.resumeStep)}` : ''})`;

      const buildHydrationLines = (sourceVar, indent = '      ') => {
        const declared = [...capturedVarsDeclared];
        if (declared.length === 0) return `${indent}void ${sourceVar};`;
        return declared
          .map(
            (v) =>
              `${indent}if (typeof ${sourceVar}[${JSON.stringify(v)}] === 'string') ${v} = ${sourceVar}[${JSON.stringify(v)}];`
          )
          .join('\n');
      };

      if (strategy === 'checkpoint-state') {
        extraNodeImports.push("import { restoreCheckpoint } from '@shared/ui/explore-handshake';");
        if (!injectedFixtures.includes('context')) {
          injectedFixtures.push('context');
        }
        if (!injectedFixtures.includes('page')) {
          injectedFixtures.push('page');
        }
        const safeCheckpointRel =
          rf.checkpointPath ||
          `.exploratory/checkpoints/${String(rf.scenarioId || 'point-a').replace(/[^a-z0-9-]/g, '-')}.json`;
        const hydrateBlock = buildHydrationLines('checkpointVars');
        resumesFromPreamble = `    test.info().annotations.push({ type: 'resumesFrom', description: ${JSON.stringify(annotationDesc)} });
    await test.step(${JSON.stringify(`Restore Point-A checkpoint state (${parentLabel})`)}, async () => {
      const checkpointVars = await restoreCheckpoint(context, page, ${JSON.stringify(safeCheckpointRel)});
${hydrateBlock}
    });\n\n`;
      } else if (strategy === 'api-seed') {
        const rawSeedRef = String(rf.seedClientRef || '').trim();
        const parsedSeed = rawSeedRef
          ? parseBuilderRef(rawSeedRef) ||
            (/^[A-Z][A-Za-z0-9_]*$/.test(rawSeedRef)
              ? { builderClass: rawSeedRef, callExpression: `${rawSeedRef}.seed()` }
              : null)
          : null;
        let seedCallStmt = `// Seed prerequisite state for ${parentLabel} via ApiClientContract`;
        if (parsedSeed && parsedSeed.builderClass) {
          const seederDesc = seederImports.get(parsedSeed.builderClass);
          const apiDesc = apiClientImports.get(parsedSeed.builderClass);
          if (seederDesc) {
            if (!injectedFixtures.includes(seederDesc.fixtureProp)) {
              injectedFixtures.push(seederDesc.fixtureProp);
            }
            const declared = [...capturedVarsDeclared];
            if (declared.length > 0) {
              const hydrateLines = declared
                .map(
                  (v) =>
                    `      if (typeof ${seederDesc.fixtureProp}[${JSON.stringify(v)}] === 'string') ${v} = String(${seederDesc.fixtureProp}[${JSON.stringify(v)}]);`
                )
                .join('\n');
              seedCallStmt = `// Isolated state seeded via ${parsedSeed.builderClass} fixture with auto-teardown\n${hydrateLines}`;
            } else {
              seedCallStmt = `void ${seederDesc.fixtureProp}; // Isolated state seeded via ${parsedSeed.builderClass} fixture with auto-teardown`;
            }
          } else if (apiDesc) {
            if (!injectedFixtures.includes(apiDesc.fixtureProp)) {
              injectedFixtures.push(apiDesc.fixtureProp);
            }
            const methodPart = parsedSeed.callExpression.slice(parsedSeed.builderClass.length + 1);
            const methodNameOnly = methodPart.split('(')[0].trim();
            const existingApiMeta = existingClasses.get(parsedSeed.builderClass);
            if (existingApiMeta && existingApiMeta.members.has(methodNameOnly)) {
              seedCallStmt = `await ${apiDesc.fixtureProp}.${methodPart};`;
            } else {
              seedCallStmt = `await ${apiDesc.fixtureProp}.executeRequest('/api/v1/seed');`;
            }
          } else {
            seedCallStmt = `await ${parsedSeed.callExpression};`;
          }
        }
        resumesFromPreamble = `    test.info().annotations.push({ type: 'resumesFrom', description: ${JSON.stringify(annotationDesc)} });
    await test.step(${JSON.stringify(`Seed Point-A prerequisite state via API (${parentLabel})`)}, async () => {
      ${seedCallStmt}
    });\n\n`;
      } else {
        const flowDesc = [...flowImports.values()][0] || null;
        let flowCallBlock = `      // Prerequisite spec: ${sanitizeCodeComment(rf.specFile || rf.scenarioId || 'point-a')}`;
        if (flowDesc) {
          if (!injectedFixtures.includes(flowDesc.fixtureProp)) {
            injectedFixtures.push(flowDesc.fixtureProp);
          }
          const hydrateBlock = buildHydrationLines('prereqVars');
          flowCallBlock = `      const prereqVars = await ${flowDesc.fixtureProp}.execute();\n${hydrateBlock}`;
        }
        resumesFromPreamble = `    test.info().annotations.push({ type: 'resumesFrom', description: ${JSON.stringify(annotationDesc)} });
    await test.step(${JSON.stringify(`Resume from Point-A prerequisite (${parentLabel})`)}, async () => {
${flowCallBlock}
    });\n\n`;
      }
    }

    const personaCall =
      parseBuilderRef(tape.persona?.dataBuilderRef)?.callExpression || null;
    const personaPreamble = personaCall ? `    const persona = ${personaCall};\n    void persona;\n` : '';
    const capturedVarsPreamble = [...capturedVarsDeclared]
      .map((v) => `    let ${v} = '';\n`)
      .join('');
    const sanitizeStepTitle = (rawTitle) =>
      String(rawTitle || 'Execute workflow step')
        .replace(
          /\b(?:click|fill|press|hover|locator|selector|xpath|css|dom|getbyrole|getbylabel|getbytestid|getbyplaceholder|getbytext|input\s+field|button|checkbox|dropdown)\b/gi,
          'feature'
        )
        .replace(/\s+/g, ' ')
        .trim() || 'Execute workflow step';
    const stepBlocks = businessGroups.map((group) => {
      const body = group.statements
        .map((s) => `      ${s.replace(/\n/g, '\n      ')}`)
        .join('\n');
      return `    await test.step(${JSON.stringify(sanitizeStepTitle(group.title))}, async () => {\n${body}\n    });`;
    });

    const specBody = `${personaPreamble}${capturedVarsPreamble}${resumesFromPreamble}${stepBlocks.join('\n\n')}`;
    const usedFixtures = injectedFixtures.filter((f) => new RegExp(`\\b${f}\\b`).test(specBody));
    const finalFixtures = usedFixtures.length > 0 ? usedFixtures : injectedFixtures.slice(0, 1);
    const activeBuilderImportLines = [...builderImports.entries()]
      .filter(([cls]) => new RegExp(`\\b${cls}\\b`).test(specBody))
      .map(([cls, alias]) => `import { ${cls} } from '${alias}';`)
      .join('\n');

    const authStorageState = tape.persona?.storageStatePath || tape.storageStatePath || null;
    const storageStatePreamble = authStorageState
      ? `  test.use({ storageState: ${JSON.stringify(authStorageState)} });\n\n`
      : '';
    const nodeImportsBlock = extraNodeImports.length > 0 ? extraNodeImports.join('\n') + '\n' : '';
    const specCode = `${nodeImportsBlock}import { test, expect } from '${fixtureAlias}';
${activeBuilderImportLines ? activeBuilderImportLines + '\n' : ''}
test.describe(${JSON.stringify(`${tape.title} [${tagsSuffix}] (Compiled from Session Tape: ${scenarioId})`)}, () => {
${storageStatePreamble}  test(${JSON.stringify(`${tape.title} ${tagsSuffix}`)}, async ({ ${finalFixtures.join(', ')} }) => {
${specBody}
  });
});
`;
    plannedOperations.push({
      layer: 'spec',
      action: matchingExistingSpec ? 'overwrite' : 'create',
      file: specRelPath,
      addedMembers: [scenarioId],
      codeContent: specCode,
    });
  }

  // 8. Apply File Operations & Synchronize Domain Shard Published Capabilities
  const assertNoSymlinkWrite = (targetAbs, label) => {
    const resolvedRoot = path.resolve(ROOT);
    const resolvedTarget = path.resolve(targetAbs);
    if (!isWithinDir(resolvedTarget, resolvedRoot)) {
      throw new Error(`Security Error: Refusing to write outside repository workspace: ${label}`);
    }
    let cur = resolvedTarget;
    while (cur !== resolvedRoot) {
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) {
          throw new Error(
            `Security Error: Refusing to write through symbolic link: ${path.relative(resolvedRoot, cur)}`
          );
        }
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
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
        throw new Error(`Security Error: Target realpath escapes repository workspace: ${label}`);
      }
    }
    return resolvedTarget;
  };

  if (apply) {
    for (const op of plannedOperations) {
      if (!op.codeContent) continue;
      const absTarget = assertNoSymlinkWrite(path.resolve(ROOT, op.file), op.file);
      fs.mkdirSync(path.dirname(absTarget), { recursive: true });
      fs.writeFileSync(absTarget, op.codeContent, 'utf8');
    }

    // Seed shard if missing, then synchronize **Published Capabilities:** in matching shard
    const seeded = seedShardsFromTapes({ rootDir: ROOT });
    const updatedGraph =
      seeded.length > 0 ? buildDomainGraph({ rootDir: ROOT, writeToDisk: false }) : domainGraph;
    const matchingShard = updatedGraph.shards.find(
      (s) => s.id === scenarioId || (resolvedSquad && s.squad === resolvedSquad)
    );
    if (matchingShard && publishedCapabilities.size > 0) {
      const shardFullPath = assertNoSymlinkWrite(path.join(ROOT, matchingShard.path), matchingShard.path);
      if (fs.existsSync(shardFullPath)) {
        let shardText = fs.readFileSync(shardFullPath, 'utf8');
        const mergedCaps = [
          ...new Set([...(matchingShard.publishedCapabilities || []), ...publishedCapabilities]),
        ];
        const capLine = `- **Published Capabilities:** ${mergedCaps.map((c) => `\`${c}\``).join(', ')}`;
        if (/\*\*Published Capabilities:\*\*/i.test(shardText)) {
          shardText = shardText.replace(/^.*?\*\*Published Capabilities:\*\*.*$/im, () => capLine);
        } else if (/\*\*Last Verified:\*\*/i.test(shardText)) {
          shardText = shardText.replace(
            /(^.*?\*\*Last Verified:\*\*.*$)/im,
            (_, m1) => `${m1}\n${capLine}`
          );
        }
        fs.writeFileSync(shardFullPath, shardText, 'utf8');
      }
    }
    if (!deferGraphRefresh) {
      buildDomainGraph({ rootDir: ROOT, writeToDisk: true });
      if (!skipMap && path.resolve(ROOT) === path.resolve(process.cwd())) {
        try {
          buildSystemMap({ quiet: true });
        } catch {
          /* non-fatal */
        }
      }
    }
  }

  return {
    mode: apply ? 'applied' : 'dry-run',
    scenarioId,
    sourceTape: rel(tapePath),
    charter: tape.charter,
    emitSeeder: Boolean(emitSeeder),
    targetLayout: resolvedSquad ? `federated-squad (${resolvedSquad})` : 'global-flat (src/)',
    squad: resolvedSquad,
    publishedCapabilities: [...publishedCapabilities],
    warnings,
    operations: plannedOperations.map(({ codeContent, ...summary }) => summary),
  };
  } finally {
    ROOT = prevRoot;
    TAPES_DIR = prevTapesDir;
  }
}

export function finalizeBatchDomainRefresh(rootDir = process.cwd(), { skipMap = false } = {}) {
  const graph = buildDomainGraph({ rootDir, writeToDisk: true });
  if (!skipMap && path.resolve(rootDir) === path.resolve(process.cwd())) {
    try {
      buildSystemMap({ quiet: true });
    } catch {
      /* non-fatal */
    }
  }
  return graph;
}

export function formatCompactCompileReport(report) {
  const ops = Array.isArray(report.operations) ? report.operations : [];
  const created = ops.filter((f) => f.action === 'create').map((f) => f.file || f.path);
  const updated = ops
    .filter((f) => f.action === 'update' || f.action === 'extend-existing' || f.action === 'overwrite')
    .map((f) => f.file || f.path);
  const reused = ops
    .filter((f) => f.action === 'reuse' || f.action === 'reuse-existing' || f.action === 'skip')
    .map((f) => f.file || f.path);
  const lines = [
    `COMPILE | ${String(report.mode || 'dry-run').toUpperCase()} | scenario=${report.scenarioId} | layout=${report.targetLayout || 'global-flat'}`,
    `FILES   | create=${created.length} update=${updated.length} reuse=${reused.length}${report.warnings?.length ? ` warnings=${report.warnings.length}` : ''}`,
  ];
  if (created.length) lines.push(`CREATE  | ${created.join(', ')}`);
  if (updated.length) lines.push(`UPDATE  | ${updated.join(', ')}`);
  if (reused.length) lines.push(`REUSE   | ${reused.slice(0, 6).join(', ')}${reused.length > 6 ? ` (+${reused.length - 6})` : ''}`);
  lines.push(
    report.mode === 'applied'
      ? `NEXT    | npm run verify:fast`
      : `NEXT    | npx cortex compile ${report.scenarioId}${report.emitSeeder ? ' --emit-seeder' : ''} --apply --compact`
  );
  return lines.join('\n');
}

const isMain =
  Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
⚙️  Cortex Deterministic Session-Tape-to-SOLID Compiler (compile-tape.mjs)

Usage:
  npx cortex compile [<scenario-id-or-tape-path>] [--squad <squad>] [--apply] [--force-spec] [--skip-map] [--compact|--verbose|--json]
  npm run compile:tape -- [<scenario-id-or-tape-path>] [--squad <squad>] [--apply] [--skip-map]
`);
    process.exit(0);
  }

  let tapeInput = '';
  let squadOverride = '';
  let apply = false;
  let forceSpec = false;
  let emitSeeder = false;
  let skipMap = false;
  let jsonOut = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') {
      apply = true;
    } else if (a === '--force-spec') {
      forceSpec = true;
    } else if (a === '--emit-seeder') {
      emitSeeder = true;
    } else if (a === '--skip-map') {
      skipMap = true;
    } else if (a === '--json') {
      jsonOut = true;
    } else if (a === '--compact' || a === '--verbose' || a === '--full') {
      /* handled by isCompactMode */
    } else if (a === '--squad' && args[i + 1]) {
      squadOverride = args[++i];
    } else if (a.startsWith('--squad=')) {
      squadOverride = a.slice('--squad='.length);
    } else if (!a.startsWith('-') && !tapeInput) {
      tapeInput = a;
    }
  }

  try {
    const report = compileSessionTape({
      tapeInput,
      squadOverride,
      apply,
      forceSpec,
      emitSeeder,
      skipMap,
    });
    const compact = !jsonOut && isCompactMode(args, { autoNonTty: false });
    if (jsonOut) {
      console.log(JSON.stringify(report, null, 2));
    } else if (compact) {
      console.log(formatCompactCompileReport(report));
    } else {
      console.log(
        `\n⚙️  Agentic-SOLID-QE Tape Compiler (${report.mode.toUpperCase()}) — Scenario: ${report.scenarioId}\n`
      );
      console.log(JSON.stringify(report, null, 2));
      if (!apply) {
        console.log(
          `\n💡 Dry-run complete. Re-run with '--apply' (e.g., 'npx cortex compile ${report.scenarioId} --apply') to write SOLID TypeScript files.\n`
        );
      } else {
        console.log(
          `\n✅ Compiled '${report.scenarioId}' into SOLID TypeScript! Run 'npm run verify:fast' (or 'npm run verify') to validate typecheck, domain:graph, audit:solid, and tests.\n`
        );
      }
    }
  } catch (err) {
    console.error(`❌ Tape Compilation Error: ${err.message}`);
    process.exit(1);
  }
}
