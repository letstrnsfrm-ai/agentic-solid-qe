#!/usr/bin/env node
/**
 * Legacy Java & C# (.NET) Selenium + API Test Discovery, Decomposition & Migration Engine.
 *
 * Capabilities:
 *   1. Stack Detection: Detects Maven/Gradle Java and .NET C# repositories.
 *   2. Value-Based Discovery: Scans JUnit/TestNG/NUnit/xUnit/MSTest + Selenium/RestAssured/RestSharp/HttpClient
 *      tests and Page Objects, scoring & ranking them into Migration Waves 1 (Quick Wins), 2 (Medium), 3 (Decompose).
 *   3. Monolith Decomposition: Splits large Wave 3 E2E tests into API seeders, auth fixtures, and atomic UI slices.
 *   4. Intent-to-Tape Bridge: Translates legacy test steps + Page Object locators + API calls into schema-valid
 *      Session Tapes (.exploratory/tapes/<id>.json) ready for live @playwright/cli verification & `compile:tape`.
 *   5. Parity Manifest: Tracks incremental migration state in .agents/domain/migration-manifest.json.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_SCAN_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'bin',
  'obj',
  'build',
  '.gradle',
  '.idea',
  '.vs',
  'e2e-playwright',
  'qe-playwright',
  'playwright-report',
  'test-results',
]);

export const MIGRATION_MANIFEST_REL_PATH = '.agents/domain/migration-manifest.json';

function isWithinDir(targetPath, baseDir) {
  const relPath = path.relative(baseDir, targetPath);
  return relPath === '' || (!relPath.startsWith('..') && !path.isAbsolute(relPath));
}

function readTextSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_SCAN_FILE_BYTES) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function walkSourceFiles(dir, exts) {
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
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkSourceFiles(path.join(dir, entry.name), exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      const full = path.join(dir, entry.name);
      try {
        const st = fs.lstatSync(full);
        if (st.isFile() && st.size <= MAX_SCAN_FILE_BYTES) {
          out.push(full);
        }
      } catch {
        /* skip unreadable */
      }
    }
  }
  return out;
}

function slugifyKebab(raw) {
  return String(raw || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function toPascalCase(raw) {
  const words = String(raw || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return 'LegacyFeature';
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function toCamelCase(raw) {
  const pascal = toPascalCase(raw);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Detect whether a directory is a Java (Maven/Gradle) or C# (.NET) repository root.
 */
export function detectLegacyTestProject(scanRoot) {
  if (!scanRoot || !fs.existsSync(scanRoot)) {
    return { detected: false, stacks: [], buildFiles: [] };
  }
  const stacks = new Set();
  const buildFiles = [];

  for (const marker of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    if (fs.existsSync(path.join(scanRoot, marker))) {
      stacks.add('java');
      buildFiles.push(marker);
    }
  }

  let rootEntries = [];
  try {
    rootEntries = fs.readdirSync(scanRoot, { withFileTypes: true });
  } catch {
    rootEntries = [];
  }
  for (const entry of rootEntries) {
    if (entry.isFile() && (entry.name.endsWith('.sln') || entry.name.endsWith('.csproj'))) {
      stacks.add('csharp');
      buildFiles.push(entry.name);
    }
  }

  // Fallback: check for Java/C# test directories even if build file is in a subfolder
  if (stacks.size === 0) {
    const javaFiles = walkSourceFiles(scanRoot, ['.java']);
    const csFiles = walkSourceFiles(scanRoot, ['.cs']);
    if (javaFiles.some((f) => /@(Test|ParameterizedTest|TestFactory)\b/.test(readTextSafe(f)))) {
      stacks.add('java');
    }
    if (csFiles.some((f) => /\[(Test|TestCase|Fact|Theory|TestMethod)\b/.test(readTextSafe(f)))) {
      stacks.add('csharp');
    }
  }

  return {
    detected: stacks.size > 0,
    stacks: [...stacks],
    buildFiles,
  };
}

/**
 * Extract brace-delimited body starting at the opening '{' index.
 */
function extractBraceBlock(source, openBraceIdx) {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = openBraceIdx; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(openBraceIdx, i + 1);
      }
    }
  }
  return source.slice(openBraceIdx);
}

function extractTagsFromAnnotations(attrBlock) {
  const tags = new Set();
  for (const m of attrBlock.matchAll(/@Tag\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    tags.add(`@${slugifyKebab(m[1])}`);
  }
  for (const m of attrBlock.matchAll(/groups\s*=\s*\{?\s*["']([^"']+)["']/g)) {
    tags.add(`@${slugifyKebab(m[1])}`);
  }
  for (const m of attrBlock.matchAll(/\[(?:Category|Trait)\s*\(\s*(?:["'][^"']+["']\s*,\s*)?["']([^"']+)["']\s*\)\]/g)) {
    tags.add(`@${slugifyKebab(m[1])}`);
  }
  if (/\b(?:smoke|p0|critical|sanity)\b/i.test(attrBlock)) {
    if (/\bp0\b/i.test(attrBlock)) tags.add('@p0');
    if (/\bsmoke\b/i.test(attrBlock)) tags.add('@smoke');
    if (/\bcritical\b/i.test(attrBlock)) tags.add('@p0');
  }
  return [...tags];
}

function parsePageObjectLocators(content, language) {
  const locators = [];
  if (language === 'java') {
    for (const m of content.matchAll(
      /@FindBy\s*\(\s*(id|name|css|xpath|linkText|className)\s*=\s*"([^"]+)"\s*\)\s*(?:private|public|protected)?\s*WebElement\s+(\w+)/g
    )) {
      locators.push({ fieldName: m[3], byType: m[1], selector: m[2] });
    }
    for (const m of content.matchAll(
      /(?:By|private\s+final\s+By)\s+(\w+)\s*=\s*By\.(id|name|cssSelector|xpath|linkText|className)\s*\(\s*"([^"]+)"\s*\)/g
    )) {
      locators.push({ fieldName: m[1], byType: m[2], selector: m[3] });
    }
  } else {
    for (const m of content.matchAll(
      /\[FindsBy\s*\(\s*How\s*=\s*How\.(\w+)\s*,\s*Using\s*=\s*"([^"]+)"\s*\)\]\s*(?:private|public|protected)?\s*IWebElement\s+(\w+)/g
    )) {
      locators.push({ fieldName: m[3], byType: m[1].toLowerCase(), selector: m[2] });
    }
    for (const m of content.matchAll(
      /\bBy\s+(\w+)\s*(?:=|=>)\s*By\.(Id|Name|CssSelector|XPath|LinkText|ClassName)\s*\(\s*"([^"]+)"\s*\)/g
    )) {
      locators.push({ fieldName: m[1], byType: m[2].toLowerCase(), selector: m[3] });
    }
  }
  return locators;
}

function classifyTestKind(body, fullFileContent) {
  const hasSelenium =
    /\b(?:WebDriver|IWebDriver|By\.|findElement|FindElement|@FindBy|\[FindsBy\]|sendKeys|SendKeys|Navigate\(\)|driver\.get)\b/.test(
      body
    ) || /\b(?:Page|PageObject)\b/.test(body);
  const hasApi =
    /\b(?:given\s*\(|RestAssured|HttpClient|HttpRequest|HttpResponseMessage|RestClient|RestRequest|OkHttpClient|\.when\s*\(\s*\)\.(?:get|post|put|delete|patch)|GetAsync|PostAsync|PutAsync|DeleteAsync|ExecuteAsync)\b/.test(
      body
    ) ||
    (/\b(?:RestAssured|RestSharp|HttpClient)\b/.test(fullFileContent) &&
      /\b(?:get|post|put|delete|patch|statusCode|StatusCode)\b/i.test(body));

  if (hasSelenium && hasApi) return 'hybrid';
  if (hasApi) return 'api';
  return 'ui';
}

function countPattern(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function computeWaveAndValue({ kind, tags, lineCount, assertionCount, pageObjectRefs, navigationCount }) {
  const isMonolith =
    lineCount > 80 ||
    assertionCount >= 5 ||
    pageObjectRefs.length >= 3 ||
    navigationCount >= 3;

  const isSmall = lineCount <= 45 && assertionCount <= 3 && pageObjectRefs.length <= 2;
  const hasHighPriorityTag = tags.some((t) => ['@p0', '@smoke', '@critical'].includes(t));

  let wave = 2;
  if (isMonolith) {
    wave = 3;
  } else if (kind === 'api' || (isSmall && hasHighPriorityTag) || lineCount <= 28) {
    wave = 1;
  }

  let valueScore = 50;
  if (hasHighPriorityTag) valueScore += 25;
  if (kind === 'api') valueScore += 15;
  if (isSmall) valueScore += 15;
  if (isMonolith) valueScore -= 25;
  valueScore = Math.max(10, Math.min(100, valueScore));

  const complexity = isMonolith ? 'monolith' : isSmall ? 'small' : 'medium';
  return { wave, valueScore, complexity };
}

function buildSuggestedSlices(testEntry, body) {
  if (testEntry.complexity !== 'monolith' && testEntry.kind !== 'hybrid') {
    return [];
  }
  const slices = [];
  if (testEntry.apiCallCount > 0 || /\b(?:setup|seed|createUser|createOrder)\b/i.test(body)) {
    slices.push({
      sliceIndex: slices.length + 1,
      sliceId: `${testEntry.id}-api-seed`,
      type: 'api-seeder',
      title: `API Data Seeding & Contract (${testEntry.testMethod})`,
      targetPattern: 'ApiClientContract + @api-contract',
    });
  }
  if (/\b(?:login|signIn|authenticate|LoginPage)\b/i.test(body)) {
    slices.push({
      sliceIndex: slices.length + 1,
      sliceId: `${testEntry.id}-auth`,
      type: 'auth-session',
      title: `Reusable Auth Session (.auth/<persona>.json)`,
      targetPattern: '00-env-bootstrap storageState',
    });
  }
  const phaseRefs = testEntry.pageObjectRefs.filter((r) => !/login/i.test(r));
  if (phaseRefs.length > 1) {
    for (const po of phaseRefs) {
      slices.push({
        sliceIndex: slices.length + 1,
        sliceId: `${testEntry.id}-${slugifyKebab(po)}`,
        type: 'ui-phase',
        title: `${po} Business Flow`,
        targetPattern: 'Session Tape -> SOLID Component + Spec',
      });
    }
  } else {
    slices.push({
      sliceIndex: slices.length + 1,
      sliceId: `${testEntry.id}-core-flow`,
      type: 'ui-phase',
      title: `Core UI Verification (${testEntry.testMethod})`,
      targetPattern: 'Session Tape -> SOLID Component + Spec',
    });
  }
  return slices;
}

function extractTestMethodsFromFile(filePath, scanRoot, pageObjectNames) {
  const content = readTextSafe(filePath);
  if (!content) return [];
  const relPath = path.relative(scanRoot, filePath).replace(/\\/g, '/');
  const language = filePath.endsWith('.java') ? 'java' : 'csharp';
  const classNameMatch = content.match(/\bclass\s+([A-Za-z0-9_]+)/);
  const className = classNameMatch ? classNameMatch[1] : path.basename(filePath, path.extname(filePath));

  const tests = [];
  const methodPattern =
    language === 'java'
      ? /((?:@\w+(?:\([^)]*\))?\s*)+)(?:public|protected|private)?\s*(?:static\s+)?void\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\{/g
      : /((?:\[[^\]]+\]\s*)+)(?:public|private|internal|protected)?\s*(?:async\s+)?(?:Task|void)\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/g;

  for (const m of content.matchAll(methodPattern)) {
    const attrBlock = m[1] || '';
    const testMethod = m[2];
    const isTestAnnotation =
      language === 'java'
        ? /@(?:Test|ParameterizedTest|TestFactory)\b/.test(attrBlock)
        : /\[(?:Test|TestCase|Fact|Theory|TestMethod)\b/.test(attrBlock);
    if (!isTestAnnotation) continue;

    const openBraceIdx = m.index + m[0].length - 1;
    const body = extractBraceBlock(content, openBraceIdx);
    const lineCount = body.split('\n').length;
    const kind = classifyTestKind(body, content);
    const tags = extractTagsFromAnnotations(attrBlock);
    if (kind === 'api' && !tags.includes('@api-contract')) {
      tags.push('@api-contract');
    }

    const assertionCount = countPattern(
      body,
      /\b(?:Assert\.|Assertions\.|assertThat|assertEquals|assertTrue|assertFalse|assertNotNull|Should\(\)|\.statusCode\s*\()/g
    );
    const navigationCount = countPattern(
      body,
      /\b(?:driver\.get\s*\(|Navigate\(\)\.GoToUrl|\.navigate\(\)\.to\()/g
    );
    const apiCallCount = countPattern(
      body,
      /\b(?:given\s*\(|\.get\s*\(|\.post\s*\(|\.put\s*\(|\.delete\s*\(|GetAsync|PostAsync|PutAsync|DeleteAsync|ExecuteAsync|RestRequest)\b/g
    );

    const pageObjectRefs = [];
    for (const po of pageObjectNames) {
      if (new RegExp(`\\b${po}\\b`).test(body)) {
        pageObjectRefs.push(po);
      }
    }

    const { wave, valueScore, complexity } = computeWaveAndValue({
      kind,
      tags,
      lineCount,
      assertionCount,
      pageObjectRefs,
      navigationCount,
    });

    const id = slugifyKebab(`${language === 'java' ? 'java' : 'cs'}-${className}-${testMethod}`);
    const entry = {
      id,
      language,
      file: relPath,
      className,
      testMethod,
      kind,
      tags,
      lineCount,
      assertionCount,
      navigationCount,
      apiCallCount,
      pageObjectRefs,
      complexity,
      wave,
      valueScore,
      suggestedSlices: [],
    };
    entry.suggestedSlices = buildSuggestedSlices(entry, body);
    tests.push(entry);
  }

  return tests;
}

/**
 * Discover all Java & C# legacy tests and Page Objects under `scanRoot`.
 */
export function discoverLegacyTests(scanRoot) {
  const stackInfo = detectLegacyTestProject(scanRoot);
  const sourceFiles = walkSourceFiles(scanRoot, ['.java', '.cs']);

  const pageObjects = {};
  const pageObjectNames = new Set();

  for (const file of sourceFiles) {
    const content = readTextSafe(file);
    if (!content) continue;
    const language = file.endsWith('.java') ? 'java' : 'csharp';
    const classMatch = content.match(/\bclass\s+([A-Za-z0-9_]+)/);
    const className = classMatch ? classMatch[1] : path.basename(file, path.extname(file));
    const isPo =
      /Page(?:Object)?$/i.test(className) ||
      /@FindBy\b|\[FindsBy\b/.test(content);
    if (isPo) {
      pageObjectNames.add(className);
      pageObjects[className] = {
        file: path.relative(scanRoot, file).replace(/\\/g, '/'),
        language,
        locators: parsePageObjectLocators(content, language),
      };
    }
  }

  const tests = [];
  for (const file of sourceFiles) {
    tests.push(...extractTestMethodsFromFile(file, scanRoot, pageObjectNames));
  }

  tests.sort((a, b) => {
    if (a.wave !== b.wave) return a.wave - b.wave;
    if (b.valueScore !== a.valueScore) return b.valueScore - a.valueScore;
    return a.lineCount - b.lineCount;
  });

  const wave1Count = tests.filter((t) => t.wave === 1).length;
  const wave2Count = tests.filter((t) => t.wave === 2).length;
  const wave3Count = tests.filter((t) => t.wave === 3).length;

  return {
    detected: stackInfo.detected || tests.length > 0,
    stacks: stackInfo.stacks,
    buildFiles: stackInfo.buildFiles,
    scanRoot,
    summary: {
      totalTests: tests.length,
      javaTests: tests.filter((t) => t.language === 'java').length,
      csharpTests: tests.filter((t) => t.language === 'csharp').length,
      apiTests: tests.filter((t) => t.kind === 'api').length,
      uiTests: tests.filter((t) => t.kind === 'ui').length,
      hybridTests: tests.filter((t) => t.kind === 'hybrid').length,
      wave1Count,
      wave2Count,
      wave3Count,
      pageObjectsCount: Object.keys(pageObjects).length,
    },
    recommendedNext: tests[0]
      ? {
          id: tests[0].id,
          wave: tests[0].wave,
          kind: tests[0].kind,
          file: tests[0].file,
          testMethod: tests[0].testMethod,
          command: `npm run migrate:skill -- --legacy ${tests[0].id}`,
        }
      : null,
    tests,
    pageObjects,
  };
}

export function loadMigrationManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, MIGRATION_MANIFEST_REL_PATH);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

export function saveMigrationManifest(projectRoot, manifest) {
  const manifestPath = path.join(projectRoot, MIGRATION_MANIFEST_REL_PATH);
  if (!isWithinDir(manifestPath, projectRoot)) {
    throw new Error(`Refusing to write manifest outside project root: ${manifestPath}`);
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifestPath;
}

export function syncDiscoveryToManifest(projectRoot, discovery, legacySourceRoot = '..') {
  const existing = loadMigrationManifest(projectRoot) || {
    schemaVersion: '1.0.0',
    legacySourceRoot,
    stacks: discovery.stacks,
    updatedAt: new Date().toISOString(),
    items: {},
  };

  existing.legacySourceRoot = existing.legacySourceRoot || legacySourceRoot;
  existing.stacks = discovery.stacks.length > 0 ? discovery.stacks : existing.stacks || [];
  existing.updatedAt = new Date().toISOString();
  existing.items = existing.items || {};

  for (const t of discovery.tests) {
    const prev = existing.items[t.id];
    existing.items[t.id] = {
      id: t.id,
      language: t.language,
      file: t.file,
      testMethod: t.testMethod,
      kind: t.kind,
      wave: t.wave,
      complexity: t.complexity,
      valueScore: t.valueScore,
      status: prev?.status || 'discovered',
      tapes: prev?.tapes || [],
      specs: prev?.specs || [],
      slices: t.suggestedSlices.map((s) => s.sliceId),
    };
  }

  saveMigrationManifest(projectRoot, existing);
  return existing;
}

function mapSeleniumLocatorToContract(byType, selectorValue) {
  const type = String(byType || '').toLowerCase();
  const val = String(selectorValue || '').trim() || 'target-element';
  if (type.includes('testid') || val.includes('data-testid')) {
    const cleaned = val.replace(/.*data-testid=['"]([^'"]+)['"].*/, '$1');
    return { strategy: 'getByTestId', value: cleaned, nameExact: true };
  }
  if (type === 'id' || type === 'name') {
    return { strategy: 'getByTestId', value: val, nameExact: true };
  }
  if (type === 'linktext') {
    return { strategy: 'getByRole', role: 'link', value: val, nameExact: true };
  }
  if (/button|btn|submit/i.test(val)) {
    return { strategy: 'getByRole', role: 'button', value: val.replace(/^#/, ''), nameExact: false };
  }
  return { strategy: 'getByText', value: val, nameExact: false };
}

function extractStepsAndContractsFromBody(body, testEntry, pageObjects) {
  const semanticSteps = [];
  const networkContracts = [];
  const expectedStates = [];
  const componentName = `${toPascalCase(testEntry.className.replace(/Tests?$/i, ''))}Page`;

  // 1. Extract API calls (RestAssured / RestSharp / HttpClient)
  const apiMatches = [
    ...body.matchAll(/\.(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*\)/gi),
    ...body.matchAll(/(Get|Post|Put|Patch|Delete)Async\s*\(\s*"([^"]+)"/gi),
    ...body.matchAll(/new\s+RestRequest\s*\(\s*"([^"]+)"\s*,\s*Method\.(\w+)/gi),
  ];

  for (const m of apiMatches) {
    let method = 'GET';
    let endpoint = '/api/health';
    if (m[0].includes('RestRequest')) {
      endpoint = m[1];
      method = m[2].toUpperCase();
    } else {
      method = m[1].toUpperCase();
      endpoint = m[2];
    }
    const urlPath = endpoint.startsWith('http')
      ? new URL(endpoint).pathname
      : endpoint.startsWith('/')
        ? endpoint
        : `/${endpoint}`;
    const clientCandidate = `${toPascalCase(testEntry.className.replace(/Tests?$/i, ''))}ApiClient`;
    semanticSteps.push({
      stepIndex: semanticSteps.length + 1,
      intent: `Call ${method} ${urlPath} endpoint`,
      businessStep: `Execute ${method} ${urlPath} API request`,
      action: 'apiCall',
      componentCandidate: clientCandidate,
      locatorContract: {
        strategy: 'apiEndpoint',
        value: urlPath,
      },
    });
    networkContracts.push({
      urlPattern: `**${urlPath}*`,
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'GET',
      expectedStatus: method === 'POST' ? 201 : 200,
      clientCandidate,
    });
  }

  // 2. Extract UI navigations
  for (const m of body.matchAll(/(?:driver\.get|Navigate\(\)\.GoToUrl|\.navigate\(\)\.to)\s*\(\s*"([^"]+)"\s*\)/g)) {
    const rawUrl = m[1];
    let route = '/';
    try {
      route = rawUrl.startsWith('http') ? new URL(rawUrl).pathname : rawUrl;
    } catch {
      route = '/';
    }
    semanticSteps.push({
      stepIndex: semanticSteps.length + 1,
      intent: `Navigate to ${route}`,
      businessStep: `Open ${route} page`,
      pageRoute: route,
      action: 'goto',
      componentCandidate: componentName,
      locatorContract: {
        strategy: 'url',
        value: route,
      },
    });
  }

  // 3. Extract inline Selenium By.* interactions
  for (const m of body.matchAll(
    /[Ff]indElement\s*\(\s*By\.(id|Id|name|Name|cssSelector|CssSelector|xpath|XPath|linkText|LinkText)\s*\(\s*"([^"]+)"\s*\)\s*\)\.(sendKeys|SendKeys|click|Click)\s*\(/g
  )) {
    const byType = m[1];
    const selectorVal = m[2];
    const op = m[3].toLowerCase();
    const action = op === 'sendkeys' ? 'fill' : 'click';
    const step = {
      stepIndex: semanticSteps.length + 1,
      intent: `${action === 'fill' ? 'Enter value into' : 'Click'} ${selectorVal}`,
      businessStep: `${action === 'fill' ? 'Provide input for' : 'Trigger'} ${toCamelCase(selectorVal)}`,
      action,
      componentCandidate: componentName,
      locatorContract: mapSeleniumLocatorToContract(byType, selectorVal),
    };
    if (action === 'fill') {
      step.inputDataRef = `${toPascalCase(testEntry.className)}Builder.defaultData.${toCamelCase(selectorVal)}`;
    }
    semanticSteps.push(step);
  }

  // 4. Extract Page Object method calls if no inline Selenium steps found
  if (semanticSteps.length === 0 && testEntry.pageObjectRefs.length > 0) {
    for (const po of testEntry.pageObjectRefs) {
      const poInfo = pageObjects[po];
      const firstLoc = poInfo?.locators?.[0];
      semanticSteps.push({
        stepIndex: semanticSteps.length + 1,
        intent: `Execute ${po} interaction`,
        businessStep: `Complete ${po} workflow step`,
        action: 'click',
        componentCandidate: po,
        locatorContract: firstLoc
          ? mapSeleniumLocatorToContract(firstLoc.byType, firstLoc.selector)
          : { strategy: 'getByRole', role: 'button', value: 'Continue', nameExact: false },
      });
    }
  }

  // Fallback step to guarantee minItems: 1
  if (semanticSteps.length === 0) {
    semanticSteps.push({
      stepIndex: 1,
      intent: `Execute ${testEntry.testMethod} flow`,
      businessStep: `Verify ${testEntry.testMethod} behaviour`,
      action: testEntry.kind === 'api' ? 'apiCall' : 'goto',
      componentCandidate: componentName,
      locatorContract:
        testEntry.kind === 'api'
          ? { strategy: 'apiEndpoint', value: '/api/health' }
          : { strategy: 'url', value: '/' },
    });
  }

  // 5. Extract expected states
  if (testEntry.kind === 'api' || networkContracts.length > 0) {
    const nc = networkContracts[0] || { clientCandidate: `${componentName}ApiClient`, expectedStatus: 200 };
    expectedStates.push({
      description: `Verify API returns expected HTTP ${nc.expectedStatus} status`,
      businessStep: semanticSteps[0].businessStep,
      assertionType: 'toHaveStatus',
      targetComponent: nc.clientCandidate || `${componentName}ApiClient`,
      targetProperty: 'lastResponse',
      expectedValueRef: `ApiStatus.OK_${nc.expectedStatus}`,
    });
  } else {
    expectedStates.push({
      description: `Verify ${testEntry.testMethod} target state is visible`,
      businessStep: semanticSteps[semanticSteps.length - 1].businessStep,
      assertionType: 'toBeVisible',
      targetComponent: componentName,
      targetProperty: 'primaryHeading',
      expectedValueRef: `${toPascalCase(testEntry.className)}Builder.expectedHeading`,
    });
  }

  return { semanticSteps, networkContracts, expectedStates };
}

/**
 * Build a draft Session Tape & migration plan for a legacy Java/C# test (or specific slice).
 */
export function buildLegacyMigrationPlan(scanRoot, targetIdOrFile, options = {}) {
  const discovery = discoverLegacyTests(scanRoot);
  const match = discovery.tests.find(
    (t) =>
      t.id === targetIdOrFile ||
      t.file === targetIdOrFile ||
      t.testMethod.toLowerCase() === String(targetIdOrFile || '').toLowerCase()
  );

  if (!match) {
    return { found: false, discovery };
  }

  const fullFilePath = path.join(scanRoot, match.file);
  const content = readTextSafe(fullFilePath);
  const methodRegex = new RegExp(`\\b${match.testMethod}\\s*\\([^)]*\\)\\s*(?:throws\\s+[^{]+)?\\{`);
  const methodMatch = content.match(methodRegex);
  const body = methodMatch
    ? extractBraceBlock(content, methodMatch.index + methodMatch[0].length - 1)
    : content;

  const { semanticSteps, networkContracts, expectedStates } = extractStepsAndContractsFromBody(
    body,
    match,
    discovery.pageObjects
  );

  const selectedSlice =
    options.sliceIndex && match.suggestedSlices[options.sliceIndex - 1]
      ? match.suggestedSlices[options.sliceIndex - 1]
      : null;

  const scenarioId = selectedSlice ? selectedSlice.sliceId : match.id;
  const charter =
    match.kind === 'api' || selectedSlice?.type === 'api-seeder'
      ? 'api-contract'
      : 'happy-path-baseline';
  const tags = match.tags.length > 0 ? match.tags : match.wave === 1 ? ['@p0', '@smoke'] : ['@regression'];

  const baseUrl =
    options.baseUrl && /^https?:\/\//.test(options.baseUrl)
      ? options.baseUrl
      : 'http://localhost:3000';

  const draftTape = {
    schemaVersion: '1.0.0',
    scenarioId,
    title: selectedSlice
      ? `${selectedSlice.title} (Migrated from ${match.language.toUpperCase()} ${match.testMethod})`
      : `${match.testMethod} (Migrated from ${match.language.toUpperCase()} ${match.file})`,
    charter,
    tags,
    recordedAt: new Date().toISOString(),
    baseUrl,
    persona: {
      role: 'standard_user',
      dataBuilderRef: `${toPascalCase(match.className)}Builder.defaultUser`,
    },
    preconditions: [
      `Migrated from legacy ${match.language.toUpperCase()} test: ${match.file}#${match.testMethod}`,
      options.staticOnly
        ? 'Static-only fallback mode: verify locators before CI promotion.'
        : 'Verify draft locators against live BASE_URL via @playwright/cli before compile:tape.',
    ],
    semanticSteps,
    networkContracts,
    expectedStates,
  };

  return {
    found: true,
    legacyTest: match,
    selectedSlice,
    verificationMode: options.staticOnly ? 'static-fallback' : 'live-cli-required',
    cliVerificationCommands: options.staticOnly
      ? []
      : [
          `npx playwright-cli -s=migrate-${scenarioId} open ${baseUrl} --headed`,
          `npx playwright-cli -s=migrate-${scenarioId} snapshot`,
        ],
    compileCommand: `npm run compile:tape -- .exploratory/tapes/${scenarioId}.json --apply`,
    draftTape,
  };
}

/**
 * Write the draft Session Tape and update .agents/domain/migration-manifest.json.
 */
export function applyLegacyMigrationPlan(projectRoot, plan, legacySourceRoot = '..') {
  const tapeDir = path.join(projectRoot, '.exploratory/tapes');
  fs.mkdirSync(tapeDir, { recursive: true });
  const tapeRelPath = `.exploratory/tapes/${plan.draftTape.scenarioId}.json`;
  const tapeFullPath = path.join(projectRoot, tapeRelPath);

  if (!isWithinDir(tapeFullPath, projectRoot)) {
    throw new Error(`Refusing to write tape outside project root: ${tapeFullPath}`);
  }

  fs.writeFileSync(tapeFullPath, JSON.stringify(plan.draftTape, null, 2) + '\n', 'utf8');

  const manifest = loadMigrationManifest(projectRoot) || {
    schemaVersion: '1.0.0',
    legacySourceRoot,
    stacks: [plan.legacyTest.language],
    updatedAt: new Date().toISOString(),
    items: {},
  };

  const prev = manifest.items[plan.legacyTest.id] || {
    id: plan.legacyTest.id,
    language: plan.legacyTest.language,
    file: plan.legacyTest.file,
    testMethod: plan.legacyTest.testMethod,
    kind: plan.legacyTest.kind,
    wave: plan.legacyTest.wave,
    complexity: plan.legacyTest.complexity,
    valueScore: plan.legacyTest.valueScore,
    tapes: [],
    specs: [],
    slices: plan.legacyTest.suggestedSlices.map((s) => s.sliceId),
  };

  if (!prev.tapes.includes(tapeRelPath)) {
    prev.tapes.push(tapeRelPath);
  }
  prev.status =
    plan.legacyTest.complexity === 'monolith' && prev.tapes.length < Math.max(1, prev.slices.length)
      ? 'decomposed'
      : 'taped';

  manifest.items[plan.legacyTest.id] = prev;
  manifest.updatedAt = new Date().toISOString();
  const manifestPath = saveMigrationManifest(projectRoot, manifest);

  return {
    tapeRelPath,
    manifestRelPath: path.relative(projectRoot, manifestPath).replace(/\\/g, '/'),
    status: prev.status,
  };
}
