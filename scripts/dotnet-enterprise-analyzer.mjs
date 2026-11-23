#!/usr/bin/env node
/**
 * Enterprise C#/.NET Multi-Project Analyzer, SpecFlow/Reqnroll Parser,
 * BaseTest Inheritance Resolver, Hybrid Seeder Detector & 2,000-Test Rationalization Engine.
 *
 * Designed to scale legacy .NET Selenium/API/BDD suites (2,000+ tests across multi-app
 * .sln/.csproj solutions) into federated SOLID Playwright squads without 1:1 bloat.
 */
import fs from 'node:fs';
import path from 'node:path';

function slugifyKebab(raw) {
  return String(raw || 'core')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'core';
}

function toPascalCase(raw) {
  return String(raw || 'Shared')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('') || 'Shared';
}

function walkFilesByExt(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (['node_modules', '.git', 'bin', 'obj', 'TestResults', 'packages', '.vs'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFilesByExt(full, exts, out);
    } else if (exts.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// ─── 1. Multi-.csproj / .sln Squad Partitioning ─────────────────────────────

export function parseSolutionSquads(scanRoot) {
  const csprojFiles = walkFilesByExt(scanRoot, ['.csproj']);
  const slnFiles = walkFilesByExt(scanRoot, ['.sln']);
  const projects = [];

  for (const projFile of csprojFiles) {
    const relProj = path.relative(scanRoot, projFile).replace(/\\/g, '/');
    const dirRel = path.dirname(relProj).replace(/\\/g, '/');
    const rawName = path.basename(projFile, '.csproj');
    const cleaned = rawName.replace(/\.(Tests?|E2E|Specs?|UI|Automation|Integration|Functional)$/i, '');
    const squad = slugifyKebab(cleaned || rawName);
    const content = fs.readFileSync(projFile, 'utf8');
    const isSpecFlow = /SpecFlow|Reqnroll/i.test(content);
    const hasDbRefs = /Microsoft\.Data\.SqlClient|System\.Data\.SqlClient|Dapper|EntityFramework/i.test(content);
    const hasApiRefs = /RestSharp|Refit|System\.Net\.Http|ServiceModel/i.test(content);

    projects.push({
      name: rawName,
      relPath: relProj,
      dirRel: dirRel === '.' ? '' : dirRel,
      squad,
      isSpecFlow,
      hasDbRefs,
      hasApiRefs,
    });
  }

  // Sort longest dirRel first so nested projects match before root
  projects.sort((a, b) => b.dirRel.length - a.dirRel.length);

  const resolveSquadForFile = (filePath) => {
    const rel = path.relative(scanRoot, filePath).replace(/\\/g, '/');
    for (const p of projects) {
      if (!p.dirRel || rel === p.dirRel || rel.startsWith(`${p.dirRel}/`)) {
        return p.squad;
      }
    }
    const firstSeg = rel.split('/')[0];
    return firstSeg && firstSeg !== rel ? slugifyKebab(firstSeg) : 'core';
  };

  return {
    solutionFiles: slnFiles.map((f) => path.relative(scanRoot, f).replace(/\\/g, '/')),
    projects,
    squads: [...new Set(projects.map((p) => p.squad))],
    resolveSquadForFile,
  };
}

// ─── 2. BaseTest Inheritance Chain Resolver ─────────────────────────────────

export function buildInheritanceMap(csFiles, scanRoot) {
  const classMap = new Map(); // ClassName -> { file, baseClass, setupHooks[], pageObjectFields[], authSignals[] }

  for (const file of csFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const relPath = path.relative(scanRoot, file).replace(/\\/g, '/');
    const classMatches = [...content.matchAll(/\b(?:public|internal)?\s*(?:abstract\s+|sealed\s+|partial\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]+>)?(?:\s*:\s*([A-Za-z_][A-Za-z0-9_.<>,\s]+))?/g)];

    const setupHooks = [];
    for (const m of content.matchAll(/\[(OneTimeSetUp|SetUp|ClassInitialize|TestInitialize|BeforeScenario|BeforeFeature)\b[^\]]*\][\s\S]{0,120}?\b(?:public|protected|private)\s+(?:async\s+)?(?:Task|void)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      setupHooks.push({ attribute: m[1], method: m[2] });
    }

    const pageObjectFields = [...content.matchAll(/\b([A-Z][A-Za-z0-9_]*(?:Page|PageObject|Component|Client|Seeder|Helper))\s+_?[a-z][A-Za-z0-9_]*/g)].map(
      (m) => m[1]
    );

    const authSignals = [];
    if (/\b(?:Login|SignIn|Authenticate|GetAccessToken|AzureAd|Okta|WindowsAuth|Cookie)\b/i.test(content)) {
      authSignals.push('auth-setup');
    }

    for (const cm of classMatches) {
      const clsName = cm[1];
      const rawBases = (cm[2] || '').replace(/\bwhere\b[\s\S]*$/i, '');
      // Strip balanced generic <...> arguments before splitting on ','
      let strippedBases = '';
      let depth = 0;
      for (const ch of rawBases) {
        if (ch === '<') depth++;
        else if (ch === '>') depth = Math.max(0, depth - 1);
        else if (depth === 0) strippedBases += ch;
      }
      const baseList = strippedBases
        .split(',')
        .map((s) => s.trim().split('.').pop())
        .filter((s) => s && !/^I[A-Z]/.test(s) && s !== 'IDisposable');
      const baseClass = baseList[0] || null;
      const existing = classMap.get(clsName);
      if (!existing) {
        classMap.set(clsName, {
          className: clsName,
          file: relPath,
          baseClass,
          setupHooks: [...setupHooks],
          pageObjectFields: [...new Set(pageObjectFields)],
          authSignals: [...new Set(authSignals)],
        });
      } else {
        if (!existing.baseClass && baseClass) existing.baseClass = baseClass;
        for (const h of setupHooks) {
          if (!existing.setupHooks.some((eh) => eh.method === h.method && eh.attribute === h.attribute)) {
            existing.setupHooks.push(h);
          }
        }
        existing.pageObjectFields = [...new Set([...existing.pageObjectFields, ...pageObjectFields])];
        existing.authSignals = [...new Set([...existing.authSignals, ...authSignals])];
      }
    }
  }
  return classMap;
}

export function resolveInheritedSetup(className, classMap) {
  const chain = [];
  const inheritedHooks = [];
  const inheritedPageObjects = new Set();
  const inheritedAuth = new Set();
  const visited = new Set();

  let current = classMap.get(className);
  while (current && !visited.has(current.className)) {
    visited.add(current.className);
    chain.push(current.className);
    for (const hook of current.setupHooks || []) {
      inheritedHooks.push({ className: current.className, ...hook });
    }
    for (const po of current.pageObjectFields || []) inheritedPageObjects.add(po);
    for (const a of current.authSignals || []) inheritedAuth.add(a);
    current = current.baseClass ? classMap.get(current.baseClass) : null;
  }

  return {
    inheritanceChain: chain,
    inheritedHooks,
    inheritedPageObjects: [...inheritedPageObjects],
    hasInheritedAuth: inheritedAuth.size > 0,
  };
}

// ─── 3. SpecFlow / Reqnroll BDD Parser (.feature + [Binding] + ScenarioContext)

export function parseSpecFlowBindings(csFiles, scanRoot) {
  const bindings = [];
  const scenarioContextKeys = new Set();

  for (const file of csFiles) {
    const content = fs.readFileSync(file, 'utf8');
    if (!/\[Binding\]/.test(content)) continue;
    const relPath = path.relative(scanRoot, file).replace(/\\/g, '/');

    for (const m of content.matchAll(
      /\[(Given|When|Then|StepDefinition)\s*\(\s*@?"([^"]+)"\s*\)\][\s\S]{0,160}?\b(?:public|private|internal)\s+(?:async\s+)?(?:Task|void)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
    )) {
      bindings.push({
        keyword: m[1],
        pattern: m[2],
        method: m[3],
        file: relPath,
      });
    }

    for (const cm of content.matchAll(
      /(?:ScenarioContext|scenarioContext|_scenarioContext)(?:\.Current)?(?:\[\s*"([^"]+)"\s*\]|\.(?:Get|Set|Add)<[^>]+>\(\s*"([^"]+)"|\.(?:Get|Set|Add)\(\s*"([^"]+)")/g
    )) {
      const key = cm[1] || cm[2] || cm[3];
      if (key) scenarioContextKeys.add(key);
    }
  }

  return {
    bindings,
    scenarioContextKeys: [...scenarioContextKeys],
  };
}

function isSafeRegexPattern(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 200) return false;
  // Reject obvious nested-quantifier ReDoS constructs like (a+)+, (.*)*, (\w+)+
  if (/\([^)]*[+*?][^)]*\)[+*?{]/.test(pattern)) return false;
  return true;
}

function matchBinding(stepText, bindings) {
  const safeStep = String(stepText || '').slice(0, 500);
  for (const b of bindings) {
    if (isSafeRegexPattern(b.pattern)) {
      try {
        const re = new RegExp(b.pattern, 'i');
        if (re.test(safeStep)) return b;
      } catch {
        if (safeStep.toLowerCase().includes(String(b.pattern).toLowerCase())) return b;
      }
    } else if (b.pattern && safeStep.toLowerCase().includes(String(b.pattern).toLowerCase())) {
      return b;
    }
  }
  return null;
}

export function parseSpecFlowSuite(scanRoot, resolveSquadForFile = () => 'core') {
  const featureFiles = walkFilesByExt(scanRoot, ['.feature']);
  const csFiles = walkFilesByExt(scanRoot, ['.cs']);
  const { bindings, scenarioContextKeys } = parseSpecFlowBindings(csFiles, scanRoot);
  const scenarios = [];

  for (const fFile of featureFiles) {
    const content = fs.readFileSync(fFile, 'utf8');
    const relPath = path.relative(scanRoot, fFile).replace(/\\/g, '/');
    const squad = resolveSquadForFile(fFile);
    const lines = content.split(/\r?\n/);

    let featureTitle = path.basename(fFile, '.feature');
    let featureTags = [];
    let pendingTags = [];
    let backgroundSteps = [];
    let inBackground = false;
    let current = null;
    let inExamples = false;
    let exampleHeaders = [];

    const flushCurrent = () => {
      if (!current) return;
      const allSteps = [...backgroundSteps, ...current.steps];
      const linkedBindings = allSteps.map((st) => {
        const b = matchBinding(st.text, bindings);
        return { ...st, bindingMethod: b?.method || null, bindingFile: b?.file || null };
      });
      const tags = [...new Set([...featureTags, ...current.tags])];
      const isSkipped = tags.some((t) => /^@(ignore|skip|wip|quarantine|manual)$/i.test(t));
      scenarios.push({
        id: slugifyKebab(`${path.basename(fFile, '.feature')}-${current.name}`),
        name: current.name,
        feature: featureTitle,
        file: relPath,
        squad,
        language: 'csharp',
        framework: 'specflow-reqnroll',
        kind: 'e2e-bdd',
        tags,
        isSkipped,
        skipReason: isSkipped ? 'Tagged @ignore/@skip/@wip in .feature file' : null,
        steps: linkedBindings,
        exampleRowCount: current.exampleRows.length,
        scenarioContextKeys,
        callPrefixTokens: linkedBindings.slice(0, 3).map((s) => s.bindingMethod || slugifyKebab(s.text)),
      });
      current = null;
      inExamples = false;
      exampleHeaders = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('@')) {
        pendingTags.push(...line.split(/\s+/).filter((t) => t.startsWith('@')));
        continue;
      }
      if (/^Feature:/i.test(line)) {
        featureTitle = line.replace(/^Feature:\s*/i, '').trim();
        featureTags = [...pendingTags];
        pendingTags = [];
        continue;
      }
      if (/^Background:/i.test(line)) {
        flushCurrent();
        inBackground = true;
        backgroundSteps = [];
        pendingTags = [];
        continue;
      }
      if (/^Scenario(?:\s+Outline)?:/i.test(line)) {
        flushCurrent();
        inBackground = false;
        current = {
          name: line.replace(/^Scenario(?:\s+Outline)?:\s*/i, '').trim(),
          tags: [...pendingTags],
          steps: [],
          exampleRows: [],
        };
        pendingTags = [];
        continue;
      }
      if (/^Examples:/i.test(line) && current) {
        inExamples = true;
        exampleHeaders = [];
        pendingTags = [];
        continue;
      }
      if (inExamples && line.startsWith('|') && current) {
        const cols = line
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim());
        if (exampleHeaders.length === 0) {
          exampleHeaders = cols;
        } else {
          current.exampleRows.push(cols);
        }
        continue;
      }
      const stepMatch = line.match(/^(Given|When|Then|And|But)\s+(.+)$/i);
      if (stepMatch) {
        const st = { keyword: stepMatch[1], text: stepMatch[2].trim() };
        if (inBackground) backgroundSteps.push(st);
        else if (current) current.steps.push(st);
      }
    }
    flushCurrent();
  }

  return {
    featureFileCount: featureFiles.length,
    bindingCount: bindings.length,
    scenarioContextKeys,
    scenarios,
  };
}

// ─── 4. Hybrid Enterprise Seeder Detection ──────────────────────────────────

export function detectHybridSeeders(fileContent = '', methodBody = '', inheritedInfo = null) {
  const combined = `${fileContent}\n${methodBody}`;
  const detected = [];

  if (/\b(?:RestClient|RestRequest|HttpClient|PostAsJsonAsync|Refit|SoapHttpClientProtocol|ClientBase<|WcfClient)\b/.test(combined)) {
    detected.push({
      kind: 'api-seeder',
      targetContract: 'StateSeederContract',
      evidence: 'RestSharp/HttpClient/Refit/WCF API helper detected',
    });
  }
  if (/\b(?:SqlConnection|SqlCommand|Dapper|ExecuteAsync|QueryFirstAsync|DbContext|SaveChangesAsync|CommandType\.StoredProcedure)\b/.test(combined)) {
    detected.push({
      kind: 'db-seeder',
      targetContract: 'StateSeederContract',
      evidence: 'SQL/Dapper/EntityFramework/StoredProcedure seeding detected',
    });
  }
  if (/\b(?:File\.ReadAllText|ExcelDataReader|CsvReader|JsonConvert\.DeserializeObject|TestDataFactory)\b/.test(combined)) {
    detected.push({
      kind: 'file-data-seeder',
      targetContract: 'DataBuilder',
      evidence: 'External JSON/CSV/Excel test data loader detected',
    });
  }
  if (
    (inheritedInfo?.inheritedHooks?.length || 0) > 0 ||
    /\b(?:Navigate\(\)\.GoToUrl|LoginPage|SignIn|CreateQuote|SetupOrder)\b/.test(methodBody)
  ) {
    detected.push({
      kind: 'ui-flow-prereq',
      targetContract: 'FlowContract',
      evidence: inheritedInfo?.hasInheritedAuth
        ? `Inherited BaseTest auth/setup chain (${(inheritedInfo.inheritanceChain || []).join(' -> ')})`
        : 'Multi-step UI setup flow detected',
    });
  }

  const primaryStrategy =
    detected.find((d) => d.kind === 'api-seeder' || d.kind === 'db-seeder')?.kind ||
    detected.find((d) => d.kind === 'ui-flow-prereq')?.kind ||
    'standalone';

  return { primaryStrategy, detected };
}

// ─── 5. 2,000-Test Rationalization & Wave-0 Prefix Miner ────────────────────

export function extractSkipMetadata(attrAndBody = '') {
  const ignoreMatch = attrAndBody.match(/\[(Ignore|Skip|Explicit)(?:\s*\(\s*"([^"]*)"\s*\))?\]/i);
  if (ignoreMatch) {
    return { isSkipped: true, reason: `[${ignoreMatch[1]}]${ignoreMatch[2] ? `: ${ignoreMatch[2]}` : ''}` };
  }
  if (/\bAssert\.Ignore\s*\(|\bSkip\.If\s*\(/i.test(attrAndBody)) {
    return { isSkipped: true, reason: 'Runtime Assert.Ignore / Skip.If' };
  }
  return { isSkipped: false, reason: null };
}

export function extractPrefixTokens(testEntry) {
  if (Array.isArray(testEntry.callPrefixTokens) && testEntry.callPrefixTokens.length > 0) {
    return testEntry.callPrefixTokens.slice(0, 3);
  }
  const refs = Array.isArray(testEntry.pageObjectRefs) ? testEntry.pageObjectRefs : [];
  if (refs.length > 0) return refs.slice(0, 3);
  if (testEntry.baseClass) return [testEntry.baseClass];
  return [];
}

export function rationalizeLegacySuite(tests = [], { minPrefixReuse = 2 } = {}) {
  const triagedTests = [];
  const prefixBuckets = new Map(); // prefixKey -> { tokens, testIds[], squads Set, hasApiOrDb }
  const fingerprintBuckets = new Map(); // structuralFingerprint -> testEntries[]
  const squadStats = new Map();

  for (const t of tests) {
    const squad = t.squad || 'core';
    if (!squadStats.has(squad)) {
      squadStats.set(squad, { squad, total: 0, active: 0, skipped: 0, wave1: 0, wave2: 0, wave3: 0 });
    }
    const st = squadStats.get(squad);
    st.total++;

    const isSkipped = Boolean(t.isSkipped);
    if (isSkipped) {
      st.skipped++;
      triagedTests.push({
        ...t,
        squad,
        ledgerStatus: 'skipped-quarantine',
        skipReason: t.skipReason || 'Quarantined/Ignored in legacy suite',
      });
      continue;
    }

    st.active++;
    if (t.wave === 1) st.wave1++;
    else if (t.wave === 3) st.wave3++;
    else st.wave2++;

    const prefixTokens = extractPrefixTokens(t);
    const prefixKey = prefixTokens.length >= 2 ? prefixTokens.slice(0, 2).join(' -> ') : prefixTokens[0] || '';
    if (prefixKey) {
      if (!prefixBuckets.has(prefixKey)) {
        prefixBuckets.set(prefixKey, {
          prefixKey,
          tokens: prefixTokens.slice(0, 2),
          testIds: [],
          squads: new Set(),
          hasApiOrDb: false,
        });
      }
      const bucket = prefixBuckets.get(prefixKey);
      bucket.testIds.push(t.id);
      bucket.squads.add(squad);
      if (t.seederProfile?.primaryStrategy === 'api-seeder' || t.seederProfile?.primaryStrategy === 'db-seeder') {
        bucket.hasApiOrDb = true;
      }
    }

    // Structural fingerprint for near-duplicate / data-variation consolidation
    const rawName = String(t.testMethod || t.name || t.id);
    const strippedStem = rawName
      .replace(/(?<=.{3,})(?:With|For|Using|When)[A-Z0-9][A-Za-z0-9_]*$/g, '')
      .replace(/\d+$/g, '');
    const normalizedNameStem = (strippedStem || rawName).toLowerCase();
    const classScope = String(t.className || t.file || '').toLowerCase();
    const fp = `${squad}|${classScope}|${t.kind || 'e2e'}|${(t.pageObjectRefs || []).join(',')}|${normalizedNameStem}`;
    if (!fingerprintBuckets.has(fp)) fingerprintBuckets.set(fp, []);
    fingerprintBuckets.get(fp).push(t);

    triagedTests.push({
      ...t,
      squad,
      prefixKey: prefixKey || null,
      ledgerStatus: 'pending',
    });
  }

  // Build Wave-0 Shared Prerequisites (sorted by highest reuse impact)
  const wave0Prereqs = [...prefixBuckets.values()]
    .filter((b) => b.testIds.length >= minPrefixReuse)
    .sort((a, b) => b.testIds.length - a.testIds.length)
    .map((b) => {
      const slug = slugifyKebab(b.tokens.join('-'));
      const recommendedContract = b.hasApiOrDb ? 'StateSeederContract' : 'FlowContract';
      const className = `${toPascalCase(slug)}${b.hasApiOrDb ? 'Seeder' : 'Flow'}`;
      return {
        id: `wave0-${slug}`,
        prefixKey: b.prefixKey,
        className,
        recommendedContract,
        squads: [...b.squads],
        reuseCount: b.testIds.length,
        consumerTestIds: b.testIds,
      };
    });

  // Build Near-Duplicate Consolidation Groups (N:1 parity mapping)
  const consolidationGroups = [...fingerprintBuckets.values()]
    .filter((group) => group.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((group) => {
      const canonical = group[0];
      return {
        canonicalTestId: canonical.id,
        squad: canonical.squad || 'core',
        mergedCount: group.length,
        mergedTestIds: group.map((g) => g.id),
        recommendedPattern: 'parameterized-data-builder-spec',
      };
    });

  const activeCount = triagedTests.filter((t) => t.ledgerStatus !== 'skipped-quarantine').length;
  const skippedCount = triagedTests.length - activeCount;
  const redundantMergedCount = consolidationGroups.reduce((acc, g) => acc + (g.mergedCount - 1), 0);
  const estimatedTargetSpecs = Math.max(0, activeCount - redundantMergedCount);
  const reductionPct =
    triagedTests.length > 0 ? Math.round(((triagedTests.length - estimatedTargetSpecs) / triagedTests.length) * 100) : 0;

  return {
    summary: {
      totalLegacy: triagedTests.length,
      activeTests: activeCount,
      skippedQuarantine: skippedCount,
      wave0SharedPrereqs: wave0Prereqs.length,
      consolidatedGroups: consolidationGroups.length,
      redundantMergedCount,
      estimatedTargetSpecs,
      reductionPct,
    },
    squadBreakdown: [...squadStats.values()].sort((a, b) => b.total - a.total),
    wave0Prereqs,
    consolidationGroups,
    triagedTests,
  };
}
