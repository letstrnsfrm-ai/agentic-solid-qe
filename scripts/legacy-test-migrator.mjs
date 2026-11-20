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
 *      Session Tapes (.exploratory/tapes/<id>.json) ready for live agent-browser verification & `compile:tape`.
 *   5. Parity Manifest: Tracks incremental migration state in .agents/domain/migration-manifest.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseSolutionSquads,
  buildInheritanceMap,
  resolveInheritedSetup,
  parseSpecFlowSuite,
  detectHybridSeeders,
  extractSkipMetadata,
  rationalizeLegacySuite,
} from './dotnet-enterprise-analyzer.mjs';

const __migratorDir = path.dirname(fileURLToPath(import.meta.url));

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

const FORBIDDEN_TS_IDENTIFIERS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
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

function isWithinDir(targetPath, baseDir) {
  const relPath = path.relative(baseDir, targetPath);
  return relPath === '' || (!relPath.startsWith('..') && !path.isAbsolute(relPath));
}

export function assertSafeLegacyScanRoot(resolvedLegacyRoot, workspaceRoot = process.cwd()) {
  const normalizedTarget = path.resolve(resolvedLegacyRoot);
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const parentBoundary = path.dirname(normalizedWorkspace);

  const forbiddenExact = new Set([
    '/',
    '/root',
    '/etc',
    '/usr',
    '/var',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/opt',
    '/proc',
    '/sys',
    '/dev',
    '/tmp',
    '/System',
    '/Library',
    '/Users',
  ]);
  const forbiddenPrefixes = [
    '/etc/',
    '/usr/',
    '/var/',
    '/bin/',
    '/sbin/',
    '/lib/',
    '/proc/',
    '/sys/',
    '/dev/',
    '/System/',
    '/Library/',
  ];

  if (
    forbiddenExact.has(normalizedTarget) ||
    forbiddenPrefixes.some((prefix) => normalizedTarget.startsWith(prefix))
  ) {
    throw new Error(
      `Security Error: Refusing to scan protected system directory '${normalizedTarget}' as legacy root.`
    );
  }

  if (
    !isWithinDir(normalizedTarget, normalizedWorkspace) &&
    !isWithinDir(normalizedTarget, parentBoundary)
  ) {
    throw new Error(
      `Security Error: Legacy root '${normalizedTarget}' resolves outside the repository and its immediate parent directory ('${parentBoundary}').`
    );
  }

  if (fs.existsSync(normalizedTarget) && fs.lstatSync(normalizedTarget).isSymbolicLink()) {
    throw new Error(
      `Security Error: Refusing to scan symbolic link legacy root '${normalizedTarget}'.`
    );
  }

  return normalizedTarget;
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
  let pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  if (/^[0-9]/.test(pascal)) {
    pascal = `Field${pascal}`;
  }
  if (FORBIDDEN_TS_IDENTIFIERS.has(pascal)) {
    pascal = `${pascal}Model`;
  }
  return pascal;
}

function toCamelCase(raw) {
  const pascal = toPascalCase(raw);
  let camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  if (/^[0-9]/.test(camel)) {
    camel = `field${camel}`;
  }
  if (FORBIDDEN_TS_IDENTIFIERS.has(camel)) {
    camel = `${camel}Field`;
  }
  return camel;
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

const SENSITIVE_FIELD_REGEX = /password|passwd|secret|token|apikey|api_key|credential|auth/i;

function isSensitiveFieldName(name) {
  return SENSITIVE_FIELD_REGEX.test(String(name || ''));
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

function parsePageObjectLocators(content, language) {
  const locators = [];
  const seen = new Set();
  const pushLoc = (fieldName, byType, selector) => {
    if (!fieldName || seen.has(fieldName)) return;
    seen.add(fieldName);
    locators.push({ fieldName, byType: String(byType).toLowerCase(), selector });
  };

  if (language === 'java') {
    for (const m of content.matchAll(
      /@FindBy\s*\(\s*(id|name|css|xpath|linkText|partialLinkText|className|tagName)\s*=\s*"([^"]+)"\s*\)\s*(?:private|public|protected)?\s*(?:List\s*<\s*WebElement\s*>|WebElement)\s+(\w+)/g
    )) {
      pushLoc(m[3], m[1], m[2]);
    }
    for (const m of content.matchAll(
      /@FindBy\s*\(\s*how\s*=\s*How\.(\w+)\s*,\s*using\s*=\s*"([^"]+)"\s*\)\s*(?:private|public|protected)?\s*(?:List\s*<\s*WebElement\s*>|WebElement)\s+(\w+)/g
    )) {
      pushLoc(m[3], m[1], m[2]);
    }
    for (const m of content.matchAll(
      /(?:By|private\s+(?:static\s+)?(?:final\s+)?By)\s+(\w+)\s*=\s*By\.(id|name|cssSelector|xpath|linkText|partialLinkText|className|tagName)\s*\(\s*"([^"]+)"\s*\)/g
    )) {
      pushLoc(m[1], m[2], m[3]);
    }
  } else {
    for (const m of content.matchAll(
      /\[FindsBy\s*\(\s*How\s*=\s*How\.(\w+)\s*,\s*Using\s*=\s*"([^"]+)"\s*\)\]\s*(?:private|public|protected)?\s*(?:IList\s*<\s*IWebElement\s*>|IWebElement)\s+(\w+)/g
    )) {
      pushLoc(m[3], m[1], m[2]);
    }
    for (const m of content.matchAll(
      /\bBy\s+(\w+)\s*(?:=|=>)\s*By\.(Id|Name|CssSelector|XPath|LinkText|PartialLinkText|ClassName|TagName)\s*\(\s*"([^"]+)"\s*\)/g
    )) {
      pushLoc(m[1], m[2], m[3]);
    }
  }
  return locators;
}

function parsePageObjectMethods(content, language) {
  const methods = [];
  const seen = new Set();
  const pattern =
    language === 'java'
      ? /public\s+(?!class\b)[A-Za-z0-9_<>\[\]]+\s+([a-z][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:throws\s+[^{]+)?\{/g
      : /public\s+(?:async\s+)?[A-Za-z0-9_<>\[\]]+\s+([A-Z][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g;

  for (const m of content.matchAll(pattern)) {
    const name = m[1];
    if (seen.has(name) || /^(?:get|is|equals|hashCode|toString)$/i.test(name)) continue;
    seen.add(name);
    const rawParams = (m[2] || '').trim();
    const params = rawParams
      ? rawParams
          .split(',')
          .map((p) => p.trim().split(/\s+/).pop())
          .filter(Boolean)
      : [];
    methods.push({ name: toCamelCase(name), params });
  }
  return methods;
}

function mapJavaCsharpTypeToTs(rawType) {
  const t = String(rawType || '').trim().toLowerCase();
  if (/^(int|integer|long|double|float|decimal|short|byte)$/.test(t)) return 'number';
  if (/^(boolean|bool)$/.test(t)) return 'boolean';
  return 'string';
}

function parseLegacyDataModels(sourceFiles, scanRoot) {
  const models = {};
  for (const file of sourceFiles) {
    const content = readTextSafe(file);
    if (!content) continue;
    const language = file.endsWith('.java') ? 'java' : 'csharp';
    const relPath = path.relative(scanRoot, file).replace(/\\/g, '/');

    // Java/C# records: record CheckoutData(String firstName, String lastName, int zip)
    for (const m of content.matchAll(
      /\b(?:public\s+)?record\s+([A-Za-z0-9_]+)\s*\(([^)]+)\)/g
    )) {
      const name = m[1];
      const fields = m[2]
        .split(',')
        .map((part) => part.trim().split(/\s+/))
        .filter((parts) => parts.length >= 2)
        .map((parts) => ({
          name: toCamelCase(parts[parts.length - 1]),
          tsType: mapJavaCsharpTypeToTs(parts[parts.length - 2]),
          sensitive: isSensitiveFieldName(parts[parts.length - 1]),
        }));
      if (fields.length > 0) {
        models[name] = { name, language, file: relPath, fields };
      }
    }

    // POJO / POCO / DTO classes (*Data, *Dto, *Payload, *Request, *Model, *User)
    const classMatch = content.match(/\bclass\s+([A-Za-z0-9_]+(?:Data|Dto|Payload|Request|Model|User|Input))\b/);
    if (classMatch && !models[classMatch[1]]) {
      const name = classMatch[1];
      const fields = [];
      const seen = new Set();
      if (language === 'java') {
        for (const fm of content.matchAll(/(?:private|public|protected)\s+(?:final\s+)?(String|int|Integer|long|Long|double|Double|boolean|Boolean)\s+([a-zA-Z0-9_]+)\s*(?:=|;)/g)) {
          const fname = toCamelCase(fm[2]);
          if (seen.has(fname)) continue;
          seen.add(fname);
          fields.push({ name: fname, tsType: mapJavaCsharpTypeToTs(fm[1]), sensitive: isSensitiveFieldName(fname) });
        }
      } else {
        for (const fm of content.matchAll(/public\s+(string|int|long|double|decimal|bool)\s+([A-Za-z0-9_]+)\s*\{\s*get;/g)) {
          const fname = toCamelCase(fm[2]);
          if (seen.has(fname)) continue;
          seen.add(fname);
          fields.push({ name: fname, tsType: mapJavaCsharpTypeToTs(fm[1]), sensitive: isSensitiveFieldName(fname) });
        }
      }
      if (fields.length > 0) {
        models[name] = { name, language, file: relPath, fields };
      }
    }
  }
  return models;
}

function parseTypedLiteralToken(raw) {
  const t = String(raw || '').trim();
  if (/^["'].*["']$/.test(t)) return t.slice(1, -1);
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t.replace(/^["']|["']$/g, '');
}

function splitArgTokens(argStr) {
  const out = [];
  let cur = '';
  let inQuote = null;
  for (let i = 0; i < argStr.length; i++) {
    const ch = argStr[i];
    if (inQuote) {
      cur += ch;
      if (ch === inQuote && argStr[i - 1] !== '\\') inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      cur += ch;
    } else if (ch === ',') {
      if (cur.trim()) out.push(parseTypedLiteralToken(cur));
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(parseTypedLiteralToken(cur));
  return out;
}

function escapeRegExp(str) {
  return String(str ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractParameterizationDatasets(content, testMethod, language) {
  const safeMethod = escapeRegExp(testMethod);
  const sigRegex =
    language === 'java'
      ? new RegExp(`((?:@\\w+(?:\\([^)]*\\))?\\s*)+)(?:public|protected|private)?\\s*(?:static\\s+)?void\\s+${safeMethod}\\s*\\(([^)]*)\\)`)
      : new RegExp(`((?:\\[[^\\]]+\\]\\s*)+)(?:public|private|internal|protected)?\\s*(?:async\\s+)?(?:Task|void)\\s+${safeMethod}\\s*\\(([^)]*)\\)`);

  const sigMatch = content.match(sigRegex);
  if (!sigMatch) return { params: [], datasets: [] };

  const attrBlock = sigMatch[1] || '';
  const rawParams = (sigMatch[2] || '').trim();
  const params = rawParams
    ? rawParams.split(',').map((p, idx) => {
        const parts = p.trim().split(/\s+/);
        const name = toCamelCase(parts[parts.length - 1] || `param${idx + 1}`);
        const tsType = parts.length >= 2 ? mapJavaCsharpTypeToTs(parts[parts.length - 2]) : 'string';
        return { name, tsType, sensitive: isSensitiveFieldName(name) };
      })
    : [];

  const rows = [];

  if (language === 'java') {
    // @CsvSource({ "a, 1", "b, 2" })
    const csvMatch = attrBlock.match(/@CsvSource\s*\(\s*\{?([\s\S]*?)\}?\s*\)/);
    if (csvMatch) {
      for (const rm of csvMatch[1].matchAll(/"([^"]+)"/g)) {
        rows.push(rm[1].split(',').map((v) => parseTypedLiteralToken(v.trim())));
      }
    }
    // @ValueSource(strings = { "a", "b" }) or ints = { 1, 2 }
    const valMatch = attrBlock.match(/@ValueSource\s*\(\s*\w+\s*=\s*\{([^}]+)\}\s*\)/);
    if (valMatch) {
      for (const tok of splitArgTokens(valMatch[1])) {
        rows.push([tok]);
      }
    }
    // @Test(dataProvider = "name") -> find @DataProvider(name = "name") in same file
    const dpRef = attrBlock.match(/dataProvider\s*=\s*"([^"]+)"/);
    if (dpRef) {
      const escapedDpName = dpRef[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const dpRegex = new RegExp(`@DataProvider\\s*\\(\\s*name\\s*=\\s*"${escapedDpName}"\\s*\\)[\\s\\S]*?return\\s+new\\s+Object\\s*\\[\\]\\[\\]\\s*\\{([\\s\\S]*?)\\};`);
      const dpMatch = content.match(dpRegex);
      if (dpMatch) {
        for (const rm of dpMatch[1].matchAll(/\{([^{}]+)\}/g)) {
          rows.push(splitArgTokens(rm[1]));
        }
      }
    }
  } else {
    // C# [TestCase(...)], [InlineData(...)], [DataRow(...)]
    for (const m of attrBlock.matchAll(/\[(?:TestCase|InlineData|DataRow)\s*\(([^)]*)\)\]/g)) {
      const tokens = splitArgTokens(m[1]);
      if (tokens.length > 0) rows.push(tokens);
    }
  }

  const datasets = rows.map((rowVals, idx) => {
    const values = {};
    rowVals.forEach((val, colIdx) => {
      const param = params[colIdx] || { name: `arg${colIdx + 1}`, sensitive: false };
      values[param.name] = param.sensitive ? `<ENV:LEGACY_${param.name.toUpperCase()}>` : val;
    });
    return {
      name: `case-${idx + 1}`,
      values,
    };
  });

  return { params, datasets };
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

function extractDotNetSetupHooks(content) {
  const hookBodies = [];
  for (const m of content.matchAll(
    /\[(?:OneTimeSetUp|SetUp)\][\s\S]*?(?:public|private|protected)\s+(?:async\s+)?(?:Task|void)\s+\w+\s*\([^)]*\)\s*\{/g
  )) {
    const openIdx = m.index + m[0].length - 1;
    hookBodies.push(extractBraceBlock(content, openIdx));
  }
  for (const m of content.matchAll(
    /(?:public\s+)?async\s+Task\s+InitializeAsync\s*\([^)]*\)\s*\{/g
  )) {
    const openIdx = m.index + m[0].length - 1;
    hookBodies.push(extractBraceBlock(content, openIdx));
  }
  return hookBodies.join('\n');
}

function extractDotNetAppSettingsBaseUrl(scanRoot) {
  for (const name of ['appsettings.json', 'appsettings.Test.json', 'appsettings.Development.json']) {
    const full = path.join(scanRoot, name);
    const raw = readTextSafe(full);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const candidate =
        parsed.BaseUrl ||
        parsed.baseUrl ||
        parsed.AppUrl ||
        parsed.TestSettings?.BaseUrl ||
        parsed.Selenium?.BaseUrl;
      if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) {
        return { baseUrl: candidate, sourceFile: name };
      }
    } catch {
      /* ignore non-JSON appsettings */
    }
  }
  return null;
}

function extractSliceBody(fullFileContent, fullTestBody, selectedSlice, pageObjectNames = []) {
  if (!selectedSlice) return fullTestBody;
  const setupBody = extractDotNetSetupHooks(fullFileContent);

  if (selectedSlice.type === 'api-seeder') {
    const regionMatch = fullTestBody.match(/#region\s+[^\n]*(?:seed|setup|api)[^\n]*\n([\s\S]*?)#endregion/i);
    const apiLines = [...setupBody.split('\n'), ...fullTestBody.split('\n')]
      .filter((l) => /\b(?:GetAsync|PostAsync|PutAsync|DeleteAsync|ExecuteAsync|RestRequest|given\s*\(|\.(?:get|post|put|delete)\s*\(|seed|createUser|createOrder)\b/i.test(l))
      .join('\n');
    return [setupBody, regionMatch ? regionMatch[1] : '', apiLines].filter(Boolean).join('\n') || fullTestBody;
  }

  if (selectedSlice.type === 'auth-session') {
    const regionMatch = fullTestBody.match(/#region\s+[^\n]*(?:login|auth|signin)[^\n]*\n([\s\S]*?)#endregion/i);
    if (regionMatch) return regionMatch[1];
    const authLines = [...setupBody.split('\n'), ...fullTestBody.split('\n')]
      .filter((l) => /\b(?:login|signIn|authenticate|LoginPage|username|password|GoToUrl)\b/i.test(l))
      .join('\n');
    return authLines || fullTestBody;
  }

  // ui-phase: match #region by Page Object or phase name, else slice by Page Object lines
  const po = selectedSlice.pageObject || '';
  const poBase = po.replace(/Page(?:Object)?$/i, '');
  if (poBase) {
    const safePoBase = escapeRegExp(poBase);
    const safePo = escapeRegExp(po);
    const regionRegex = new RegExp(`#region\\s+[^\\n]*${safePoBase}[^\\n]*\\n([\\s\\S]*?)#endregion`, 'i');
    const rm = fullTestBody.match(regionRegex);
    if (rm) return rm[1];

    // Step-comment section matching: // Step X: <poBase> ... until next // Step or end
    const stepRegex = new RegExp(`//\\s*Step\\s*\\d*[^\\n]*${safePoBase}[^\\n]*\\n([\\s\\S]*?)(?=//\\s*Step\\s*\\d+|#region|$)`, 'i');
    const sm = fullTestBody.match(stepRegex);
    if (sm) return sm[1];

    // Line-range segmentation between Page Object references
    const lines = fullTestBody.split('\n');
    const otherPos = [...pageObjectNames].filter((n) => n !== po).map((n) => escapeRegExp(n));
    const startIdx = lines.findIndex((l) => new RegExp(`\\b${safePo}\\b`).test(l));
    if (startIdx >= 0) {
      let endIdx = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        if (otherPos.some((op) => new RegExp(`\\bnew\\s+${op}\\b|\\b${op}\\b`).test(lines[i]))) {
          endIdx = i;
          break;
        }
      }
      const sliced = lines.slice(startIdx, endIdx).join('\n').trim();
      if (sliced) return sliced;
    }
  }

  return fullTestBody;
}

function buildSuggestedSlices(testEntry, body, setupBody = '') {
  if (testEntry.complexity !== 'monolith' && testEntry.kind !== 'hybrid') {
    return [];
  }
  const combined = `${setupBody}\n${body}`;
  const slices = [];
  if (testEntry.apiCallCount > 0 || /\b(?:setup|seed|createUser|createOrder|PostAsync|RestRequest)\b/i.test(combined)) {
    slices.push({
      sliceIndex: slices.length + 1,
      sliceId: `${testEntry.id}-api-seed`,
      type: 'api-seeder',
      title: `API Data Seeding & Contract (${testEntry.testMethod})`,
      targetPattern: 'ApiClientContract + @api-contract',
    });
  }
  if (/\b(?:login|signIn|authenticate|LoginPage)\b/i.test(combined)) {
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
        pageObject: po,
        title: `${po} Business Flow`,
        targetPattern: 'Session Tape -> SOLID Component + Spec',
      });
    }
  } else {
    slices.push({
      sliceIndex: slices.length + 1,
      sliceId: `${testEntry.id}-core-flow`,
      type: 'ui-phase',
      pageObject: phaseRefs[0] || undefined,
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
      if (new RegExp(`\\b${escapeRegExp(po)}\\b`).test(body)) {
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
    const setupBody = language === 'csharp' ? extractDotNetSetupHooks(content) : '';
    entry.suggestedSlices = buildSuggestedSlices(entry, body, setupBody);
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
        methods: parsePageObjectMethods(content, language),
      };
    }
  }

  const dataModels = parseLegacyDataModels(sourceFiles, scanRoot);
  const csFiles = sourceFiles.filter((f) => f.endsWith('.cs'));
  const solutionTopology = parseSolutionSquads(scanRoot);
  const inheritanceMap = buildInheritanceMap(csFiles, scanRoot);
  const specflowSuite = parseSpecFlowSuite(scanRoot, solutionTopology.resolveSquadForFile);

  const tests = [];
  for (const file of sourceFiles) {
    const content = readTextSafe(file) || '';
    const squad = solutionTopology.resolveSquadForFile(file);
    const extracted = extractTestMethodsFromFile(file, scanRoot, pageObjectNames);
    for (const t of extracted) {
      const inheritedInfo = t.language === 'csharp' ? resolveInheritedSetup(t.className, inheritanceMap) : null;
      const seederProfile =
        t.language === 'csharp' ? detectHybridSeeders(content, t.bodyPreview || '', inheritedInfo) : null;
      const skipMeta = t.language === 'csharp' ? extractSkipMetadata(content) : { isSkipped: false, reason: null };
      const mergedPoRefs = [
        ...new Set([...(t.pageObjectRefs || []), ...(inheritedInfo?.inheritedPageObjects || [])]),
      ];
      tests.push({
        ...t,
        squad,
        pageObjectRefs: mergedPoRefs,
        ...(inheritedInfo ? { inheritanceChain: inheritedInfo.inheritanceChain, inheritedHooks: inheritedInfo.inheritedHooks } : {}),
        ...(seederProfile ? { seederProfile } : {}),
        isSkipped: skipMeta.isSkipped,
        skipReason: skipMeta.reason,
      });
    }
  }

  // Merge SpecFlow / Reqnroll .feature scenarios into unified test inventory
  for (const sc of specflowSuite.scenarios) {
    const wave = sc.steps.length >= 6 ? 3 : sc.steps.length >= 3 ? 2 : 1;
    tests.push({
      id: sc.id,
      name: sc.name,
      className: sc.feature,
      testMethod: sc.name,
      file: sc.file,
      squad: sc.squad,
      language: 'csharp',
      framework: sc.framework,
      kind: 'ui',
      tags: sc.tags,
      wave,
      valueScore: sc.tags.some((tg) => /@(p0|smoke|critical)/i.test(tg)) ? 95 : 70,
      complexity: wave === 3 ? 'high' : wave === 2 ? 'medium' : 'low',
      lineCount: sc.steps.length * 4,
      assertionCount: sc.steps.filter((s) => /^Then$/i.test(s.keyword)).length || 1,
      pageObjectRefs: sc.callPrefixTokens,
      callPrefixTokens: sc.callPrefixTokens,
      isSkipped: sc.isSkipped,
      skipReason: sc.skipReason,
      seederProfile: { primaryStrategy: 'ui-flow-prereq', detected: [] },
      specflowScenario: sc,
    });
  }

  tests.sort((a, b) => {
    if (a.wave !== b.wave) return a.wave - b.wave;
    if (b.valueScore !== a.valueScore) return b.valueScore - a.valueScore;
    return a.lineCount - b.lineCount;
  });

  const rationalization = rationalizeLegacySuite(tests);

  const wave1Count = tests.filter((t) => t.wave === 1).length;
  const wave2Count = tests.filter((t) => t.wave === 2).length;
  const wave3Count = tests.filter((t) => t.wave === 3).length;

  return {
    detected: stackInfo.detected || tests.length > 0,
    stacks: stackInfo.stacks,
    buildFiles: stackInfo.buildFiles,
    scanRoot,
    solutionTopology: {
      solutionFiles: solutionTopology.solutionFiles,
      projects: solutionTopology.projects,
      squads: solutionTopology.squads,
    },
    specflowSummary: {
      featureFileCount: specflowSuite.featureFileCount,
      bindingCount: specflowSuite.bindingCount,
      scenarioCount: specflowSuite.scenarios.length,
      scenarioContextKeys: specflowSuite.scenarioContextKeys,
    },
    rationalization,
    summary: {
      totalTests: tests.length,
      javaTests: tests.filter((t) => t.language === 'java').length,
      csharpTests: tests.filter((t) => t.language === 'csharp').length,
      specflowScenarios: specflowSuite.scenarios.length,
      apiTests: tests.filter((t) => t.kind === 'api').length,
      uiTests: tests.filter((t) => t.kind === 'ui').length,
      hybridTests: tests.filter((t) => t.kind === 'hybrid').length,
      wave0SharedPrereqs: rationalization.summary.wave0SharedPrereqs,
      wave1Count,
      wave2Count,
      wave3Count,
      skippedQuarantineCount: rationalization.summary.skippedQuarantine,
      estimatedTargetSpecs: rationalization.summary.estimatedTargetSpecs,
      reductionPct: rationalization.summary.reductionPct,
      pageObjectsCount: Object.keys(pageObjects).length,
      dataModelsCount: Object.keys(dataModels).length,
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
    dataModels,
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

function extractStepsAndContractsFromBody(body, testEntry, pageObjects, selectedSlice = null) {
  const semanticSteps = [];
  const networkContracts = [];
  const expectedStates = [];
  const componentName = selectedSlice?.pageObject
    ? selectedSlice.pageObject
    : `${toPascalCase(testEntry.className.replace(/Tests?$/i, ''))}Page`;
  const uiComponentCandidate = `${componentName.replace(/Page(?:Object)?$/i, '')}Component`;

  // Detect .NET SwitchTo().Frame("...") / DefaultContent()
  const frameMatch = body.match(/SwitchTo\(\)\.Frame\(\s*"([^"]+)"\s*\)/);
  const activeIframe = frameMatch ? frameMatch[1] : null;
  const alertMatch = body.match(/SwitchTo\(\)\.Alert\(\)\.(Accept|Dismiss)\s*\(/i);
  const activeDialogAction = alertMatch ? alertMatch[1].toLowerCase() : null;

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
      componentCandidate: uiComponentCandidate,
      locatorContract: {
        strategy: 'url',
        value: route,
      },
    });
  }

  // 3. Extract inline Selenium By.* interactions + .NET SelectElement
  for (const m of body.matchAll(
    /new\s+SelectElement\s*\(\s*[A-Za-z0-9_.]*FindElement\s*\(\s*By\.(Id|Name|CssSelector|XPath)\s*\(\s*"([^"]+)"\s*\)\s*\)\s*\)\.(?:SelectByText|SelectByValue)\s*\(\s*"([^"]+)"\s*\)/g
  )) {
    const locContract = mapSeleniumLocatorToContract(m[1], m[2]);
    if (activeIframe) locContract.iframeSelector = activeIframe;
    semanticSteps.push({
      stepIndex: semanticSteps.length + 1,
      intent: `Select ${m[3]} in ${m[2]}`,
      businessStep: `Choose ${m[3]} for ${toCamelCase(m[2])}`,
      action: 'selectOption',
      componentCandidate: uiComponentCandidate,
      locatorContract: locContract,
      inputDataRef: `${toPascalCase(testEntry.className.replace(/Tests?$/i, ''))}Builder.defaultData.${toCamelCase(m[2])}`,
    });
  }

  for (const m of body.matchAll(
    /[Ff]indElement\s*\(\s*By\.(id|Id|name|Name|cssSelector|CssSelector|xpath|XPath|linkText|LinkText)\s*\(\s*"([^"]+)"\s*\)\s*\)\.(sendKeys|SendKeys|click|Click)\s*\(/g
  )) {
    const byType = m[1];
    const selectorVal = m[2];
    const op = m[3].toLowerCase();
    const action = op === 'sendkeys' ? 'fill' : 'click';
    const locContract = mapSeleniumLocatorToContract(byType, selectorVal);
    if (activeIframe) locContract.iframeSelector = activeIframe;
    const step = {
      stepIndex: semanticSteps.length + 1,
      intent: `${action === 'fill' ? 'Enter value into' : 'Click'} ${selectorVal}`,
      businessStep: `${action === 'fill' ? 'Provide input for' : 'Trigger'} ${toCamelCase(selectorVal)}`,
      action,
      componentCandidate: uiComponentCandidate,
      locatorContract: locContract,
      ...(action === 'click' && activeDialogAction ? { dialogAction: activeDialogAction } : {}),
    };
    if (action === 'fill') {
      step.inputDataRef = `${toPascalCase(testEntry.className.replace(/Tests?$/i, ''))}Builder.defaultData.${toCamelCase(selectorVal)}`;
    }
    semanticSteps.push(step);
  }

  // 4. Extract Page Object method calls if no inline Selenium steps found
  const slicePoRefs = selectedSlice?.pageObject
    ? [selectedSlice.pageObject]
    : testEntry.pageObjectRefs;
  if (semanticSteps.length === 0 && slicePoRefs.length > 0) {
    for (const po of slicePoRefs) {
      const poInfo = pageObjects[po];
      const firstLoc = poInfo?.locators?.[0];
      const locContract = firstLoc
        ? mapSeleniumLocatorToContract(firstLoc.byType, firstLoc.selector)
        : { strategy: 'getByRole', role: 'button', value: 'Continue', nameExact: false };
      if (activeIframe) locContract.iframeSelector = activeIframe;
      semanticSteps.push({
        stepIndex: semanticSteps.length + 1,
        intent: `Execute ${po} interaction`,
        businessStep: `Complete ${po} workflow step`,
        action: 'click',
        componentCandidate: `${po.replace(/Page(?:Object)?$/i, '')}Component`,
        locatorContract: locContract,
        ...(activeDialogAction ? { dialogAction: activeDialogAction } : {}),
      });
    }
  }

  // Fallback step to guarantee minItems: 1
  if (semanticSteps.length === 0) {
    const isApi = testEntry.kind === 'api' || selectedSlice?.type === 'api-seeder';
    semanticSteps.push({
      stepIndex: 1,
      intent: `Execute ${testEntry.testMethod} flow`,
      businessStep: `Verify ${testEntry.testMethod} behaviour`,
      action: isApi ? 'apiCall' : 'goto',
      componentCandidate: isApi ? componentName : uiComponentCandidate,
      locatorContract: isApi
        ? { strategy: 'apiEndpoint', value: '/api/health' }
        : { strategy: 'url', value: '/' },
    });
  }

  // 5. Extract expected states
  if (selectedSlice?.type === 'api-seeder' || (selectedSlice?.type !== 'ui-phase' && (testEntry.kind === 'api' || networkContracts.length > 0))) {
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
    const firstStepComp = semanticSteps[0]?.componentCandidate || componentName;
    const compStem = firstStepComp.replace(/(?:StepComponent|Component|Step|Page)$/, '') || firstStepComp;
    const compProp = compStem.charAt(0).toLowerCase() + compStem.slice(1);
    const pageStem = componentName.replace(/Page(?:Object)?$/i, '');
    const pageFixture = `${pageStem.charAt(0).toLowerCase() + pageStem.slice(1)}Page`;
    expectedStates.push({
      description: `Verify ${selectedSlice?.title || testEntry.testMethod} target state is visible`,
      businessStep: semanticSteps[semanticSteps.length - 1].businessStep,
      assertionType: 'toBeVisible',
      targetComponent: `${pageFixture}.${compProp}`,
      targetProperty: 'primaryHeading',
      expectedValueRef: `${toPascalCase(testEntry.className.replace(/Tests?$/i, ''))}Builder.expectedHeading`,
    });
  }

  return { semanticSteps, networkContracts, expectedStates };
}

function translateSeleniumLocatorToPlaywright(loc) {
  const by = String(loc.byType || '').toLowerCase();
  const sel = String(loc.selector || '').trim();
  const esc = escapeSingleQuote(sel);

  if (by === 'id') {
    return { expr: `page.locator('#${esc}')`, needsReview: false };
  }
  if (by === 'name') {
    return { expr: `page.locator('[name="${esc.replace(/"/g, '\\"')}"]')`, needsReview: false };
  }
  if (by === 'linktext') {
    return { expr: `page.getByRole('link', { name: '${esc}', exact: true })`, needsReview: false };
  }
  if (by === 'partiallinktext') {
    return { expr: `page.getByRole('link', { name: '${esc}' })`, needsReview: false };
  }
  if (by === 'classname') {
    return { expr: `page.locator('.${esc}')`, needsReview: true, note: 'Verify semantic role/testid instead of className' };
  }
  if (by === 'tagname') {
    return { expr: `page.locator('${esc}')`, needsReview: true, note: 'Verify semantic role instead of tagName' };
  }
  if (by === 'css' || by === 'cssselector') {
    const testIdMatch = sel.match(/\[data-test(?:id)?=["']([^"']+)["']\]/);
    if (testIdMatch) {
      return { expr: `page.getByTestId('${escapeSingleQuote(testIdMatch[1])}')`, needsReview: false };
    }
    const ariaMatch = sel.match(/\[aria-label=["']([^"']+)["']\]/);
    if (ariaMatch) {
      return { expr: `page.getByLabel('${escapeSingleQuote(ariaMatch[1])}')`, needsReview: false };
    }
    return { expr: `page.locator('${esc}')`, needsReview: false };
  }
  if (by === 'xpath') {
    const idXpath = sel.match(/^\/\/\*\[@id=['"]([^'"]+)['"]\]$/);
    if (idXpath) {
      return { expr: `page.locator('#${escapeSingleQuote(idXpath[1])}')`, needsReview: false };
    }
    const btnExact = sel.match(/^\/\/button\[(?:text\(\)|normalize-space\(\))=['"]([^'"]+)['"]\]$/);
    if (btnExact) {
      return { expr: `page.getByRole('button', { name: '${escapeSingleQuote(btnExact[1])}', exact: true })`, needsReview: false };
    }
    const btnContains = sel.match(/^\/\/button\[contains\(text\(\),\s*['"]([^'"]+)['"]\)\]$/);
    if (btnContains) {
      return { expr: `page.getByRole('button', { name: '${escapeSingleQuote(btnContains[1])}' })`, needsReview: false };
    }
    return {
      expr: `page.locator('xpath=${esc}')`,
      needsReview: true,
      note: 'TODO: replace weak XPath with semantic locator via agent-browser',
    };
  }
  return { expr: `page.locator('${esc}')`, needsReview: true, note: 'TODO: verify locator via agent-browser' };
}

function classifyLocatorGroup(loc) {
  const hint = `${loc.fieldName} ${loc.selector}`;
  if (/nav|menu|header|footer|sidebar|tab|link|breadcrumb|logout/i.test(hint)) return 'nav';
  if (/table|row|cell|col|grid|list|sort|paginat|filter/i.test(hint)) return 'table';
  if (/modal|dialog|popup|alert|toast|confirm|banner/i.test(hint)) return 'modal';
  if (/input|field|txt|select|dropdown|check|radio|btn|button|submit|save|cancel|form/i.test(hint)) return 'form';
  return 'general';
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function buildComponentTs(compClassName, locators, methods = []) {
  const lines = [
    `import type { Locator, Page } from '@playwright/test';`,
    `import type { IdentifiableComponent } from '@contracts/identifiable-component.contract';`,
    ``,
    `/**`,
    ` * Migrated SOLID SRP Component (<= 150 lines, zero expect() calls).`,
    ` */`,
    `export class ${compClassName} implements IdentifiableComponent {`,
    `  readonly root: Locator;`,
  ];

  for (const loc of locators) {
    if (toCamelCase(loc.fieldName) === 'root') continue;
    lines.push(`  readonly ${toCamelCase(loc.fieldName)}: Locator;`);
  }

  lines.push(``, `  constructor(page: Page) {`, `    this.root = page.locator('body');`);
  for (const loc of locators) {
    if (toCamelCase(loc.fieldName) === 'root') continue;
    const tr = translateSeleniumLocatorToPlaywright(loc);
    const comment = tr.needsReview && tr.note ? ` // ${tr.note}` : '';
    lines.push(`    this.${toCamelCase(loc.fieldName)} = ${tr.expr};${comment}`);
  }
  lines.push(`  }`);

  for (const m of methods.slice(0, 6)) {
    const paramList = m.params.map((p) => `${toCamelCase(p)}: string`).join(', ');
    lines.push(``, `  async ${m.name}(${paramList}): Promise<void> {`);
    lines.push(`    // TODO: wire migrated interaction steps from legacy Page Object`);
    lines.push(`  }`);
  }

  lines.push(`}`, ``);
  return lines.join('\n');
}

function buildPageTs(pageClassName, componentSpecs) {
  const lines = [`import type { Page } from '@playwright/test';`];
  for (const c of componentSpecs) {
    lines.push(`import { ${c.className} } from '@components/${c.slug}.component';`);
  }
  lines.push(
    ``,
    `/**`,
    ` * Migrated Composed Page Object (zero expect() calls).`,
    ` */`,
    `export class ${pageClassName} {`
  );
  for (const c of componentSpecs) {
    lines.push(`  readonly ${c.propName}: ${c.className};`);
  }
  lines.push(``, `  constructor(page: Page) {`);
  for (const c of componentSpecs) {
    lines.push(`    this.${c.propName} = new ${c.className}(page);`);
  }
  lines.push(`  }`, `}`, ``);
  return lines.join('\n');
}

export function scaffoldPageObjectsToSolid(pageObjects, targetNames = []) {
  const namesToProcess =
    targetNames.length > 0
      ? targetNames.filter((n) => pageObjects[n])
      : Object.keys(pageObjects);

  const files = [];
  for (const poName of namesToProcess) {
    const po = pageObjects[poName];
    const baseName = poName.replace(/Page(?:Object)?$/i, '') || poName;
    const basePascal = toPascalCase(baseName);
    const baseKebab = slugifyKebab(baseName);
    const locators = po.locators || [];
    const methods = po.methods || [];

    if (locators.length === 0 && methods.length === 0) continue;

    const isGodPo = locators.length > 12;
    const componentSpecs = [];

    if (!isGodPo) {
      const slug = baseKebab;
      const compClassName = `${basePascal}Component`;
      const content = buildComponentTs(compClassName, locators, methods);
      files.push({
        path: `src/components/${slug}.component.ts`,
        kind: 'component',
        lines: content.split('\n').length,
        splitFromGodPageObject: false,
        content,
      });
      componentSpecs.push({ className: compClassName, slug, propName: toCamelCase(baseName) });
    } else {
      const grouped = new Map();
      for (const loc of locators) {
        const g = classifyLocatorGroup(loc);
        if (!grouped.has(g)) grouped.set(g, []);
        grouped.get(g).push(loc);
      }

      let methodAssigned = false;
      for (const [group, groupLocs] of grouped.entries()) {
        const chunks = groupLocs.length > 10 ? chunkArray(groupLocs, 10) : [groupLocs];
        chunks.forEach((chunk, idx) => {
          const suffix = chunks.length > 1 ? `${group}-${idx + 1}` : group;
          const slug = `${baseKebab}-${suffix}`;
          const compClassName = `${basePascal}${toPascalCase(suffix)}Component`;
          const compMethods = !methodAssigned ? methods : [];
          methodAssigned = true;
          const content = buildComponentTs(compClassName, chunk, compMethods);
          files.push({
            path: `src/components/${slug}.component.ts`,
            kind: 'component',
            lines: content.split('\n').length,
            splitFromGodPageObject: true,
            content,
          });
          componentSpecs.push({ className: compClassName, slug, propName: toCamelCase(suffix) });
        });
      }
    }

    const pageContent = buildPageTs(`${basePascal}Page`, componentSpecs);
    files.push({
      path: `src/pages/${baseKebab}.page.ts`,
      kind: 'page',
      lines: pageContent.split('\n').length,
      splitFromGodPageObject: isGodPo,
      content: pageContent,
    });
  }

  return files;
}

function scaffoldDataBuilder(match, params, datasets, dataModels) {
  const baseName = match.className.replace(/Tests?$/i, '') || match.testMethod;
  const builderPascal = `${toPascalCase(baseName)}Builder`;
  const builderKebab = slugifyKebab(baseName);

  // Collect fields from matching dataModel or parameterization params
  const matchingModel = Object.values(dataModels || {}).find(
    (m) =>
      m.name.toLowerCase().includes(baseName.toLowerCase()) ||
      baseName.toLowerCase().includes(m.name.replace(/(?:Data|Dto|Payload|Request|Model)$/i, '').toLowerCase())
  );

  const fields = matchingModel?.fields?.length
    ? matchingModel.fields
    : params.length > 0
      ? params
      : [];

  if (fields.length === 0 && datasets.length === 0) {
    return null;
  }

  const ifaceName = `${toPascalCase(baseName)}Data`;
  const lines = [
    `export interface ${ifaceName} {`,
  ];
  for (const f of fields) {
    lines.push(`  readonly ${f.name}: ${f.tsType};`);
  }
  lines.push(`}`, ``);

  const sensitiveFields = fields.filter((f) => f.sensitive);
  for (const sf of sensitiveFields) {
    lines.push(`const LEGACY_${sf.name.toUpperCase()} = process.env.LEGACY_${sf.name.toUpperCase()} ?? '';`);
  }
  if (sensitiveFields.length > 0) lines.push(``);

  lines.push(
    `/**`,
    ` * Typed Data Builder (DIP) extracted from legacy ${match.language.toUpperCase()} test data.`,
    ` */`,
    `export class ${builderPascal} {`,
    `  static defaultData(): ${ifaceName} {`,
    `    return {`
  );

  const firstRow = datasets[0]?.values || {};
  for (const f of fields) {
    if (f.sensitive) {
      lines.push(`      ${f.name}: LEGACY_${f.name.toUpperCase()},`);
    } else if (firstRow[f.name] !== undefined) {
      const v = firstRow[f.name];
      const lit = typeof v === 'string' ? `'${escapeSingleQuote(v)}'` : String(v);
      lines.push(`      ${f.name}: ${lit},`);
    } else if (f.tsType === 'number') {
      lines.push(`      ${f.name}: 1,`);
    } else if (f.tsType === 'boolean') {
      lines.push(`      ${f.name}: true,`);
    } else {
      lines.push(`      ${f.name}: 'sample-${slugifyKebab(f.name)}',`);
    }
  }
  lines.push(`    };`, `  }`);

  if (datasets.length > 0) {
    lines.push(``, `  static datasets(): Array<{ name: string; data: ${ifaceName} }> {`, `    return [`);
    for (const ds of datasets) {
      lines.push(`      {`, `        name: '${escapeSingleQuote(ds.name)}',`, `        data: {`);
      for (const f of fields) {
        if (f.sensitive) {
          lines.push(`          ${f.name}: LEGACY_${f.name.toUpperCase()},`);
        } else {
          const v = ds.values[f.name];
          const lit =
            v !== undefined
              ? typeof v === 'string'
                ? `'${escapeSingleQuote(v)}'`
                : String(v)
              : f.tsType === 'number'
                ? '0'
                : f.tsType === 'boolean'
                  ? 'false'
                  : `''`;
          lines.push(`          ${f.name}: ${lit},`);
        }
      }
      lines.push(`        },`, `      },`);
    }
    lines.push(`    ];`, `  }`);
  }

  lines.push(`}`, ``);
  const content = lines.join('\n');
  return {
    path: `src/data/${builderKebab}.builder.ts`,
    kind: 'data-builder',
    lines: content.split('\n').length,
    content,
  };
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
  const methodRegex = new RegExp(`\\b${escapeRegExp(match.testMethod)}\\s*\\([^)]*\\)\\s*(?:throws\\s+[^{]+)?\\{`);
  const methodMatch = content.match(methodRegex);
  const body = methodMatch
    ? extractBraceBlock(content, methodMatch.index + methodMatch[0].length - 1)
    : content;

  const selectedSlice =
    options.sliceIndex && match.suggestedSlices[options.sliceIndex - 1]
      ? match.suggestedSlices[options.sliceIndex - 1]
      : null;

  const effectiveBody = extractSliceBody(content, body, selectedSlice, Object.keys(discovery.pageObjects));

  const { semanticSteps, networkContracts, expectedStates } = extractStepsAndContractsFromBody(
    effectiveBody,
    match,
    discovery.pageObjects,
    selectedSlice
  );

  const { params, datasets } = extractParameterizationDatasets(content, match.testMethod, match.language);
  const scaffoldedPageRefs = selectedSlice?.pageObject
    ? [selectedSlice.pageObject]
    : match.pageObjectRefs;
  const scaffoldedFiles = scaffoldPageObjectsToSolid(discovery.pageObjects, scaffoldedPageRefs);
  const dataBuilderFile = scaffoldDataBuilder(match, params, datasets, discovery.dataModels);
  if (dataBuilderFile) {
    scaffoldedFiles.push(dataBuilderFile);
  }

  const scenarioId = selectedSlice ? selectedSlice.sliceId : match.id;
  const charter =
    match.kind === 'api' || selectedSlice?.type === 'api-seeder'
      ? 'api-contract'
      : 'happy-path-baseline';
  const tags =
    selectedSlice?.type === 'api-seeder'
      ? [...new Set([...match.tags, '@api-contract'])]
      : match.tags.length > 0
        ? match.tags
        : match.wave === 1
          ? ['@p0', '@smoke']
          : ['@regression'];

  const appSettings = match.language === 'csharp' ? extractDotNetAppSettingsBaseUrl(scanRoot) : null;
  const baseUrl =
    options.baseUrl && /^https?:\/\//.test(options.baseUrl) && options.baseUrl !== 'http://localhost:3000'
      ? options.baseUrl
      : appSettings?.baseUrl || (options.baseUrl && /^https?:\/\//.test(options.baseUrl) ? options.baseUrl : 'http://localhost:3000');

  const hasAuthSlice = match.suggestedSlices.some((s) => s.type === 'auth-session');
  const useStorageState =
    selectedSlice?.type === 'auth-session' ||
    (selectedSlice?.type === 'ui-phase' && hasAuthSlice);

  const prevSlice =
    selectedSlice && selectedSlice.sliceIndex > 1
      ? match.suggestedSlices[selectedSlice.sliceIndex - 2]
      : null;

  const resumesFrom =
    selectedSlice?.type === 'ui-phase' && prevSlice
      ? {
          scenarioId: prevSlice.sliceId,
          handoffStrategy: prevSlice.type === 'api-seeder' ? 'api-seed' : 'ui-prereq',
        }
      : undefined;

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
      ...(useStorageState ? { storageStatePath: '.auth/standard.json' } : {}),
      dataBuilderRef: `${toPascalCase(match.className.replace(/Tests?$/i, '') || match.className)}Builder.defaultData`,
    },
    ...(resumesFrom ? { resumesFrom } : {}),
    preconditions: [
      `Migrated from legacy ${match.language.toUpperCase()} test: ${match.file}#${match.testMethod}`,
      ...(appSettings ? [`Base URL detected from ${appSettings.sourceFile}; override via BASE_URL in .env.`] : []),
      options.staticOnly
        ? 'Static-only fallback mode: verify locators before CI promotion.'
        : 'Verify draft locators against live BASE_URL via agent-browser before compile:tape.',
    ],
    semanticSteps,
    networkContracts,
    expectedStates,
    ...(datasets.length > 0 ? { datasets } : {}),
  };

  return {
    found: true,
    legacyTest: match,
    selectedSlice,
    verificationMode: options.staticOnly ? 'static-fallback' : 'live-cli-required',
    cliVerificationCommands: options.staticOnly
      ? []
      : [
          `npx agent-browser --session migrate-${scenarioId} --headed open ${baseUrl}`,
          `npx agent-browser --session migrate-${scenarioId} snapshot -i`,
        ],
    compileCommand: `npm run compile:tape -- .exploratory/tapes/${scenarioId}.json --apply`,
    scaffoldedFiles,
    draftTape,
  };
}

/**
 * Write the draft Session Tape, scaffolded SOLID Components/Pages/Builders, and update .agents/domain/migration-manifest.json.
 */
export function applyLegacyMigrationPlan(projectRoot, plan, legacySourceRoot = '..', options = {}) {
  const tapeDir = path.join(projectRoot, '.exploratory/tapes');
  fs.mkdirSync(tapeDir, { recursive: true });
  const tapeRelPath = `.exploratory/tapes/${plan.draftTape.scenarioId}.json`;
  const tapeFullPath = path.join(projectRoot, tapeRelPath);

  if (!isWithinDir(tapeFullPath, projectRoot)) {
    throw new Error(`Refusing to write tape outside project root: ${tapeFullPath}`);
  }

  fs.writeFileSync(tapeFullPath, JSON.stringify(plan.draftTape, null, 2) + '\n', 'utf8');

  const writtenScaffoldFiles = [];
  for (const sf of plan.scaffoldedFiles || []) {
    const destPath = path.join(projectRoot, sf.path);
    if (!isWithinDir(destPath, projectRoot)) {
      throw new Error(`Refusing to write scaffold file outside project root: ${destPath}`);
    }
    if (!fs.existsSync(destPath) || options.force) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, sf.content, 'utf8');
      writtenScaffoldFiles.push(sf.path);
    }
  }

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
  prev.scaffoldedFiles = [...new Set([...(prev.scaffoldedFiles || []), ...writtenScaffoldFiles])];
  prev.status =
    plan.legacyTest.complexity === 'monolith' && prev.tapes.length < Math.max(1, prev.slices.length)
      ? 'decomposed'
      : 'taped';

  manifest.items[plan.legacyTest.id] = prev;
  manifest.updatedAt = new Date().toISOString();
  const manifestPath = saveMigrationManifest(projectRoot, manifest);

  return {
    tapeRelPath,
    writtenScaffoldFiles,
    manifestRelPath: path.relative(projectRoot, manifestPath).replace(/\\/g, '/'),
    status: prev.status,
  };
}

/**
 * Emit all chained slices of a monolithic (or single-slice) legacy test and optionally compile
 * each Session Tape 1-by-1 via `compile-tape.mjs`.
 */
export function migrateMonolithAllSlices(scanRoot, projectRoot, testId, options = {}) {
  const firstPlan = buildLegacyMigrationPlan(scanRoot, testId, {
    ...options,
    sliceIndex: 1,
  });
  if (!firstPlan.found) {
    return {
      found: false,
      legacyTest: null,
      slices: [],
      compiledSlices: [],
    };
  }

  const totalSlices = Math.max(1, (firstPlan.legacyTest.suggestedSlices || []).length);
  const relLegacyRoot = path.relative(projectRoot, scanRoot).replace(/\\/g, '/') || '.';
  const compileScript = path.join(__migratorDir, 'compile-tape.mjs');

  const slices = [];
  const compiledSlices = [];

  for (let idx = 1; idx <= totalSlices; idx++) {
    const plan =
      idx === 1
        ? firstPlan
        : buildLegacyMigrationPlan(scanRoot, testId, { ...options, sliceIndex: idx });
    let applied = null;
    if (options.apply) {
      applied = applyLegacyMigrationPlan(projectRoot, plan, relLegacyRoot, options);
    }

    let compileResult = null;
    if (options.apply && options.compile) {
      const res = spawnSync(
        process.execPath,
        [compileScript, plan.draftTape.scenarioId, '--apply'],
        { cwd: projectRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
      );
      compileResult = {
        scenarioId: plan.draftTape.scenarioId,
        status: res.status ?? 1,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
      };
      compiledSlices.push(compileResult);
      if (compileResult.status !== 0) {
        slices.push({
          sliceIndex: idx,
          scenarioId: plan.draftTape.scenarioId,
          type: plan.selectedSlice?.type || 'ui-phase',
          resumesFrom: plan.draftTape.resumesFrom || null,
          applied,
          compileResult,
        });
        break;
      }
    }

    slices.push({
      sliceIndex: idx,
      scenarioId: plan.draftTape.scenarioId,
      type: plan.selectedSlice?.type || 'ui-phase',
      resumesFrom: plan.draftTape.resumesFrom || null,
      applied,
      ...(compileResult ? { compileResult } : {}),
    });
  }

  return {
    found: true,
    legacyTest: firstPlan.legacyTest,
    totalSlices,
    slices,
    compiledSlices,
  };
}

