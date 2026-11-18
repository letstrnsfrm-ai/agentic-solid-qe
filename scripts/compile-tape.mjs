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
import {
  FORBIDDEN_IDENTIFIERS,
  isSafeClassName,
  isSafeMemberRef,
  validateTapeObject,
} from './validate-tapes.mjs';

const ROOT = process.cwd();
const TAPES_DIR = path.join(ROOT, '.exploratory/tapes');
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
function buildLocatorExpression(locatorContract, rootExpr = 'this.root') {
  if (!locatorContract) return `${rootExpr}`;
  const effectiveRoot = locatorContract.iframeSelector
    ? `page.frameLocator(${JSON.stringify(String(locatorContract.iframeSelector))})`
    : locatorContract.portalScope
      ? 'page'
      : rootExpr;
  const strat = locatorContract.strategy;
  const val = JSON.stringify(String(locatorContract.value ?? ''));
  const exact = locatorContract.nameExact !== false;

  if (strat === 'getByRole') {
    const role = JSON.stringify(String(locatorContract.role || 'button'));
    return `${effectiveRoot}.getByRole(${role}, { name: ${val}, exact: ${exact} })`;
  }
  if (strat === 'getByLabel') {
    return `${effectiveRoot}.getByLabel(${val}, { exact: ${exact} })`;
  }
  if (strat === 'getByPlaceholder') {
    return `${effectiveRoot}.getByPlaceholder(${val}, { exact: ${exact} })`;
  }
  if (strat === 'getByText') {
    return `${effectiveRoot}.getByText(${val}, { exact: ${exact} })`;
  }
  if (strat === 'getByTestId') {
    return `${effectiveRoot}.getByTestId(${val})`;
  }
  return `${effectiveRoot}.locator(${val})`;
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
  if (withoutExt.startsWith('src/fixtures/')) return `@fixtures/${withoutExt.slice('src/fixtures/'.length)}`;
  if (withoutExt.startsWith('src/data/')) return `@data/${withoutExt.slice('src/data/'.length)}`;
  if (withoutExt.startsWith('src/domains/')) return `@domains/${withoutExt.slice('src/domains/'.length)}`;
  if (withoutExt.startsWith('src/shared/')) return `@shared/${withoutExt.slice('src/shared/'.length)}`;
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

function inferDefaultValueForProperty(propName, roleHint = 'standard') {
  const lower = String(propName || '').toLowerCase();
  if (lower === 'role') return roleHint;
  if (lower.includes('username')) return 'standard_user';
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
} = {}) {
  const domainGraph = buildDomainGraph({ writeToDisk: true });
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
      return !specContents.some((sc) => sc.includes(id));
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
        propMap.set(parsed.topProperty, inferDefaultValueForProperty(parsed.topProperty, roleHint));
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
    if (state.expectedValueRef && state.assertionType !== 'toHaveStatus') {
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
            baseBuilderContent = baseBuilderContent.replace(
              methodRegex,
              `$1$2${sep}\n${missingPropLines.join('\n')}$3`
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
          injectedMethodsCode.includes('requireEnv(') &&
          !/\bfunction\s+requireEnv\b/.test(baseBuilderContent)
        ) {
          baseBuilderContent = `${REQUIRE_ENV_HELPER_CODE}${baseBuilderContent}`;
        }
        const updatedContent = injectedMethodsCode
          ? baseBuilderContent.replace(/\}\s*$/, `\n${injectedMethodsCode}\n}\n`)
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
    payload?: TPayload
  ): Promise<ApiResponseEnvelope<TResponse>> {
    const url = endpoint.startsWith('http') ? endpoint : \`\${this.baseUrl}\${endpoint}\`;
    const headers = this.storageStatePath
      ? AuthTokenBridge.extractAuthHeaders(this.storageStatePath, { targetOrigin: url })
      : {};
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
    componentStepsMap.get(candidate).push(step);
  }

  // Also inspect expectedStates to ensure any referenced targetProperty exists on the target component
  const expectedPropsBySubProp = new Map(); // subPropName (e.g. 'queue' or 'summary') -> Set(targetProperty)
  for (const state of tape.expectedStates || []) {
    const parts = String(state.targetComponent || '').split('.');
    if (parts.length >= 2) {
      const subProp = parts[1];
      if (!expectedPropsBySubProp.has(subProp)) {
        expectedPropsBySubProp.set(subProp, new Set());
      }
      expectedPropsBySubProp.get(subProp).add(state.targetProperty);
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

    // Map each step to a locator property name
    const stepLocatorProps = new Map(); // propName -> locatorExpr
    for (const s of steps) {
      const propName = deriveLocatorPropertyName(s);
      s.__compiledComponentProp = propNameOnPage;
      s.__compiledLocatorProp = propName;
      stepLocatorProps.set(propName, buildLocatorExpression(s.locatorContract, 'this.root'));
    }

    // Add any expectedState targetProperty that maps to this component's propNameOnPage
    for (const [subProp, propSet] of expectedPropsBySubProp.entries()) {
      if (
        subProp.toLowerCase() === propNameOnPage.toLowerCase() ||
        propNameOnPage.toLowerCase().endsWith(subProp.toLowerCase())
      ) {
        for (const reqProp of propSet) {
          const safeReqProp = assertSafeJsIdentifier(reqProp, 'expectedState targetProperty');
          if (safeReqProp !== 'root' && !stepLocatorProps.has(safeReqProp)) {
            stepLocatorProps.set(
              safeReqProp,
              `this.root.getByTestId(${JSON.stringify(toKebabCase(safeReqProp))})`
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

        updated = updated.replace(/(readonly\s+root\s*:\s*Locator\s*;)/, `$1\n${propDecls}`);
        updated = updated.replace(/(this\.root\s*=\s*[^;]+;)/, `$1\n${propInits}`);

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

      if (isWizardStep) {
        contractImport = `import type { WizardStepContract } from '@contracts/wizard-step.contract';`;
        implementsClause = 'WizardStepContract<Record<string, unknown>>';
        extraMethods = `\n  readonly stepId = ${JSON.stringify(kebabStem)};\n\n  isApplicable(profile: Record<string, unknown>): boolean {\n    return Boolean(profile);\n  }\n\n  async completeStep(_profile: Record<string, unknown>): Promise<void> {\n    // Step actions orchestrated via semantic locators\n  }\n`;
      } else if (isErrorComponent) {
        contractImport = `import type { ErrorBannerContract } from '@contracts/error-banner.contract';`;
        implementsClause = 'ErrorBannerContract';
        if (!stepLocatorProps.has('errorBanner')) {
          extraMethods = `\n  readonly errorBanner: Locator;\n\n  async dismissError(): Promise<void> {\n    await this.errorBanner.click();\n  }\n`;
        } else {
          extraMethods = `\n  async dismissError(): Promise<void> {\n    await this.errorBanner.click();\n  }\n`;
        }
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
${propInits ? propInits + '\n' : ''}  }
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
  const defaultStem = toPascalCase(
    resolvedSquad ? scenarioId.replace(new RegExp(`^${resolvedSquad}-`), '') : scenarioId
  );
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

  async open(routePath = '/'): Promise<void> {
    await this.page.goto(routePath);
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

  if (fs.existsSync(fixtureFullPath)) {
    let fixtureContent = fs.readFileSync(fixtureFullPath, 'utf8');
    const missingEntries = allFixtureEntries.filter(
      (entry) => !new RegExp(`\\b${entry.propName}\\s*:`).test(fixtureContent)
    );
    if (missingEntries.length > 0) {
      const importLines = missingEntries
        .filter((e) => !fixtureContent.includes(`from '${e.importAlias}'`))
        .map((e) => `import { ${e.typeName} } from '${e.importAlias}';`)
        .join('\n');
      if (importLines) {
        fixtureContent = `${importLines}\n${fixtureContent}`;
      }
      const interfaceLines = missingEntries
        .map((e) => `  ${e.propName}: ${e.typeName};`)
        .join('\n');
      fixtureContent = fixtureContent.replace(
        /(export\s+interface\s+[A-Za-z0-9_]+\s*\{)/,
        `$1\n${interfaceLines}`
      );

      const implLines = missingEntries
        .map((e) => {
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
        /(base\.extend<[^>]+>\(\{)/,
        `$1\n${implLines}`
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
    const importLines = allFixtureEntries
      .map((e) => `import { ${e.typeName} } from '${e.importAlias}';`)
      .join('\n');
    const interfaceName = resolvedSquad
      ? `${toPascalCase(resolvedSquad)}Fixtures`
      : 'AppFixtures';
    const interfaceLines = allFixtureEntries
      .map((e) => `  ${e.propName}: ${e.typeName};`)
      .join('\n');
    const implLines = allFixtureEntries
      .map((e) => {
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
  const matchingExistingSpec = existingSpecs.find((sf) =>
    fs.readFileSync(sf, 'utf8').includes(scenarioId)
  );
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
          const lastJsonKey = cv?.jsonPath ? cv.jsonPath.replace(/^data\./, '').split('.').pop() : '';
          if (lastJsonKey) {
            assertSafeJsIdentifier(lastJsonKey, 'jsonPath segment');
          }
          const keyAccessExpr = lastJsonKey ? `?.[${JSON.stringify(lastJsonKey)}] ?? ''` : '';
          stmt = `const ${safeCapVar}Res = await ${apiFix}.executeRequest(${endpointArg}${payloadArg});\n${safeCapVar} = String((${safeCapVar}Res.body as Record<string, unknown>)${keyAccessExpr});`;
        } else {
          stmt = `await ${apiFix}.executeRequest(${endpointArg}${payloadArg});`;
        }
      } else if (step.action === 'goto') {
        const targetRoute = step.locatorContract?.value || step.pageRoute || '/';
        if (primaryPageFixture) {
          groupMatchKeys.add(primaryPageFixture);
          stmt = `await ${primaryPageFixture}.open(${JSON.stringify(targetRoute)});`;
        }
      } else if (primaryPageFixture && step.__compiledComponentProp && step.__compiledLocatorProp) {
        groupMatchKeys.add(primaryPageFixture);
        groupMatchKeys.add(`${primaryPageFixture}.${step.__compiledComponentProp}`);
        const locRef = `${primaryPageFixture}.${step.__compiledComponentProp}.${step.__compiledLocatorProp}`;
        const forceArg = step.locatorContract?.force ? '{ force: true }' : '';
        if (step.action === 'fill') {
          stmt = `await ${locRef}.fill(String(${inputExpr}));`;
        } else if (step.action === 'selectOption') {
          stmt = `await ${locRef}.selectOption(String(${inputExpr}));`;
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
        const stepTitle = step.businessStep
          ? sanitizeCodeComment(step.businessStep)
          : toBusinessStepFallback(step.componentCandidate, step.action);
        const lastGroup = businessGroups[businessGroups.length - 1];
        if (lastGroup && lastGroup.title === stepTitle) {
          lastGroup.statements.push(stmt);
          for (const k of groupMatchKeys) lastGroup.matchKeys.add(k);
        } else {
          businessGroups.push({
            title: stepTitle,
            matchKeys: groupMatchKeys,
            statements: [stmt],
          });
        }
      }
    }

    for (const state of tape.expectedStates || []) {
      if (!isSafeMemberRef(state.targetComponent) || !isSafeMemberRef(state.targetProperty)) {
        throw new Error(
          `Security Error: Unsafe expectedStates target reference '${state.targetComponent}.${state.targetProperty}'.`
        );
      }
      let resolvedTargetComponent = state.targetComponent;
      if (
        primaryPageFixture &&
        !resolvedTargetComponent.includes('.') &&
        !injectedFixtures.includes(resolvedTargetComponent)
      ) {
        const matchedStep = (tape.semanticSteps || []).find(
          (s) =>
            s.__compiledComponentProp &&
            (toCamelCase(s.componentCandidate || '') === resolvedTargetComponent ||
              s.__compiledComponentProp === resolvedTargetComponent)
        );
        if (matchedStep) {
          resolvedTargetComponent = `${primaryPageFixture}.${matchedStep.__compiledComponentProp}`;
        }
      }
      const targetExpr = `${resolvedTargetComponent}.${state.targetProperty}`;
      const parsedExpected = parseBuilderRef(state.expectedValueRef);
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
      } else if (state.assertionType === 'toBeVisible' || state.assertionType === 'toBeHidden') {
        assertStmt = `await expect(${targetExpr}).${state.assertionType}();`;
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
        const targetTitle = sanitizeCodeComment(state.businessStep);
        const existingGroup = [...businessGroups].reverse().find((g) => g.title === targetTitle);
        if (existingGroup) {
          existingGroup.statements.push(assertStmt);
        } else {
          businessGroups.push({
            title: targetTitle,
            matchKeys: new Set(),
            statements: [assertStmt],
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
          matchingGroup.statements.push(assertStmt);
        } else if (businessGroups.length > 0) {
          businessGroups[businessGroups.length - 1].statements.push(assertStmt);
        } else {
          businessGroups.push({
            title: 'Verify expected business outcomes',
            matchKeys: new Set(),
            statements: [assertStmt],
          });
        }
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

      if (strategy === 'checkpoint-state') {
        extraNodeImports.push("import fs from 'node:fs';", "import path from 'node:path';");
        if (!injectedFixtures.includes('context')) {
          injectedFixtures.push('context');
        }
        const safeCheckpointRel =
          rf.checkpointPath ||
          `.exploratory/checkpoints/${String(rf.scenarioId || 'point-a').replace(/[^a-z0-9-]/g, '-')}.json`;
        resumesFromPreamble = `    test.info().annotations.push({ type: 'resumesFrom', description: ${JSON.stringify(annotationDesc)} });
    await test.step(${JSON.stringify(`Restore Point-A checkpoint state (${parentLabel})`)}, async () => {
      const checkpointFile = path.resolve(process.cwd(), ${JSON.stringify(safeCheckpointRel)});
      if (!fs.existsSync(checkpointFile)) {
        throw new Error(${JSON.stringify(`Missing Point-A checkpoint state at ${safeCheckpointRel}. Run the parent spec or 'npm run test:explore' first.`)});
      }
      const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8')) as {
        cookies?: Parameters<typeof context.addCookies>[0];
        variables?: Record<string, string>;
      };
      if (Array.isArray(checkpoint.cookies) && checkpoint.cookies.length > 0) {
        await context.addCookies(checkpoint.cookies);
      }
      void checkpoint.variables;
    });\n\n`;
      } else if (strategy === 'api-seed') {
        const parsedSeed = rf.seedClientRef ? parseBuilderRef(rf.seedClientRef) : null;
        let seedCallStmt = `// Seed prerequisite state for ${parentLabel} via ApiClientContract`;
        if (parsedSeed) {
          const apiDesc = apiClientImports.get(parsedSeed.className);
          if (apiDesc) {
            if (!injectedFixtures.includes(apiDesc.fixtureProp)) {
              injectedFixtures.push(apiDesc.fixtureProp);
            }
            const methodPart = parsedSeed.callExpression.slice(parsedSeed.className.length + 1);
            seedCallStmt = `await ${apiDesc.fixtureProp}.${methodPart};`;
          } else {
            seedCallStmt = `await ${parsedSeed.callExpression};`;
          }
        }
        resumesFromPreamble = `    test.info().annotations.push({ type: 'resumesFrom', description: ${JSON.stringify(annotationDesc)} });
    await test.step(${JSON.stringify(`Seed Point-A prerequisite state via API (${parentLabel})`)}, async () => {
      ${seedCallStmt}
    });\n\n`;
      } else {
        resumesFromPreamble = `    test.info().annotations.push({ type: 'resumesFrom', description: ${JSON.stringify(annotationDesc)} });
    await test.step(${JSON.stringify(`Resume from Point-A prerequisite (${parentLabel})`)}, async () => {
      // Prerequisite spec: ${sanitizeCodeComment(rf.specFile || rf.scenarioId || 'point-a')}
    });\n\n`;
      }
    }

    const personaCall =
      parseBuilderRef(tape.persona?.dataBuilderRef)?.callExpression || null;
    const personaPreamble = personaCall ? `    const persona = ${personaCall};\n    void persona;\n` : '';
    const capturedVarsPreamble = [...capturedVarsDeclared]
      .map((v) => `    let ${v} = '';\n`)
      .join('');
    const stepBlocks = businessGroups.map((group) => {
      const body = group.statements
        .map((s) => `      ${s.replace(/\n/g, '\n      ')}`)
        .join('\n');
      return `    await test.step(${JSON.stringify(group.title)}, async () => {\n${body}\n    });`;
    });

    const specBody = `${personaPreamble}${capturedVarsPreamble}${resumesFromPreamble}${stepBlocks.join('\n\n')}`;
    const usedFixtures = injectedFixtures.filter((f) => new RegExp(`\\b${f}\\b`).test(specBody));
    const finalFixtures = usedFixtures.length > 0 ? usedFixtures : injectedFixtures.slice(0, 1);

    const nodeImportsBlock = extraNodeImports.length > 0 ? extraNodeImports.join('\n') + '\n' : '';
    const specCode = `${nodeImportsBlock}import { test, expect } from '${fixtureAlias}';
${builderImportLines ? builderImportLines + '\n' : ''}
test.describe(${JSON.stringify(`${tape.title} [${tagsSuffix}] (Compiled from Session Tape: ${scenarioId})`)}, () => {
  test(${JSON.stringify(`${tape.title} ${tagsSuffix}`)}, async ({ ${finalFixtures.join(', ')} }) => {
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
  if (apply) {
    for (const op of plannedOperations) {
      if (!op.codeContent) continue;
      const absTarget = path.resolve(ROOT, op.file);
      if (!isWithinDir(absTarget, ROOT)) {
        throw new Error(`Security Error: Refusing to write outside repository workspace: ${op.file}`);
      }
      fs.mkdirSync(path.dirname(absTarget), { recursive: true });
      fs.writeFileSync(absTarget, op.codeContent, 'utf8');
    }

    // Seed shard if missing, then synchronize **Published Capabilities:** in matching shard
    seedShardsFromTapes();
    const updatedGraph = buildDomainGraph({ writeToDisk: false });
    const matchingShard = updatedGraph.shards.find(
      (s) => s.id === scenarioId || (resolvedSquad && s.squad === resolvedSquad)
    );
    if (matchingShard && publishedCapabilities.size > 0) {
      const shardFullPath = path.join(ROOT, matchingShard.path);
      if (fs.existsSync(shardFullPath)) {
        let shardText = fs.readFileSync(shardFullPath, 'utf8');
        const mergedCaps = [
          ...new Set([...(matchingShard.publishedCapabilities || []), ...publishedCapabilities]),
        ];
        const capLine = `- **Published Capabilities:** ${mergedCaps.map((c) => `\`${c}\``).join(', ')}`;
        if (/\*\*Published Capabilities:\*\*/i.test(shardText)) {
          shardText = shardText.replace(/^.*?\*\*Published Capabilities:\*\*.*$/im, capLine);
        } else if (/\*\*Last Verified:\*\*/i.test(shardText)) {
          shardText = shardText.replace(
            /(^.*?\*\*Last Verified:\*\*.*$)/im,
            `$1\n${capLine}`
          );
        }
        fs.writeFileSync(shardFullPath, shardText, 'utf8');
      }
    }
    buildDomainGraph({ writeToDisk: true });
    try {
      buildSystemMap({ quiet: true });
    } catch {
      /* non-fatal */
    }
  }

  return {
    mode: apply ? 'applied' : 'dry-run',
    scenarioId,
    sourceTape: rel(tapePath),
    charter: tape.charter,
    targetLayout: resolvedSquad ? `federated-squad (${resolvedSquad})` : 'global-flat (src/)',
    squad: resolvedSquad,
    publishedCapabilities: [...publishedCapabilities],
    warnings,
    operations: plannedOperations.map(({ codeContent, ...summary }) => summary),
  };
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
  npx cortex compile [<scenario-id-or-tape-path>] [--squad <squad>] [--apply] [--force-spec]
  npm run compile:tape -- [<scenario-id-or-tape-path>] [--squad <squad>] [--apply]
`);
    process.exit(0);
  }

  let tapeInput = '';
  let squadOverride = '';
  let apply = false;
  let forceSpec = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') {
      apply = true;
    } else if (a === '--force-spec') {
      forceSpec = true;
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
    });
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
        `\n✅ Compiled '${report.scenarioId}' into SOLID TypeScript! Run 'npm run verify' to validate typecheck, domain:graph, audit:solid, and tests.\n`
      );
    }
  } catch (err) {
    console.error(`\n❌ Tape Compilation Error: ${err.message}\n`);
    process.exit(1);
  }
}
