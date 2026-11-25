#!/usr/bin/env node
/**
 * Fixture-Aware Reverse-Dependency & Blast-Radius Graph (`npx cortex impact`).
 *
 * Prevents knock-on regressions on shared SOLID modules by tracing:
 *   1. Direct TypeScript / alias imports across `src/` and `tests/`
 *   2. Playwright fixture bindings (`export interface *Fixtures`, `base.extend<>()`, `mergeTests()`)
 *      so editing `CheckoutPage` only flags specs that actually destructure `{ checkoutPage }`
 *      rather than causing a false-positive explosion through `app.fixture.ts`
 *   3. `{ auto: true }` fixtures (which genuinely impact every spec importing that fixture file)
 *
 * Zero external runtime dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isCompactMode } from './lib/cli-output.mjs';

const __filename = fileURLToPath(import.meta.url);
const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_SHARED_FAN_IN = 3;
const DEFAULT_MAX_FAST_SPECS = 10;

const DEFAULT_PATH_ALIASES = {
  '@contracts/*': ['src/contracts/*'],
  '@components/*': ['src/components/*'],
  '@pages/*': ['src/pages/*'],
  '@flows/*': ['src/flows/*'],
  '@fixtures/*': ['src/fixtures/*'],
  '@data/*': ['src/data/*'],
  '@domains/*': ['src/domains/*'],
  '@shared/*': ['src/shared/*'],
};

function normalizeRel(rootDir, filePath) {
  return path.relative(rootDir, filePath).replace(/\\/g, '/');
}

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

export function stripComments(code) {
  const src = String(code || '');
  let out = '';
  let i = 0;
  const templateBraceStack = [];
  let canStartRegex = true;

  const readTemplateContent = () => {
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\') {
        out += ch + (src[i + 1] || '');
        i += 2;
        continue;
      }
      if (ch === '`') {
        out += '`';
        i++;
        canStartRegex = false;
        return;
      }
      if (ch === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        templateBraceStack.push(0);
        canStartRegex = true;
        return;
      }
      out += ch;
      i++;
    }
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r' && src[i] !== '\u2028' && src[i] !== '\u2029') {
        i++;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      if (i < src.length) i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < src.length) {
        const sc = src[i];
        out += sc;
        i++;
        if (sc === '\\' && i < src.length) {
          out += src[i];
          i++;
          continue;
        }
        if (sc === quote || sc === '\n' || sc === '\r') break;
      }
      canStartRegex = false;
      continue;
    }

    if (ch === '`') {
      out += '`';
      i++;
      readTemplateContent();
      continue;
    }

    if (ch === '/' && canStartRegex && next !== '/' && next !== '*') {
      let j = i + 1;
      let inCharClass = false;
      let validRegex = false;
      while (j < src.length) {
        const rc = src[j];
        if (rc === '\n' || rc === '\r' || rc === '\u2028' || rc === '\u2029') break;
        if (rc === '\\') {
          j += 2;
          continue;
        }
        if (rc === '[') inCharClass = true;
        else if (rc === ']') inCharClass = false;
        else if (rc === '/' && !inCharClass) {
          validRegex = true;
          j++;
          while (j < src.length && /[gimsuyv]/.test(src[j])) j++;
          break;
        }
        j++;
      }
      if (validRegex) {
        out += src.slice(i, j);
        i = j;
        canStartRegex = false;
        continue;
      }
    }

    if (ch === '{') {
      if (templateBraceStack.length > 0) {
        templateBraceStack[templateBraceStack.length - 1]++;
      }
      out += ch;
      i++;
      canStartRegex = true;
      continue;
    }

    if (ch === '}') {
      if (templateBraceStack.length > 0) {
        if (templateBraceStack[templateBraceStack.length - 1] === 0) {
          templateBraceStack.pop();
          out += '}';
          i++;
          readTemplateContent();
          continue;
        }
        templateBraceStack[templateBraceStack.length - 1]--;
      }
      out += ch;
      i++;
      canStartRegex = false;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let start = i;
      i++;
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i++;
      const word = src.slice(start, i);
      out += word;
      canStartRegex = /^(?:return|typeof|void|case|throw|delete|in|of|instanceof|new|await|yield)$/.test(word);
      continue;
    }

    if (/\d/.test(ch)) {
      out += ch;
      i++;
      canStartRegex = false;
      continue;
    }

    if (!/\s/.test(ch)) {
      canStartRegex = ch !== ')' && ch !== ']';
    }
    out += ch;
    i++;
  }
  return out;
}

function walkTsFiles(dir) {
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
      if (['node_modules', '.git', 'dist', 'test-results', 'playwright-report'].includes(entry.name)) {
        continue;
      }
      out.push(...walkTsFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      try {
        const st = fs.lstatSync(full);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) out.push(full);
      } catch {
        /* skip */
      }
    }
  }
  return out.sort();
}

export function loadTsPathAliases(rootDir) {
  const tsconfigPath = path.join(rootDir, 'tsconfig.json');
  const raw = readTextSafe(tsconfigPath);
  if (!raw) return { ...DEFAULT_PATH_ALIASES };
  try {
    const cleaned = stripComments(raw).replace(/,\s*([}\]])/g, '$1');
    const parsed = JSON.parse(cleaned);
    const paths = parsed?.compilerOptions?.paths;
    if (paths && typeof paths === 'object') {
      return { ...DEFAULT_PATH_ALIASES, ...paths };
    }
  } catch {
    /* fallback to defaults */
  }
  return { ...DEFAULT_PATH_ALIASES };
}

function tryResolveTsFile(candidateBase, rootDir) {
  const candidates = [
    candidateBase,
    `${candidateBase}.ts`,
    `${candidateBase}.tsx`,
    path.join(candidateBase, 'index.ts'),
  ];
  for (const c of candidates) {
    if (c.endsWith('.js')) {
      const asTs = c.slice(0, -3) + '.ts';
      if (isWithinDir(asTs, rootDir) && fs.existsSync(asTs) && fs.statSync(asTs).isFile()) {
        return normalizeRel(rootDir, asTs);
      }
    }
    if (isWithinDir(c, rootDir) && fs.existsSync(c) && fs.statSync(c).isFile()) {
      return normalizeRel(rootDir, c);
    }
  }
  return null;
}

export function resolveTsImport(fromFileAbs, specifier, rootDir, pathAliases) {
  const spec = String(specifier || '').trim();
  if (!spec) return null;

  if (spec.startsWith('./') || spec.startsWith('../')) {
    const base = path.resolve(path.dirname(fromFileAbs), spec);
    return tryResolveTsFile(base, rootDir);
  }

  for (const [pattern, targets] of Object.entries(pathAliases || DEFAULT_PATH_ALIASES)) {
    const targetList = Array.isArray(targets) ? targets : [targets];
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
      if (spec.startsWith(prefix)) {
        const rest = spec.slice(prefix.length);
        for (const t of targetList) {
          const targetPrefix = String(t).replace(/\*$/, '');
          const base = path.resolve(rootDir, targetPrefix + rest);
          const resolved = tryResolveTsFile(base, rootDir);
          if (resolved) return resolved;
        }
      }
    } else if (spec === pattern) {
      for (const t of targetList) {
        const base = path.resolve(rootDir, String(t));
        const resolved = tryResolveTsFile(base, rootDir);
        if (resolved) return resolved;
      }
    }
  }

  return null;
}

/**
 * Extracts import statements and their imported local identifiers.
 * Returns array of { specifier, resolvedRel, symbols: string[] }.
 */
export function parseImports(fileAbs, codeNoComments, rootDir, pathAliases) {
  const results = [];
  const importRe =
    /(?:\bimport\s+(?:type\s+)?(?:([^;'"]+?)\s+from\s+)?|\bexport\s+(?:type\s+)?(\*(?:\s+as\s+[A-Za-z_$][A-Za-z0-9_$]*)?|\{[^};]*\})\s+from\s+)['"]([^'"]+)['"]/g;
  for (const m of codeNoComments.matchAll(importRe)) {
    const clause = (m[1] || m[2] || '').trim();
    const specifier = m[3];
    const resolvedRel = resolveTsImport(fileAbs, specifier, rootDir, pathAliases);
    if (!resolvedRel) continue;

    const symbols = [];
    if (clause) {
      // Named imports: { Foo, Bar as Baz, type Qux }
      const braceMatch = clause.match(/\{([\s\S]*?)\}/);
      if (braceMatch) {
        for (const part of braceMatch[1].split(',')) {
          const cleaned = part.replace(/^\s*type\s+/, '').trim();
          if (!cleaned) continue;
          const asParts = cleaned.split(/\s+as\s+/);
          const localName = (asParts[1] || asParts[0]).trim();
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(localName)) symbols.push(localName);
        }
      }
      // Namespace import: * as Foo
      const nsMatch = clause.match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (nsMatch) symbols.push(nsMatch[1]);
      // Default import: Foo or Foo, { ... }
      const beforeCommaOrBrace = clause.split(/[,{]/)[0].trim();
      if (
        beforeCommaOrBrace &&
        !beforeCommaOrBrace.startsWith('*') &&
        /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(beforeCommaOrBrace)
      ) {
        symbols.push(beforeCommaOrBrace);
      }
    }

    results.push({ specifier, resolvedRel, symbols });
  }
  return results;
}

function isFixtureFile(relPath) {
  return (
    relPath.endsWith('.fixture.ts') ||
    relPath.startsWith('src/fixtures/') ||
    /\/fixtures\/[^/]+\.ts$/.test(relPath)
  );
}

/**
 * Extracts balanced brace body starting at openBraceIdx (`{`).
 */
function extractBraceBlock(code, openBraceIdx) {
  if (openBraceIdx < 0 || code[openBraceIdx] !== '{') return '';
  let depth = 0;
  let quote = null;
  for (let i = openBraceIdx; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return code.slice(openBraceIdx + 1, i);
    }
  }
  return code.slice(openBraceIdx + 1);
}

/**
 * Finds the opening `{` of `.extend<...>({` supporting arbitrarily nested generics and arrow types.
 */
function findExtendObjectStart(code, extendEndIdx) {
  let i = extendEndIdx;
  while (i < code.length && /\s/.test(code[i])) i++;
  if (code[i] === '<') {
    let angle = 0;
    let quote = null;
    while (i < code.length) {
      const ch = code[i];
      if (quote) {
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i++;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        i++;
        continue;
      }
      if (ch === '=' && code[i + 1] === '>') {
        i += 2;
        continue;
      }
      if (ch === '<') angle++;
      else if (ch === '>') {
        angle--;
        if (angle === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    while (i < code.length && /\s/.test(code[i])) i++;
  }
  if (code[i] !== '(') return -1;
  i++;
  while (i < code.length && /\s/.test(code[i])) i++;
  return code[i] === '{' ? i : -1;
}

/**
 * Parses a Playwright fixture file to map:
 *   - Named fixture properties (e.g. `checkoutPage` -> `src/pages/checkout.page.ts`)
 *   - `{ auto: true }` fixtures and their imported dependencies (affect ALL specs using the fixture)
 *   - `mergeTests(a, b)` composed fixture files
 */
function parseFixtureFile(relPath, codeNoComments, imports) {
  const symbolToFile = new Map();
  const mergedFrom = new Set();
  for (const imp of imports) {
    for (const sym of imp.symbols) {
      symbolToFile.set(sym, imp.resolvedRel);
    }
    if (isFixtureFile(imp.resolvedRel)) {
      mergedFrom.add(imp.resolvedRel);
    }
  }

  const props = new Map(); // propName -> Set<targetRelFile>
  const propFixtureDeps = new Map(); // propName -> Set<siblingFixtureName>
  const autoDeps = new Set();
  const autoPropNames = new Set();

  const addPropDep = (propName, targetFile) => {
    if (!props.has(propName)) props.set(propName, new Set());
    props.get(propName).add(targetFile);
  };
  const addPropFixtureDep = (propName, depFixtureName) => {
    if (!depFixtureName || depFixtureName === propName) return;
    if (!propFixtureDeps.has(propName)) propFixtureDeps.set(propName, new Set());
    propFixtureDeps.get(propName).add(depFixtureName);
  };

  // 1. Parse fixture interfaces / type aliases: `interface AppFixtures { loginPage: LoginPage; }`
  for (const m of codeNoComments.matchAll(
    /\b(?:interface|type)\s+[A-Za-z0-9_]*Fixtures[A-Za-z0-9_]*\s*(?:=\s*)?\{/g
  )) {
    const openIdx = m.index + m[0].length - 1;
    const body = extractBraceBlock(codeNoComments, openIdx);
    for (const propMatch of body.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:\s*([^;\n,]+)/g)) {
      const propName = propMatch[1];
      const typeExpr = propMatch[2];
      for (const idMatch of typeExpr.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
        const target = symbolToFile.get(idMatch[1]);
        if (target && !isFixtureFile(target)) {
          addPropDep(propName, target);
        }
      }
    }
  }

  // 2. Parse `.extend<...>({ ... })` blocks to capture factory dependencies & `{ auto: true }`
  for (const m of codeNoComments.matchAll(/\.extend\b/g)) {
    const openIdx = findExtendObjectStart(codeNoComments, m.index + m[0].length);
    if (openIdx < 0) continue;
    const body = extractBraceBlock(codeNoComments, openIdx);

    // Walk top-level properties inside extend({ ... })
    let idx = 0;
    while (idx < body.length) {
      // Skip whitespace/commas
      while (idx < body.length && /[\s,]/.test(body[idx])) idx++;
      const propMatch = body.slice(idx).match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
      if (!propMatch) {
        idx++;
        continue;
      }
      const propName = propMatch[1];
      idx += propMatch[0].length;
      const valueStart = idx;

      // Scan until top-level comma or end of extend object (skipping string literals)
      let depthParen = 0;
      let depthBrace = 0;
      let depthBracket = 0;
      let quote = null;
      while (idx < body.length) {
        const ch = body[idx];
        if (quote) {
          if (ch === '\\') {
            idx += 2;
            continue;
          }
          if (ch === quote) quote = null;
          idx++;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
          quote = ch;
          idx++;
          continue;
        }
        if (ch === '(') depthParen++;
        else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
        else if (ch === '{') depthBrace++;
        else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
        else if (ch === '[') depthBracket++;
        else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
        else if (ch === ',' && depthParen === 0 && depthBrace === 0 && depthBracket === 0) {
          break;
        }
        idx++;
      }

      const propBody = body.slice(valueStart, idx);
      const isAuto = /auto\s*:\s*true/.test(propBody);
      if (isAuto) autoPropNames.add(propName);

      // Capture fixture-to-fixture destructured dependencies: async ({ page, loginPage }, use) => ...
      const destructMatch = propBody.match(/\(\s*\{([^}]*)\}/);
      if (destructMatch) {
        for (const rawPart of destructMatch[1].split(',')) {
          const clean = rawPart.trim().split(/[:=]/)[0].trim();
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(clean) && !['page', 'context', 'browser', 'request', 'baseURL'].includes(clean)) {
            addPropFixtureDep(propName, clean);
          }
        }
      }

      for (const idMatch of propBody.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
        const target = symbolToFile.get(idMatch[1]);
        if (target && !isFixtureFile(target)) {
          if (isAuto) {
            autoDeps.add(target);
          } else {
            addPropDep(propName, target);
          }
        }
      }
    }
  }

  // 3. Any imported non-fixture file referenced outside extend() (e.g., top-level hooks) counts as autoDeps
  const referencedInNamedProps = new Set();
  for (const depSet of props.values()) {
    for (const d of depSet) referencedInNamedProps.add(d);
  }
  for (const imp of imports) {
    if (!isFixtureFile(imp.resolvedRel) && !referencedInNamedProps.has(imp.resolvedRel)) {
      autoDeps.add(imp.resolvedRel);
    }
  }

  return {
    relPath,
    props,
    propFixtureDeps,
    autoDeps,
    autoPropNames,
    mergedFrom,
  };
}

/**
 * Extracts Playwright fixture names destructured by tests/hooks in a spec file:
 *   `test('...', async ({ loginPage, inventoryPage }) => ...)`
 *   `test.beforeEach(async ({ loginPage }) => ...)`
 */
export function extractSpecUsedFixtures(codeNoComments) {
  const used = new Set();
  // NB: the span between `test(` and `async ({ ... })` is matched as plain
  // characters or whole string literals, so `{...}` / `;` inside a test
  // title (e.g. 'Verify GET /orders/{id} returns 200') cannot break the
  // match and trigger the all-fixtures fallback in buildImpactGraph (#64).
  const fnRe =
    /\b(?:test(?:\.(?:only|skip|fixme|fail|beforeEach|afterEach|beforeAll|afterAll))?)\s*\((?:[^;{'\"`]|'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`){0,600}?async\s*\(\s*\{([^}]{0,500})\}/g;
  for (const m of codeNoComments.matchAll(fnRe)) {
    const destructured = m[1];
    for (const part of destructured.split(',')) {
      const cleaned = part.trim().split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cleaned)) {
        used.add(cleaned);
      }
    }
  }
  return used;
}

export function extractSpecTags(codeNoComments) {
  const tags = new Set();
  for (const m of codeNoComments.matchAll(/@(p0|p1|p2|smoke|regression|api-contract)\b/gi)) {
    tags.add(`@${m[1].toLowerCase()}`);
  }
  return [...tags].sort();
}

export function inferSquadFromPath(relPath) {
  const domMatch = relPath.match(/^src\/domains\/([a-z0-9-]+)\//i);
  if (domMatch) return domMatch[1].toLowerCase();
  const testSquadMatch = relPath.match(/^tests\/([a-z0-9-]+)\/.+\.spec\.ts$/i);
  if (testSquadMatch) return testSquadMatch[1].toLowerCase();
  if (relPath.startsWith('src/shared/')) return 'shared';
  return 'root';
}

/**
 * Builds the full fixture-aware forward & reverse dependency graph for the workspace.
 */
export function buildImpactGraph(rootDir = process.cwd()) {
  const resolvedRoot = path.resolve(rootDir);
  const pathAliases = loadTsPathAliases(resolvedRoot);

  const srcFiles = walkTsFiles(path.join(resolvedRoot, 'src'));
  const testFiles = walkTsFiles(path.join(resolvedRoot, 'tests'));
  const allFiles = [...srcFiles, ...testFiles];

  const fileImports = new Map(); // relPath -> parsed imports[]
  const fixtureMeta = new Map(); // fixtureRel -> parsed fixture metadata
  const specMeta = new Map(); // specRel -> { tags, squad, usedFixtures, directDeps }
  const forwardDeps = new Map(); // relPath -> Set<depRelPath> (non-spec TS files)

  for (const absFile of allFiles) {
    const relPath = normalizeRel(resolvedRoot, absFile);
    const codeNoComments = stripComments(readTextSafe(absFile));
    const imports = parseImports(absFile, codeNoComments, resolvedRoot, pathAliases);
    fileImports.set(relPath, imports);

    if (isFixtureFile(relPath)) {
      fixtureMeta.set(relPath, parseFixtureFile(relPath, codeNoComments, imports));
    } else if (relPath.startsWith('tests/') && relPath.endsWith('.spec.ts')) {
      specMeta.set(relPath, {
        relPath,
        tags: extractSpecTags(codeNoComments),
        squad: inferSquadFromPath(relPath),
        usedFixtures: extractSpecUsedFixtures(codeNoComments),
        importedFixtures: imports.filter((i) => isFixtureFile(i.resolvedRel)).map((i) => i.resolvedRel),
        directNonFixtureDeps: imports.filter((i) => !isFixtureFile(i.resolvedRel)).map((i) => i.resolvedRel),
      });
    } else {
      forwardDeps.set(relPath, new Set(imports.map((i) => i.resolvedRel)));
    }
  }

  // Resolve transitive merged fixture properties & autoDeps
  const resolvedFixtureCache = new Map();
  const getResolvedFixture = (fixRel, visiting = new Set()) => {
    if (resolvedFixtureCache.has(fixRel)) return resolvedFixtureCache.get(fixRel);
    const meta = fixtureMeta.get(fixRel);
    const props = new Map();
    const propFixtureDeps = new Map();
    const autoDeps = new Set();
    const autoPropNames = new Set();
    if (!meta || visiting.has(fixRel)) return { props, propFixtureDeps, autoDeps, autoPropNames };
    visiting.add(fixRel);

    for (const [k, v] of meta.props.entries()) {
      props.set(k, new Set(v));
    }
    for (const [k, v] of (meta.propFixtureDeps || new Map()).entries()) {
      propFixtureDeps.set(k, new Set(v));
    }
    for (const d of meta.autoDeps) autoDeps.add(d);
    for (const ap of meta.autoPropNames || []) autoPropNames.add(ap);

    for (const parentFix of meta.mergedFrom) {
      const parentRes = getResolvedFixture(parentFix, visiting);
      for (const [k, v] of parentRes.props.entries()) {
        if (!props.has(k)) props.set(k, new Set());
        for (const dep of v) props.get(k).add(dep);
      }
      for (const [k, v] of (parentRes.propFixtureDeps || new Map()).entries()) {
        if (!propFixtureDeps.has(k)) propFixtureDeps.set(k, new Set());
        for (const dep of v) propFixtureDeps.get(k).add(dep);
      }
      for (const d of parentRes.autoDeps) autoDeps.add(d);
      for (const ap of parentRes.autoPropNames || []) autoPropNames.add(ap);
    }

    // Transitively propagate fixture-to-fixture dependencies (e.g., checkoutPage -> loginPage)
    for (const [propName] of propFixtureDeps.entries()) {
      const seenProps = new Set([propName]);
      const queue = [...(propFixtureDeps.get(propName) || [])];
      while (queue.length > 0) {
        const depProp = queue.shift();
        if (seenProps.has(depProp)) continue;
        seenProps.add(depProp);
        const targetFiles = props.get(depProp);
        if (targetFiles) {
          if (!props.has(propName)) props.set(propName, new Set());
          for (const tf of targetFiles) props.get(propName).add(tf);
        }
        const nested = propFixtureDeps.get(depProp);
        if (nested) {
          for (const np of nested) {
            if (!seenProps.has(np)) queue.push(np);
          }
        }
      }
    }

    // Any { auto: true } fixture that depends on sibling fixtures propagates those deps to autoDeps
    for (const autoProp of autoPropNames) {
      const autoPropTargets = props.get(autoProp);
      if (autoPropTargets) {
        for (const tf of autoPropTargets) autoDeps.add(tf);
      }
    }

    const res = { props, propFixtureDeps, autoDeps, autoPropNames };
    resolvedFixtureCache.set(fixRel, res);
    return res;
  };

  // Compute transitive src dependencies of any src file
  const getTransitiveDeps = (startRel, initialDeps = null) => {
    const visited = new Set();
    const queue = initialDeps ? [...initialDeps] : [...(forwardDeps.get(startRel) || [])];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      const next = forwardDeps.get(cur);
      if (next) {
        for (const n of next) {
          if (!visited.has(n)) queue.push(n);
        }
      }
    }
    return visited;
  };

  // Build reverse maps: file -> Set<affectedSpecs>, file -> Set<directConsumers>
  const reverseSpecMap = new Map(); // any src/fixture file -> Set<specRel>
  const directConsumers = new Map(); // any src file -> Set<consumerRel>
  const autoFixtureDepsAll = new Set();

  const addReverseSpec = (fileRel, specRel) => {
    if (!reverseSpecMap.has(fileRel)) reverseSpecMap.set(fileRel, new Set());
    reverseSpecMap.get(fileRel).add(specRel);
  };

  const addDirectConsumer = (targetRel, consumerRel) => {
    if (!directConsumers.has(targetRel)) directConsumers.set(targetRel, new Set());
    directConsumers.get(targetRel).add(consumerRel);
  };

  for (const [consumer, deps] of forwardDeps.entries()) {
    for (const dep of deps) addDirectConsumer(dep, consumer);
  }
  for (const [fixRel, meta] of fixtureMeta.entries()) {
    for (const parentFix of meta.mergedFrom || []) {
      addDirectConsumer(parentFix, fixRel);
    }
    for (const depSet of meta.props.values()) {
      for (const dep of depSet) addDirectConsumer(dep, fixRel);
    }
    for (const dep of meta.autoDeps) {
      addDirectConsumer(dep, fixRel);
      autoFixtureDepsAll.add(dep);
      for (const t of getTransitiveDeps(dep)) autoFixtureDepsAll.add(t);
    }
  }

  const collectMergedFixtures = (fixRel, visited = new Set()) => {
    const meta = fixtureMeta.get(fixRel);
    if (!meta || !meta.mergedFrom) return visited;
    for (const parentFix of meta.mergedFrom) {
      if (!visited.has(parentFix)) {
        visited.add(parentFix);
        collectMergedFixtures(parentFix, visited);
      }
    }
    return visited;
  };

  for (const [specRel, meta] of specMeta.entries()) {
    const rootDeps = new Set(meta.directNonFixtureDeps);
    for (const d of meta.directNonFixtureDeps) addDirectConsumer(d, specRel);

    for (const fixRel of meta.importedFixtures) {
      addReverseSpec(fixRel, specRel);
      addDirectConsumer(fixRel, specRel);
      for (const ancestorFix of collectMergedFixtures(fixRel)) {
        addReverseSpec(ancestorFix, specRel);
      }
      const resolvedFix = getResolvedFixture(fixRel);

      // Auto fixtures always affect every spec using this fixture file
      for (const ad of resolvedFix.autoDeps) rootDeps.add(ad);

      // Only bind the fixture properties actually destructured by this spec
      let matchedAnyProp = false;
      for (const usedProp of meta.usedFixtures) {
        const targets = resolvedFix.props.get(usedProp);
        if (targets) {
          matchedAnyProp = true;
          for (const t of targets) rootDeps.add(t);
        }
      }

      // Fail-safe: if a spec imports a fixture file with bindings but destructures nothing
      // recognizable (e.g., custom wrapper helper), conservatively include all bindings.
      if (!matchedAnyProp && meta.usedFixtures.size === 0 && resolvedFix.props.size > 0) {
        for (const targets of resolvedFix.props.values()) {
          for (const t of targets) rootDeps.add(t);
        }
      }
    }

    const allDepsForSpec = getTransitiveDeps(specRel, rootDeps);
    for (const dep of allDepsForSpec) {
      addReverseSpec(dep, specRel);
    }
  }

  // Build node summaries for all non-spec source/helper/fixture files (src/ and tests/)
  const nodes = Object.create(null);
  for (const absFile of allFiles) {
    const relPath = normalizeRel(resolvedRoot, absFile);
    if (specMeta.has(relPath)) continue;
    const affectedSpecs = [...(reverseSpecMap.get(relPath) || [])].sort();
    const consumers = [...(directConsumers.get(relPath) || [])].sort();
    const squadSet = new Set();
    for (const sp of affectedSpecs) {
      const sq = specMeta.get(sp)?.squad || inferSquadFromPath(sp);
      if (sq && sq !== 'shared') squadSet.add(sq);
    }
    for (const c of consumers) {
      const sq = inferSquadFromPath(c);
      if (sq && sq !== 'shared' && sq !== 'root') squadSet.add(sq);
    }
    const affectedSquads = [...squadSet].sort();
    const fanIn = affectedSpecs.length;
    const isAutoDep = autoFixtureDepsAll.has(relPath);
    const isShared =
      relPath.startsWith('src/shared/') ||
      fanIn >= DEFAULT_SHARED_FAN_IN ||
      affectedSquads.filter((s) => s !== 'root').length >= 2;
    const riskTier =
      isAutoDep || fanIn >= 5 || affectedSquads.filter((s) => s !== 'root').length >= 2
        ? 'high'
        : fanIn >= 2
          ? 'medium'
          : 'low';

    nodes[relPath] = {
      file: relPath,
      squad: inferSquadFromPath(relPath),
      fanIn,
      isShared,
      isAutoFixtureDep: isAutoDep,
      riskTier,
      directConsumers: consumers,
      affectedSpecs,
      affectedSquads,
    };
  }

  const specs = Object.create(null);
  for (const [specRel, meta] of specMeta.entries()) {
    specs[specRel] = {
      file: specRel,
      tags: meta.tags,
      squad: meta.squad,
      usedFixtures: [...meta.usedFixtures].sort(),
    };
  }

  return {
    rootDir: resolvedRoot,
    nodes,
    specs,
    fileImports,
  };
}

export function detectGitChangedFiles(rootDir = process.cwd(), baseRef = '') {
  const files = new Set();
  const runGit = (args) => {
    try {
      const out = execFileSync('git', args, {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of out.split('\n')) {
        const trimmed = line.trim().replace(/\\/g, '/');
        if (trimmed) files.add(trimmed);
      }
    } catch {
      /* not a git repo or ref unavailable */
    }
  };

  if (baseRef) {
    // Reject unsafe ref names (leading dash or shell metacharacters)
    if (!/^[a-zA-Z0-9._/~^-]+$/.test(baseRef) || baseRef.startsWith('-')) {
      throw new Error(`Security Error: Invalid git ref '${baseRef}'.`);
    }
    runGit(['diff', '--name-only', `${baseRef}...HEAD`]);
  }
  runGit(['diff', '--name-only']);
  runGit(['diff', '--name-only', '--cached']);
  runGit(['ls-files', '--others', '--exclude-standard']);

  return [...files]
    .filter((f) => (f.startsWith('src/') || f.startsWith('tests/')) && f.endsWith('.ts'))
    .sort();
}

export function getFileImpact(rootDir, targetFileRel, { graph = null, sharedThreshold = DEFAULT_SHARED_FAN_IN } = {}) {
  const resolvedGraph = graph || buildImpactGraph(rootDir);
  const norm = String(targetFileRel || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');

  if (Object.hasOwn(resolvedGraph.nodes, norm)) {
    const node = resolvedGraph.nodes[norm];
    const nonRootSquads = node.affectedSquads.filter((s) => s !== 'root');
    const isShared =
      norm.startsWith('src/shared/') ||
      node.fanIn >= sharedThreshold ||
      nonRootSquads.length >= 2;
    return { ...node, isShared };
  }

  if (Object.hasOwn(resolvedGraph.specs, norm)) {
    return {
      file: norm,
      squad: resolvedGraph.specs[norm].squad,
      fanIn: 1,
      isShared: false,
      isAutoFixtureDep: false,
      riskTier: 'low',
      directConsumers: [],
      affectedSpecs: [norm],
      affectedSquads: [resolvedGraph.specs[norm].squad],
    };
  }

  return {
    file: norm,
    squad: inferSquadFromPath(norm),
    fanIn: 0,
    isShared: norm.startsWith('src/shared/'),
    isAutoFixtureDep: false,
    riskTier: 'low',
    directConsumers: [],
    affectedSpecs: [],
    affectedSquads: [],
  };
}

export function analyzeImpact(
  rootDir = process.cwd(),
  {
    files = null,
    baseRef = '',
    sharedThreshold = DEFAULT_SHARED_FAN_IN,
    maxFastSpecs = DEFAULT_MAX_FAST_SPECS,
    graph = null,
  } = {}
) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedGraph = graph || buildImpactGraph(resolvedRoot);
  const changedFiles = Array.isArray(files)
    ? [
        ...new Set(
          files
            .map((f) => String(f || '').trim().replace(/\\/g, '/').replace(/^\.\//, ''))
            .filter(Boolean)
        ),
      ].sort()
    : detectGitChangedFiles(resolvedRoot, baseRef);

  const perFile = [];
  const affectedSpecSet = new Set();
  let highestRisk = 'low';
  const riskRank = { low: 0, medium: 1, high: 2 };

  for (const file of changedFiles) {
    const info = getFileImpact(resolvedRoot, file, {
      graph: resolvedGraph,
      sharedThreshold,
    });
    perFile.push(info);
    for (const sp of info.affectedSpecs) affectedSpecSet.add(sp);
    if (riskRank[info.riskTier] > riskRank[highestRisk]) {
      highestRisk = info.riskTier;
    }
  }

  const affectedSpecs = [...affectedSpecSet].sort();
  const affectedSmokeSpecs = affectedSpecs.filter((sp) => {
    const tags = resolvedGraph.specs[sp]?.tags || [];
    return tags.includes('@p0') || tags.includes('@smoke');
  });
  const affectedRegressionSpecs = affectedSpecs.filter((sp) => !affectedSmokeSpecs.includes(sp));

  const exceedsFastCap = affectedSpecs.length > maxFastSpecs;
  const highBlastRadius = exceedsFastCap || highestRisk === 'high';
  const recommendedFastSpecs = !exceedsFastCap
    ? affectedSpecs
    : affectedSmokeSpecs.length > 0
      ? affectedSmokeSpecs.slice(0, maxFastSpecs)
      : affectedSpecs.slice(0, maxFastSpecs);

  return {
    changedFiles,
    perFile,
    affectedSpecs,
    affectedSmokeSpecs,
    affectedRegressionSpecs,
    highestRisk,
    highBlastRadius,
    exceedsFastCap,
    maxFastSpecs,
    recommendedFastSpecs,
    deferredSpecs: affectedSpecs.filter((sp) => !recommendedFastSpecs.includes(sp)),
  };
}

export function formatCompactImpact(result) {
  const lines = [
    `IMPACT | files=${result.changedFiles.length} | specs=${result.affectedSpecs.length} (smoke=${result.affectedSmokeSpecs.length}, reg=${result.affectedRegressionSpecs.length}) | risk=${result.highestRisk}${result.exceedsFastCap ? ` | CAP_EXCEEDED(${result.maxFastSpecs})` : ''}`,
  ];
  for (const f of result.perFile.slice(0, 8)) {
    const badge = f.isShared ? `SHARED fanIn=${f.fanIn}` : `fanIn=${f.fanIn}`;
    const targetList =
      f.affectedSpecs.length > 0
        ? f.affectedSpecs.slice(0, 4).join(', ') +
          (f.affectedSpecs.length > 4 ? ` (+${f.affectedSpecs.length - 4} more)` : '')
        : 'none';
    lines.push(`FILE   | ${f.file} [${badge}] -> ${targetList}`);
  }
  if (result.affectedSpecs.length > 0) {
    lines.push(`SPECS  | ${result.recommendedFastSpecs.join(', ')}`);
  }
  if (result.deferredSpecs.length > 0) {
    lines.push(
      `WARN   | HIGH BLAST RADIUS: ${result.deferredSpecs.length} additional affected spec(s) deferred; run 'npx cortex verify --affected --max-affected ${result.affectedSpecs.length}' or full CI.`
    );
  }
  return lines.join('\n');
}

const isMain =
  Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🕸️  Cortex Fixture-Aware Impact & Blast-Radius Analyzer (npx cortex impact)

Usage:
  npx cortex impact [--files src/a.ts,src/b.ts] [--file <path>] [--base <git-ref>] [--max-fast <N>] [--compact|--json|--specs-only]
`);
    process.exit(0);
  }

  const files = [];
  let baseRef = '';
  let maxFastSpecs = DEFAULT_MAX_FAST_SPECS;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--file' || a === '--files') && args[i + 1]) {
      files.push(...args[++i].split(',').filter(Boolean));
    } else if (a.startsWith('--file=')) {
      files.push(a.slice('--file='.length));
    } else if (a.startsWith('--files=')) {
      files.push(...a.slice('--files='.length).split(',').filter(Boolean));
    } else if (a === '--base' && args[i + 1]) {
      baseRef = args[++i];
    } else if (a.startsWith('--base=')) {
      baseRef = a.slice('--base='.length);
    } else if (a === '--max-fast' && args[i + 1]) {
      maxFastSpecs = Math.max(1, Number(args[++i]) || DEFAULT_MAX_FAST_SPECS);
    } else if (a.startsWith('--max-fast=')) {
      maxFastSpecs = Math.max(1, Number(a.slice('--max-fast='.length)) || DEFAULT_MAX_FAST_SPECS);
    }
  }

  try {
    const res = analyzeImpact(process.cwd(), {
      files: files.length > 0 ? files : null,
      baseRef,
      maxFastSpecs,
    });
    if (args.includes('--json')) {
      console.log(JSON.stringify(res, null, 2));
    } else if (args.includes('--specs-only')) {
      if (res.affectedSpecs.length > 0) console.log(res.affectedSpecs.join(' '));
    } else if (isCompactMode(args)) {
      console.log(formatCompactImpact(res));
    } else {
      console.log(formatCompactImpact(res));
    }
  } catch (err) {
    console.error(`❌ impact error: ${err.message}`);
    process.exit(1);
  }
}
