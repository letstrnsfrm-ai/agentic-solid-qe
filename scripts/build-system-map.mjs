#!/usr/bin/env node
/**
 * Builds a self-contained, zero-dependency interactive HTML visualization
 * (reports/system-map.html) with a Dual-Persona View:
 *   1. Business Stakeholder Lens (default): 3-level progressive disclosure
 *      (Executive KPIs & Coverage Growth Trend -> Domain/Squad Rollups ->
 *      Plain-English Business Journeys & Live Pass/Fail Health), Light/Dark theme,
 *      and Print/PDF Executive Brief styling.
 *   2. Engineering / Architecture Lens (toggle): Domain-grouped topology,
 *      4-lane UI/Component/API/Assertion sequence inspector, and contract inventory.
 *
 * Also supports `npx cortex map --serve [--port 4321]` for live SSE auto-reload
 * as automation coverage increases.
 *
 * Security: Structural & schema-level data only (never raw tokens, cookies, or PII).
 * Loopback-only binding for `--serve`, strict workspace & symlink confinement.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let ROOT = process.cwd();
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_WAVE_SNAPSHOTS = 30;
const MAX_GIT_COMMITS = 10;
const NON_TEST_TAGS = new Set([
  '@playwright',
  '@fixtures',
  '@data',
  '@pages',
  '@components',
  '@contracts',
  '@domains',
  '@shared',
  '@steps',
  '@seeders',
  '@api',
]);

function isWithinDir(targetPath, baseDir) {
  const relPath = path.relative(baseDir, targetPath);
  return relPath === '' || (!relPath.startsWith('..') && !path.isAbsolute(relPath));
}

function assertSafeWorkspacePath(rootDir, targetPath, label = 'output path') {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedOut = path.resolve(resolvedRoot, targetPath);
  if (!isWithinDir(resolvedOut, resolvedRoot)) {
    throw new Error(`Security Error: Refusing to write ${label} outside workspace: ${targetPath}`);
  }
  let cur = resolvedOut;
  while (cur !== resolvedRoot) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        throw new Error(
          `Security Error: Refusing to access ${label} through symbolic link: ${path.relative(resolvedRoot, cur)}`
        );
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return resolvedOut;
}

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function walkFiles(dir, extFilter) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full, extFilter));
    } else if (!extFilter || full.endsWith(extFilter)) {
      try {
        const st = fs.lstatSync(full);
        if (st.isFile() && st.size <= MAX_FILE_BYTES) files.push(full);
      } catch {
        /* skip unreadable */
      }
    }
  }
  return files;
}

function cleanDisplayTitle(rawTitle) {
  return String(rawTitle || '')
    .replace(/\s*\[@[a-z0-9-\s@]+\]/gi, '')
    .replace(/\s*\(Compiled from Session Tape:[^)]+\)/gi, '')
    .replace(/(?:\s+@[a-z0-9-]+)+\s*$/gi, '')
    .trim();
}

function extractTagsFromText(text) {
  return [...new Set([...String(text || '').matchAll(/(?:^|[\s['"`(])(@[a-z0-9-]+)\b/gi)].map((m) => m[1].toLowerCase()))].filter(
    (t) => !NON_TEST_TAGS.has(t)
  );
}

function readDomainMemory() {
  const memPath = path.join(ROOT, '.agents/domain/domain-memory.md');
  if (!fs.existsSync(memPath)) {
    return { appName: 'Unknown App', baseUrl: '', sessionMechanism: '' };
  }
  const content = fs.readFileSync(memPath, 'utf8');
  const appName = content.match(/\*\*Application Name:\*\*\s*(.+)/i)?.[1]?.trim() || 'Target App';
  const baseUrl = content.match(/\*\*Base URL:\*\*\s*`?([^`\n]+)`?/i)?.[1]?.trim() || '';
  const sessionMechanism =
    content.match(/\*\*Session Mechanism:\*\*\s*(.+)/i)?.[1]?.trim() || '';
  return { appName, baseUrl, sessionMechanism };
}

function readShards() {
  const seen = new Set();
  const shardFiles = [
    ...walkFiles(path.join(ROOT, '.agents/domain/shards'), '.md'),
    ...walkFiles(path.join(ROOT, '.agents/domain/domains'), '.md').filter((f) =>
      f.includes(`${path.sep}shards${path.sep}`)
    ),
  ].filter((f) => {
    const resolved = path.resolve(f);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });

  return shardFiles.map((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    const rawTitle = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(filePath, '.md');
    const cleanName = rawTitle
      .replace(/^(?:Domain|Feature|Route)\s+Shard:\s*/i, '')
      .replace(/\s*\((?:`\/[^)]*)\)\s*$/g, '')
      .replace(/`/g, '')
      .trim();
    const squadFromPath = filePath.match(/\.agents[\\/]domain[\\/]domains[\\/]([^\\/]+)[\\/]shards[\\/]/);
    const ownerSquad =
      content.match(/\*\*Owner Squad:\*\*\s*`?([^`|\n]+)`?/i)?.[1]?.trim() ||
      (squadFromPath ? `@org/${squadFromPath[1]}` : '@org/unassigned');
    const lastVerified =
      content.match(/\*\*Last Verified:\*\*\s*`?(\d{4}-\d{2}-\d{2})`?/i)?.[1]?.trim() || null;
    const capRaw = content.match(/\*\*Published Capabilities:\*\*\s*(.+)/i)?.[1] || '';
    const capabilities = capRaw.toLowerCase().includes('none yet')
      ? []
      : capRaw
          .split(',')
          .map((s) => s.trim().replace(/^`|`$/g, ''))
          .filter(Boolean);
    const routes = [...new Set([...content.matchAll(/`(\/[a-zA-Z0-9._:/{}-]*)`/g)].map((m) => m[1]))];
    const relFile = rel(filePath);
    const slug = path.basename(filePath, '.md').toLowerCase();
    return {
      id: relFile,
      slug,
      file: relFile,
      title: rawTitle,
      displayName: cleanName,
      ownerSquad,
      lastVerified,
      capabilities,
      routes,
    };
  });
}

function readTapes() {
  const tapeFiles = walkFiles(path.join(ROOT, '.exploratory/tapes'), '.json');
  const tapes = [];
  for (const filePath of tapeFiles) {
    try {
      const t = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const contracts = (t.networkContracts || []).map((nc) => ({
        method: nc.method || 'GET',
        urlPattern: nc.urlPattern || '',
        expectedStatus: nc.expectedStatus || 200,
        clientCandidate: nc.clientCandidate || null,
        responseSchemaSummary: nc.responseSchemaSummary || '',
      }));

      const stepGroups = [];
      const groupByTitle = new Map();
      for (const s of t.semanticSteps || []) {
        const title = s.businessStep || s.intent || `Step ${s.stepIndex}`;
        if (!groupByTitle.has(title)) {
          const g = {
            title,
            pageRoute: s.pageRoute || '',
            actions: [],
            components: new Set(),
            apis: [],
            outcomes: [],
          };
          groupByTitle.set(title, g);
          stepGroups.push(g);
        }
        const g = groupByTitle.get(title);
        g.actions.push({
          stepIndex: s.stepIndex,
          action: s.action,
          intent: s.intent,
          component: s.componentCandidate,
          inputDataRef: s.inputDataRef || null,
          waitForNetwork: s.waitForNetwork || null,
        });
        if (s.componentCandidate) g.components.add(s.componentCandidate);
        if (typeof s.waitForNetwork === 'string' && s.waitForNetwork.trim()) {
          const waitStr = s.waitForNetwork.trim();
          const waitNeedle = waitStr.replace(/\*/g, '');
          const matched = contracts.filter((c) => {
            if (!c.urlPattern) return false;
            if (c.urlPattern === waitStr) return true;
            const patNeedle = c.urlPattern.replace(/\*/g, '');
            return (
              (waitNeedle.length > 0 && c.urlPattern.includes(waitNeedle)) ||
              (patNeedle.length > 0 && waitStr.includes(patNeedle))
            );
          });
          for (const m of matched) {
            if (!g.apis.some((a) => a.method === m.method && a.urlPattern === m.urlPattern)) {
              g.apis.push(m);
            }
          }
        }
      }

      for (const es of t.expectedStates || []) {
        const title = es.businessStep || 'Verify expected business outcomes';
        if (!groupByTitle.has(title)) {
          const g = {
            title,
            pageRoute: '',
            actions: [],
            components: new Set(),
            apis: [],
            outcomes: [],
          };
          groupByTitle.set(title, g);
          stepGroups.push(g);
        }
        groupByTitle.get(title).outcomes.push({
          description: es.description,
          assertionType: es.assertionType,
          targetComponent: es.targetComponent,
          targetProperty: es.targetProperty,
        });
      }

      const actorRoles = Array.isArray(t.actors)
        ? t.actors.map((a) => a?.role).filter(Boolean)
        : [];
      const personaRole = actorRoles.length > 0 ? actorRoles.join(', ') : t.persona?.role || 'standard';

      tapes.push({
        file: rel(filePath),
        scenarioId: t.scenarioId || path.basename(filePath, '.json'),
        title: t.title || path.basename(filePath, '.json'),
        charter: t.charter || 'happy-path-baseline',
        tags: (t.tags || []).map((tg) => String(tg).toLowerCase()),
        personaRole,
        dataBuilderRef: t.persona?.dataBuilderRef || '',
        networkContracts: contracts,
        businessSteps: stepGroups.map((g) => ({
          title: g.title,
          pageRoute: g.pageRoute,
          actions: g.actions,
          components: [...g.components],
          apis: g.apis,
          outcomes: g.outcomes,
        })),
      });
    } catch {
      /* skip malformed tape */
    }
  }
  return tapes;
}

/**
 * Parses individual `test(...)` cases and nested `test.step(...)` business journeys
 * from `tests/*.spec.ts` without executing user code.
 */
function parseSpecTestBlocks(content) {
  const describeMatch = content.match(/\btest\.describe(?:\.(?:parallel|serial))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/s);
  const describeRaw = describeMatch ? describeMatch[2] : '';
  const describeTitle = cleanDisplayTitle(describeRaw);
  const describeTags = extractTagsFromText(describeRaw);

  const testStartRe = /\btest(?:\.(?:only|skip|fixme))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*,/g;
  const starts = [];
  for (const m of content.matchAll(testStartRe)) {
    const prefix = content.slice(Math.max(0, m.index - 20), m.index);
    if (/\.\s*$/.test(prefix)) continue;
    const isSkipped = /\btest\.(?:skip|fixme)\b/.test(m[0]);
    starts.push({
      index: m.index,
      endOfTitle: m.index + m[0].length,
      rawTitle: m[2].replace(/\s+/g, ' ').trim(),
      isSkipped,
    });
  }

  const parsedCases = [];
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i];
    const nextIdx = i + 1 < starts.length ? starts[i + 1].index : content.length;
    const slice = content.slice(cur.endOfTitle, nextIdx);

    const detailsTagMatch = slice.match(/^\s*\{\s*tag\s*:\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/s);
    const annotationTags = detailsTagMatch ? extractTagsFromText(detailsTagMatch[1]) : [];

    const fixtureMatch = slice.match(/^\s*(?:\{[^}]*\}\s*,\s*)?async\s*\(\s*\{([^}]*)\}/s);
    const fixtures = fixtureMatch
      ? fixtureMatch[1]
          .split(',')
          .map((s) => s.split(':')[0].trim())
          .filter((s) => s && !['page', 'request', 'context', 'browser'].includes(s))
      : [];

    const steps = [];
    const stepRe = /\btest\.step\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    for (const sm of slice.matchAll(stepRe)) {
      const stepTitle = sm[2].replace(/\s+/g, ' ').trim();
      if (stepTitle) steps.push(stepTitle);
    }

    const personas = [
      ...new Set(
        [...slice.matchAll(/\bUserBuilder\.([A-Za-z0-9_]+)\s*\(/g)].map((pm) =>
          pm[1]
            .replace(/Persona$|User$/i, '')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase()
        )
      ),
    ];

    const routes = [
      ...new Set(
        [...slice.matchAll(/toHaveURL\(\s*(?:\/\\\/([a-zA-Z0-9._/-]+)|['"`](\/[a-zA-Z0-9._/-]*))/g)]
          .map((rm) => (rm[1] ? `/${rm[1].replace(/\\\//g, '/')}` : rm[2]))
          .filter(Boolean)
      ),
    ];

    const titleTags = extractTagsFromText(cur.rawTitle);
    const mergedTags = [...new Set([...titleTags, ...annotationTags, ...describeTags])];

    parsedCases.push({
      rawTitle: cur.rawTitle,
      displayTitle: cleanDisplayTitle(cur.rawTitle) || cur.rawTitle,
      tags: mergedTags,
      steps,
      fixtures,
      personas,
      routes,
      isSkipped: cur.isSkipped,
    });
  }

  return { describeTitle, cases: parsedCases };
}

function readSpecs() {
  const specFiles = walkFiles(path.join(ROOT, 'tests'), '.spec.ts');
  return specFiles.map((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    const tags = extractTagsFromText(content);
    const tapeMatch = content.match(/Compiled from Session Tape:\s*([a-z0-9-_]+)/i);
    const { describeTitle, cases } = parseSpecTestBlocks(content);
    const relFile = rel(filePath);
    const stem = path.basename(filePath, '.spec.ts');
    return {
      file: relFile,
      stem,
      describeTitle,
      tags,
      tests: cases.map((c) => c.rawTitle),
      testCases: cases,
      scenarioId: tapeMatch ? tapeMatch[1] : null,
    };
  });
}

function readDefects() {
  const defectFiles = walkFiles(path.join(ROOT, 'defects'), '.md').filter(
    (f) => path.basename(f).toLowerCase() !== 'readme.md'
  );
  return defectFiles.map((filePath) => {
    const content = fs.readFileSync(filePath, 'utf8');
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(filePath, '.md');
    const severity = content.match(/\*\*Severity:\*\*\s*([^\n]+)/i)?.[1]?.trim() || 'Medium';
    const endpoint = content.match(/\*\*Endpoint:\*\*\s*`?([^`\n]+)`?/i)?.[1]?.trim() || '';
    const route = content.match(/\*\*Route \/ Portal:\*\*\s*([^\n]+)/i)?.[1]?.trim() || '';
    return { file: rel(filePath), title, severity, endpoint, route };
  });
}

function readSrcInventory() {
  const srcDir = path.join(ROOT, 'src');
  const tsFiles = walkFiles(srcDir, '.ts');
  const layers = { pages: [], steps: [], components: [], apiClients: [], seeders: [], builders: [] };
  for (const f of tsFiles) {
    const r = rel(f);
    const content = fs.readFileSync(f, 'utf8');
    const classMatch = content.match(/export\s+class\s+([A-Za-z0-9_]+)/);
    const name = classMatch ? classMatch[1] : path.basename(f, '.ts');
    const routes = [...new Set([...content.matchAll(/['"`](\/[a-zA-Z0-9._/-]+)['"`]/g)].map((m) => m[1]))];
    const item = { name, file: r, routes };
    if (r.endsWith('.step.ts') || r.includes('/steps/')) layers.steps.push(item);
    else if (r.endsWith('.page.ts') || r.includes('/pages/')) layers.pages.push(item);
    else if (r.endsWith('.component.ts') || r.includes('/components/')) layers.components.push(item);
    else if (r.endsWith('.client.ts') || r.includes('/api/')) layers.apiClients.push(item);
    else if (r.endsWith('.seeder.ts') || r.includes('/seeders/')) layers.seeders.push(item);
    else if (r.endsWith('.builder.ts') || r.includes('/data/')) layers.builders.push(item);
  }
  return layers;
}

function getCoverageStatePath(rootDir) {
  return assertSafeWorkspacePath(rootDir, path.join(rootDir, 'reports', '.coverage-state.json'), 'coverage state');
}

export function readCoverageState(rootDir = process.cwd()) {
  try {
    const statePath = getCoverageStatePath(rootDir);
    if (!fs.existsSync(statePath)) {
      return { lastRun: null, tests: {}, waveSnapshots: [], gitHistoryCache: null };
    }
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      lastRun: raw?.lastRun || null,
      tests: raw?.tests && typeof raw.tests === 'object' ? raw.tests : {},
      waveSnapshots: Array.isArray(raw?.waveSnapshots) ? raw.waveSnapshots : [],
      gitHistoryCache: raw?.gitHistoryCache || null,
    };
  } catch {
    return { lastRun: null, tests: {}, waveSnapshots: [], gitHistoryCache: null };
  }
}

export function writeCoverageState(rootDir = process.cwd(), nextState = {}) {
  try {
    const statePath = getCoverageStatePath(rootDir);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(nextState, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Records Playwright execution results into gitignored `reports/.coverage-state.json`
 * and optionally triggers `buildSystemMap`.
 */
export function recordPlaywrightRunState(
  rootDir = process.cwd(),
  { status = 'passed', durationMs = 0, completedAt = new Date().toISOString(), testResults = [] } = {}
) {
  const existing = readCoverageState(rootDir);
  const mergedTests = { ...existing.tests };
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const tr of testResults) {
    if (!tr || !tr.specFile || !tr.title) continue;
    const normFile = String(tr.specFile).replace(/\\/g, '/');
    const key = `${normFile}::${tr.title}`;
    const normStatus =
      tr.status === 'passed'
        ? 'passed'
        : tr.status === 'skipped'
          ? 'skipped'
          : 'failed';
    if (normStatus === 'passed') passed++;
    else if (normStatus === 'skipped') skipped++;
    else failed++;

    mergedTests[key] = {
      status: normStatus,
      durationMs: Number(tr.durationMs || 0),
      steps: Array.isArray(tr.steps) ? tr.steps.slice(0, 30) : [],
      ranAt: completedAt,
    };
  }

  const nextState = {
    ...existing,
    lastRun: {
      completedAt,
      status,
      durationMs: Number(durationMs || 0),
      passed,
      failed,
      skipped,
      totalExecuted: passed + failed + skipped,
    },
    tests: mergedTests,
  };
  writeCoverageState(rootDir, nextState);
  return nextState;
}

/**
 * Computes historical coverage growth from git commits (cached by HEAD SHA)
 * without polluting git or causing cross-squad merge conflicts.
 */
function resolveGitCoverageTrend(rootDir, state) {
  try {
    const topRes = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: 1000,
    });
    if (topRes.status !== 0 || !topRes.stdout.trim()) return [];
    const gitTop = path.resolve(topRes.stdout.trim());
    const subPrefixRaw = path.relative(gitTop, path.resolve(rootDir)).replace(/\\/g, '/');
    if (subPrefixRaw.startsWith('..')) return [];
    const pfx = subPrefixRaw ? `${subPrefixRaw}/` : '';

    const headRes = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      timeout: 1000,
    });
    if (headRes.status !== 0) return [];
    const headSha = headRes.stdout.trim();
    if (!headSha) return [];

    if (
      state.gitHistoryCache &&
      state.gitHistoryCache.headSha === headSha &&
      Array.isArray(state.gitHistoryCache.points)
    ) {
      return state.gitHistoryCache.points;
    }

    const pathArgs = [`${pfx}tests`, `${pfx}.exploratory/tapes`, `${pfx}.agents/domain`];
    const logRes = spawnSync(
      'git',
      ['log', '--first-parent', `-n`, String(MAX_GIT_COMMITS), '--format=%H|%ct|%s', '--', ...pathArgs],
      { cwd: gitTop, encoding: 'utf8', timeout: 1500 }
    );
    if (logRes.status !== 0 || !logRes.stdout.trim()) return [];

    const commits = logRes.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [sha, ts, ...subj] = line.split('|');
        return { sha, timestamp: new Date(Number(ts) * 1000).toISOString(), subject: subj.join('|').trim() };
      })
      .filter((c) => /^[0-9a-f]{7,40}$/i.test(c.sha))
      .reverse();

    const points = [];
    for (const c of commits) {
      const treeRes = spawnSync(
        'git',
        ['ls-tree', '-r', '--name-only', c.sha, '--', ...pathArgs],
        { cwd: gitTop, encoding: 'utf8', timeout: 1000 }
      );
      if (treeRes.status !== 0) continue;
      const files = treeRes.stdout.split('\n').filter(Boolean);
      const specFiles = files.filter((f) => f.endsWith('.spec.ts'));
      const tapeFiles = files.filter((f) => f.includes('.exploratory/tapes/') && f.endsWith('.json'));
      const shardFiles = files.filter(
        (f) => f.includes('.agents/domain/') && f.includes('/shards/') && f.endsWith('.md')
      );

      let testCount = specFiles.length;
      if (specFiles.length > 0 && specFiles.length <= 40) {
        const grepRes = spawnSync(
          'git',
          ['grep', '-c', '-E', '\\btest(\\.(only|skip|fixme))?\\s*\\(', c.sha, '--', `${pfx}tests`],
          { cwd: gitTop, encoding: 'utf8', timeout: 1000 }
        );
        if (grepRes.status === 0 && grepRes.stdout.trim()) {
          const sum = grepRes.stdout
            .trim()
            .split('\n')
            .reduce((acc, row) => {
              const cnt = Number(row.split(':').pop());
              return acc + (Number.isFinite(cnt) ? cnt : 0);
            }, 0);
          if (sum > 0) testCount = sum;
        }
      }

      points.push({
        id: c.sha.slice(0, 7),
        label: c.sha.slice(0, 7),
        note: c.subject.slice(0, 60),
        timestamp: c.timestamp,
        source: 'git',
        automatedScenarios: testCount,
        tapeCount: tapeFiles.length,
        totalShards: shardFiles.length,
      });
    }

    state.gitHistoryCache = { headSha, points };
    return points;
  } catch {
    return [];
  }
}

function tokenizeKeywords(str) {
  const STOP = new Set([
    'domain',
    'feature',
    'route',
    'shard',
    'portal',
    'commercial',
    'enterprise',
    'flow',
    'wave',
    'test',
    'spec',
    'page',
    'step',
    'the',
    'and',
    'for',
    'with',
    'from',
    'org',
    'core',
    'unassigned',
  ]);
  return String(str || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
}

function matchShardsForScenario({ routes = [], textBlob = '', scenarioId = '' }, shards) {
  const lowerRoutes = routes.map((r) => String(r).toLowerCase()).filter(Boolean);
  const lowerBlob = String(textBlob || '').toLowerCase();
  const lowerId = String(scenarioId || '').toLowerCase();

  const scored = [];
  for (const sh of shards) {
    let score = 0;
    const shRoutes = (sh.routes || []).map((r) => String(r).toLowerCase());
    for (const tr of lowerRoutes) {
      for (const sr of shRoutes) {
        if (sr === '/' || tr === '/') {
          if (sr === tr) score += 3;
        } else if (sr === '/login' || tr === '/login') {
          if (sr === tr) score += 2;
        } else if (tr === sr) {
          score += 12;
        } else if (tr.includes(sr) || sr.includes(tr)) {
          score += 8;
        }
      }
    }
    for (const cap of sh.capabilities) {
      if (cap && lowerBlob.includes(cap.toLowerCase())) score += 9;
    }
    const slugWords = tokenizeKeywords(sh.slug);
    for (const sw of slugWords) {
      if (lowerId.includes(sw)) score += 7;
      else if (lowerBlob.includes(sw)) score += 3;
    }
    const titleWords = tokenizeKeywords(sh.displayName);
    for (const tw of titleWords) {
      if (lowerId.includes(tw)) score += 4;
      else if (lowerBlob.includes(tw)) score += 1;
    }
    if (score > 0) {
      scored.push({ shard: sh, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.shard);
}

function computeMaturityStage({ env, shards, tapes, automatedScenarios, rootDir }) {
  const hasCi =
    fs.existsSync(path.join(rootDir, '.github/workflows/playwright-ci.yml')) ||
    fs.existsSync(path.join(rootDir, '.azure-pipelines/playwright-ci.yml'));
  const hasRealUrl =
    Boolean(env.baseUrl) &&
    !env.baseUrl.includes('localhost:3000') &&
    !env.baseUrl.includes('your-app-url');

  if (!hasRealUrl && shards.length === 0 && tapes.length === 0 && automatedScenarios.length === 0) {
    return { stage: 0, name: 'Environment Onboarding' };
  }
  if (automatedScenarios.length === 0 && tapes.length === 0) {
    return { stage: 1, name: 'Live Discovery' };
  }
  if (automatedScenarios.length === 0 && tapes.length > 0) {
    return { stage: 2, name: 'Architecture Compilation' };
  }
  if (automatedScenarios.length > 0 && !hasCi) {
    return { stage: 3, name: 'Automated Verification' };
  }
  return { stage: 4, name: 'CI Governed' };
}

export function collectSystemKnowledge(rootDir = process.cwd(), { persistWaveSnapshot = false } = {}) {
  ROOT = path.resolve(rootDir);
  const env = readDomainMemory();
  const shards = readShards();
  const tapes = readTapes();
  const specs = readSpecs();
  const defects = readDefects();
  const src = readSrcInventory();
  const state = readCoverageState(ROOT);

  // Map page fixture camelCase names (e.g. billingPortalPage) -> discovered routes in Page Objects
  const pageRouteByFixture = new Map();
  for (const p of src.pages) {
    const camel = p.name.charAt(0).toLowerCase() + p.name.slice(1);
    pageRouteByFixture.set(camel, p.routes || []);
  }

  const tapeById = new Map(tapes.map((t) => [t.scenarioId, t]));
  const tapeByStem = new Map(tapes.map((t) => [path.basename(t.file, '.json'), t]));
  const compiledTapeIds = new Set();

  // Build unified Business Scenarios (Automated specs + Explored-only tapes)
  const scenarios = [];
  for (const sp of specs) {
    const linkedTape =
      (sp.scenarioId && tapeById.get(sp.scenarioId)) ||
      tapeById.get(sp.stem) ||
      tapeByStem.get(sp.stem) ||
      tapes.find((t) => sp.stem.includes(t.scenarioId) || t.scenarioId.includes(sp.stem)) ||
      null;

    if (linkedTape) compiledTapeIds.add(linkedTape.scenarioId);

    const casesToRender =
      sp.testCases.length > 0
        ? sp.testCases
        : [
            {
              rawTitle: sp.describeTitle || sp.stem,
              displayTitle: sp.describeTitle || sp.stem,
              tags: sp.tags,
              steps: [],
              fixtures: [],
              personas: [],
              routes: [],
              isSkipped: false,
            },
          ];

    for (let idx = 0; idx < casesToRender.length; idx++) {
      const tc = casesToRender[idx];
      const fixtureRoutes = tc.fixtures.flatMap((fx) => pageRouteByFixture.get(fx) || []);
      const tapeRoutes = linkedTape
        ? linkedTape.businessSteps.map((bs) => bs.pageRoute).filter(Boolean)
        : [];
      const candidateRoutes = [...new Set([...tc.routes, ...fixtureRoutes, ...tapeRoutes])];

      const execRecord = state.tests[`${sp.file}::${tc.rawTitle}`] || null;
      const stepTitles =
        tc.steps.length > 0
          ? tc.steps
          : execRecord?.steps?.length > 0
            ? execRecord.steps
            : linkedTape && sp.testCases.length === 1
              ? linkedTape.businessSteps.map((bs) => bs.title)
              : [];

      const matchedShards = matchShardsForScenario(
        {
          routes: candidateRoutes,
          textBlob: `${sp.file} ${sp.describeTitle} ${tc.displayTitle} ${tc.fixtures.join(' ')} ${stepTitles.join(' ')}`,
          scenarioId: linkedTape?.scenarioId || sp.stem,
        },
        shards
      );

      const primaryShard = matchedShards[0] || null;
      const domainKey = primaryShard ? primaryShard.id : '__general__';
      const executionStatus = execRecord
        ? execRecord.status
        : tc.isSkipped
          ? 'skipped'
          : 'not-run';

      scenarios.push({
        id: `${sp.file}#${idx + 1}`,
        lifecycle: 'automated',
        executionStatus,
        durationMs: execRecord?.durationMs ?? null,
        ranAt: execRecord?.ranAt ?? null,
        title: tc.displayTitle,
        suiteTitle: sp.describeTitle || '',
        specFile: sp.file,
        tapeId: linkedTape?.scenarioId || null,
        tags: tc.tags,
        isP0: tc.tags.includes('@p0'),
        isSmoke: tc.tags.includes('@smoke') || tc.tags.includes('@p0'),
        persona:
          tc.personas.length > 0
            ? tc.personas.join(' → ')
            : linkedTape?.personaRole || 'standard',
        routes: candidateRoutes,
        steps: stepTitles,
        domainKey,
        matchedShardIds: matchedShards.map((s) => s.id),
      });
    }
  }

  for (const t of tapes) {
    if (compiledTapeIds.has(t.scenarioId)) continue;
    const tapeRoutes = t.businessSteps.map((bs) => bs.pageRoute).filter(Boolean);
    const matchedShards = matchShardsForScenario(
      {
        routes: tapeRoutes,
        textBlob: `${t.title} ${t.scenarioId} ${t.businessSteps.map((b) => b.title).join(' ')}`,
        scenarioId: t.scenarioId,
      },
      shards
    );
    const primaryShard = matchedShards[0] || null;
    scenarios.push({
      id: `tape:${t.scenarioId}`,
      lifecycle: 'explored-only',
      executionStatus: 'not-automated',
      durationMs: null,
      ranAt: null,
      title: cleanDisplayTitle(t.title) || t.title,
      suiteTitle: 'Exploratory Session Tape (Pending Compilation)',
      specFile: null,
      tapeId: t.scenarioId,
      tags: t.tags,
      isP0: t.tags.includes('@p0'),
      isSmoke: t.tags.includes('@smoke') || t.tags.includes('@p0'),
      persona: t.personaRole,
      routes: [...new Set(tapeRoutes)],
      steps: t.businessSteps.map((bs) => bs.title),
      domainKey: primaryShard ? primaryShard.id : '__general__',
      matchedShardIds: matchedShards.map((s) => s.id),
    });
  }

  // Compute shard coverage using both specs and tapes
  const shardCoverage = shards.map((sh) => {
    const linkedScenarios = scenarios.filter((sc) => sc.matchedShardIds.includes(sh.id));
    const automatedForShard = linkedScenarios.filter((sc) => sc.lifecycle === 'automated');
    const exploredForShard = linkedScenarios.filter((sc) => sc.lifecycle === 'explored-only');

    // Backward-compatible scenarios array (tape IDs + spec stems)
    const matchedTapeIds = [
      ...new Set(
        linkedScenarios.map((sc) => sc.tapeId || (sc.specFile ? path.basename(sc.specFile, '.spec.ts') : sc.id))
      ),
    ];
    const isCovered = automatedForShard.length > 0;
    return {
      ...sh,
      isCovered,
      automatedCount: automatedForShard.length,
      exploredCount: exploredForShard.length,
      p0Count: automatedForShard.filter((s) => s.isP0).length,
      failedCount: automatedForShard.filter((s) => s.executionStatus === 'failed').length,
      scenarios: matchedTapeIds,
    };
  });

  // Deduplicate API endpoints across tapes
  const apiMap = new Map();
  for (const t of tapes) {
    for (const nc of t.networkContracts) {
      const key = `${nc.method} ${nc.urlPattern}`;
      if (!apiMap.has(key)) {
        apiMap.set(key, {
          ...nc,
          scenarios: [t.scenarioId],
        });
      } else if (!apiMap.get(key).scenarios.includes(t.scenarioId)) {
        apiMap.get(key).scenarios.push(t.scenarioId);
      }
    }
  }
  const apis = [...apiMap.values()];

  // Build Business Domain Rollup Cards — partition scenarios by primary domainKey so counts never double-count across cards
  const domains = shardCoverage.map((sh) => {
    const domScenarios = scenarios.filter((sc) => sc.domainKey === sh.id);
    const sharedAutomated = scenarios.filter(
      (sc) => sc.domainKey !== sh.id && sc.lifecycle === 'automated' && sc.matchedShardIds.includes(sh.id)
    );
    const domDefects = defects.filter((d) => {
      const dRoute = d.route.toLowerCase();
      return (
        (dRoute && sh.routes.some((sr) => dRoute.includes(sr.toLowerCase()))) ||
        d.title.toLowerCase().includes(sh.slug)
      );
    });
    const kwList = tokenizeKeywords(`${sh.slug} ${sh.displayName}`);
    const matchArtifact = (item) =>
      (item.routes || []).some((r) => sh.routes.includes(r)) ||
      kwList.some((kw) => item.file.toLowerCase().includes(kw) || item.name.toLowerCase().includes(kw));

    const automated = domScenarios.filter((s) => s.lifecycle === 'automated');
    const explored = domScenarios.filter((s) => s.lifecycle === 'explored-only');
    const passed = automated.filter((s) => s.executionStatus === 'passed').length;
    const failed = automated.filter((s) => s.executionStatus === 'failed').length;
    const stepCount = automated.reduce((sum, s) => sum + s.steps.length, 0);

    let health = 'gap';
    if (failed > 0 || domDefects.length > 0) health = 'attention';
    else if (automated.length > 0 || sharedAutomated.length > 0) health = 'healthy';
    else if (explored.length > 0) health = 'explored';

    return {
      id: sh.id,
      title: sh.displayName,
      ownerSquad: sh.ownerSquad,
      routes: sh.routes,
      capabilities: sh.capabilities,
      lastVerified: sh.lastVerified,
      isCovered: sh.isCovered,
      health,
      automatedCount: automated.length,
      sharedAutomatedCount: sharedAutomated.length,
      sharedTitles: sharedAutomated.slice(0, 3).map((s) => s.title),
      exploredCount: explored.length,
      p0Count: automated.filter((s) => s.isP0).length,
      smokeCount: automated.filter((s) => s.isSmoke).length,
      passedCount: passed,
      failedCount: failed,
      stepCount,
      defectCount: domDefects.length,
      scenarioIds: domScenarios.map((s) => s.id),
      engineering: {
        pages: src.pages.filter(matchArtifact).map((x) => x.name),
        steps: src.steps.filter(matchArtifact).map((x) => x.name),
        components: src.components.filter(matchArtifact).map((x) => x.name),
        seeders: src.seeders.filter(matchArtifact).map((x) => x.name),
        apis: apis
          .filter((a) => kwList.some((kw) => a.urlPattern.toLowerCase().includes(kw)))
          .map((a) => `${a.method} ${a.urlPattern}`),
      },
    };
  });

  const unmatchedScenarios = scenarios.filter((sc) => sc.matchedShardIds.length === 0);
  if (unmatchedScenarios.length > 0) {
    const automated = unmatchedScenarios.filter((s) => s.lifecycle === 'automated');
    const explored = unmatchedScenarios.filter((s) => s.lifecycle === 'explored-only');
    const failed = automated.filter((s) => s.executionStatus === 'failed').length;
    domains.push({
      id: '__general__',
      title: shards.length > 0 ? 'Cross-Domain & End-to-End Lifecycles' : `${env.appName} Core Journeys`,
      ownerSquad: '@org/e2e-lifecycle',
      routes: [...new Set(unmatchedScenarios.flatMap((s) => s.routes))].slice(0, 6),
      capabilities: [],
      lastVerified: null,
      isCovered: automated.length > 0,
      health: failed > 0 ? 'attention' : automated.length > 0 ? 'healthy' : 'explored',
      automatedCount: automated.length,
      exploredCount: explored.length,
      p0Count: automated.filter((s) => s.isP0).length,
      smokeCount: automated.filter((s) => s.isSmoke).length,
      passedCount: automated.filter((s) => s.executionStatus === 'passed').length,
      failedCount: failed,
      stepCount: automated.reduce((sum, s) => sum + s.steps.length, 0),
      defectCount: 0,
      scenarioIds: unmatchedScenarios.map((s) => s.id),
      engineering: {
        pages: src.pages.map((x) => x.name),
        steps: src.steps.map((x) => x.name),
        components: src.components.map((x) => x.name),
        seeders: src.seeders.map((x) => x.name),
        apis: apis.map((a) => `${a.method} ${a.urlPattern}`),
      },
    });
  }

  // Executive KPIs & Risk Attention Items
  const automatedScenarios = scenarios.filter((s) => s.lifecycle === 'automated');
  const exploredOnlyScenarios = scenarios.filter((s) => s.lifecycle === 'explored-only');
  const coveredShards = shardCoverage.filter((s) => s.isCovered).length;
  const totalShards = shardCoverage.length;
  const domainCoveragePct =
    totalShards > 0
      ? Math.round((coveredShards / totalShards) * 100)
      : automatedScenarios.length > 0
        ? 100
        : 0;

  const passedScenarios = automatedScenarios.filter((s) => s.executionStatus === 'passed').length;
  const failedScenarios = automatedScenarios.filter((s) => s.executionStatus === 'failed').length;
  const executedScenarios = passedScenarios + failedScenarios;
  const passRatePct = executedScenarios > 0 ? Math.round((passedScenarios / executedScenarios) * 100) : null;
  const totalBusinessSteps = automatedScenarios.reduce((sum, s) => sum + s.steps.length, 0);
  const maturity = computeMaturityStage({ env, shards: shardCoverage, tapes, automatedScenarios, rootDir: ROOT });

  const attentionItems = [];
  if (failedScenarios > 0) {
    attentionItems.push({
      level: 'high',
      text: `${failedScenarios} automated scenario(s) failed in the latest test run`,
      filter: 'attention',
    });
  }
  if (defects.length > 0) {
    attentionItems.push({
      level: 'high',
      text: `${defects.length} open product defect(s) documented in defects/`,
      filter: 'attention',
    });
  }
  const uncoveredCount = totalShards - coveredShards;
  if (uncoveredCount > 0) {
    attentionItems.push({
      level: 'medium',
      text: `${uncoveredCount} business domain shard(s) have no automated scenarios yet`,
      filter: 'attention',
    });
  }
  if (exploredOnlyScenarios.length > 0) {
    attentionItems.push({
      level: 'info',
      text: `${exploredOnlyScenarios.length} explored journey(s) ready to compile into automated specs`,
      filter: 'explored',
    });
  }

  // Hybrid Coverage Trend (git milestones + uncommitted wave snapshots)
  const gitPoints = resolveGitCoverageTrend(ROOT, state);
  const nowIso = new Date().toISOString();
  const currentSnap = {
    id: 'current',
    label: 'Now',
    note: 'Current workspace coverage',
    timestamp: nowIso,
    source: 'live',
    automatedScenarios: automatedScenarios.length,
    exploredOnlyScenarios: exploredOnlyScenarios.length,
    coveredShards,
    totalShards,
    coveragePct: domainCoveragePct,
  };

  if (persistWaveSnapshot) {
    const prevWave = state.waveSnapshots[state.waveSnapshots.length - 1];
    const changed =
      !prevWave ||
      prevWave.automatedScenarios !== currentSnap.automatedScenarios ||
      prevWave.coveredShards !== currentSnap.coveredShards ||
      prevWave.totalShards !== currentSnap.totalShards ||
      prevWave.exploredOnlyScenarios !== currentSnap.exploredOnlyScenarios;
    if (changed) {
      state.waveSnapshots = [
        ...state.waveSnapshots.slice(-(MAX_WAVE_SNAPSHOTS - 1)),
        {
          ...currentSnap,
          id: `wave-${state.waveSnapshots.length + 1}`,
          label: `Wave ${state.waveSnapshots.length + 1}`,
        },
      ];
    }
    writeCoverageState(ROOT, state);
  }

  const combinedTrend = [];
  const pushDeduped = (pt) => {
    const last = combinedTrend[combinedTrend.length - 1];
    const sameCov =
      last?.coveredShards == null ||
      pt?.coveredShards == null ||
      last.coveredShards === pt.coveredShards;
    if (
      last &&
      last.automatedScenarios === pt.automatedScenarios &&
      (last.totalShards ?? 0) === (pt.totalShards ?? 0) &&
      sameCov
    ) {
      return;
    }
    combinedTrend.push(pt);
  };
  for (const gp of gitPoints) pushDeduped(gp);
  for (const wp of state.waveSnapshots) pushDeduped(wp);
  pushDeduped(currentSnap);

  const baselinePoint = combinedTrend[0] || currentSnap;
  const scenarioDelta = currentSnap.automatedScenarios - (baselinePoint.automatedScenarios || 0);

  return {
    generatedAt: nowIso,
    env,
    executive: {
      domainCoveragePct,
      coveredShards,
      totalShards,
      automatedScenarios: automatedScenarios.length,
      exploredOnlyScenarios: exploredOnlyScenarios.length,
      totalBusinessSteps,
      p0Scenarios: automatedScenarios.filter((s) => s.isP0).length,
      smokeScenarios: automatedScenarios.filter((s) => s.isSmoke).length,
      executedScenarios,
      passedScenarios,
      failedScenarios,
      passRatePct,
      lastRunAt: state.lastRun?.completedAt || null,
      openDefects: defects.length,
      maturity,
      attentionItems,
      scenarioDelta,
    },
    trend: combinedTrend.slice(-12),
    domains,
    scenarios,
    shards: shardCoverage,
    tapes,
    specs,
    defects,
    src,
    apis,
  };
}

function renderHtml(model, { liveReload = false } = {}) {
  const safeJson = JSON.stringify(model)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  const liveReloadScript = liveReload
    ? `
(function() {
  try {
    const es = new EventSource('/__asqe_events');
    es.onmessage = (ev) => {
      if (ev.data === 'refresh') window.location.reload();
    };
  } catch {}
})();`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Agentic-SOLID-QE — Executive Coverage &amp; System Map</title>
<style>
  :root {
    --bg: #f8fafc; --panel: #ffffff; --panel-2: #f1f5f9; --border: #e2e8f0;
    --text: #0f172a; --muted: #475569; --accent: #0284c7; --accent-soft: rgba(2,132,199,.10);
    --green: #059669; --green-soft: rgba(5,150,105,.10);
    --amber: #d97706; --amber-soft: rgba(217,119,6,.12);
    --red: #dc2626; --red-soft: rgba(220,38,38,.10);
    --purple: #7c3aed; --purple-soft: rgba(124,58,237,.10);
    --shadow: 0 1px 3px rgba(15,23,42,.06);
  }
  [data-theme="dark"] {
    --bg: #0b1020; --panel: #121a2f; --panel-2: #18223d; --border: #263354;
    --text: #e6ecf8; --muted: #94a3b8; --accent: #38bdf8; --accent-soft: rgba(56,189,248,.13);
    --green: #34d399; --green-soft: rgba(52,211,153,.13);
    --amber: #fbbf24; --amber-soft: rgba(251,191,36,.14);
    --red: #f87171; --red-soft: rgba(248,113,113,.14);
    --purple: #a78bfa; --purple-soft: rgba(167,139,250,.14);
    --shadow: 0 2px 8px rgba(0,0,0,.28);
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  header { padding: 16px 28px; border-bottom: 1px solid var(--border); background: var(--panel); display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 14px; position: sticky; top: 0; z-index: 20; box-shadow: var(--shadow); }
  header h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .subtitle { font-size: 12.5px; color: var(--muted); }
  .header-controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .segmented { display: inline-flex; background: var(--panel-2); border: 1px solid var(--border); border-radius: 9px; padding: 3px; }
  .seg-btn { border: none; background: transparent; color: var(--muted); padding: 6px 13px; border-radius: 7px; font-size: 12.5px; font-weight: 600; cursor: pointer; transition: all .15s; }
  .seg-btn.active { background: var(--accent); color: #fff; }
  [data-theme="dark"] .seg-btn.active { color: #06121e; }
  .icon-btn { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); padding: 6px 11px; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .icon-btn:hover { border-color: var(--accent); }
  .pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; background: var(--accent-soft); border: 1px solid transparent; color: var(--accent); white-space: nowrap; }
  .pill.green { background: var(--green-soft); color: var(--green); }
  .pill.red { background: var(--red-soft); color: var(--red); }
  .pill.amber { background: var(--amber-soft); color: var(--amber); }
  .pill.purple { background: var(--purple-soft); color: var(--purple); }
  .pill.neutral { background: var(--panel-2); color: var(--muted); border-color: var(--border); }
  .live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); display: inline-block; animation: pulse 1.8s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  main { padding: 22px 28px 48px; max-width: 1380px; margin: 0 auto; }
  .lens { display: none; }
  .lens.active { display: block; }
  .exec-top { display: grid; grid-template-columns: 1fr 310px; gap: 14px; margin-bottom: 16px; align-items: stretch; }
  @media (max-width: 1020px) { .exec-top { grid-template-columns: 1fr; } }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 12px; }
  .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow); display: flex; flex-direction: column; justify-content: space-between; }
  .kpi .val-row { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .kpi .val { font-size: 26px; font-weight: 800; letter-spacing: -0.02em; color: var(--text); }
  .kpi .lbl { font-size: 12px; font-weight: 600; color: var(--muted); margin-top: 2px; }
  .kpi .sub { font-size: 11px; color: var(--muted); margin-top: 6px; }
  .progress-track { height: 7px; background: var(--panel-2); border-radius: 999px; overflow: hidden; margin-top: 8px; }
  .progress-fill { height: 100%; background: var(--green); border-radius: 999px; transition: width .3s ease; }
  .progress-fill.amber { background: var(--amber); }
  .progress-fill.red { background: var(--red); }
  .trend-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; box-shadow: var(--shadow); display: flex; flex-direction: column; justify-content: space-between; }
  .banner { border-radius: 10px; padding: 11px 15px; margin-bottom: 16px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; font-size: 13px; border: 1px solid var(--border); background: var(--panel); }
  .banner.calm { border-color: rgba(5,150,105,.35); background: var(--green-soft); }
  .banner.warn { border-color: rgba(217,119,6,.38); background: var(--amber-soft); }
  .banner.alert { border-color: rgba(220,38,38,.38); background: var(--red-soft); }
  .toolbar { display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-between; align-items: center; margin-bottom: 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; box-shadow: var(--shadow); }
  .search-input { flex: 1; min-width: 220px; background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; font-size: 13px; outline: none; }
  .search-input:focus { border-color: var(--accent); }
  .filter-group { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .filter-chip { border: 1px solid var(--border); background: var(--panel-2); color: var(--muted); padding: 5px 11px; border-radius: 999px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .filter-chip.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  [data-theme="dark"] .filter-chip.active { color: #06121e; }
  .domain-card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 12px; box-shadow: var(--shadow); overflow: hidden; }
  .domain-header { padding: 15px 18px; cursor: pointer; display: grid; grid-template-columns: minmax(220px, 1.5fr) minmax(160px, 1fr) auto; gap: 14px; align-items: center; user-select: none; }
  @media (max-width: 820px) { .domain-header { grid-template-columns: 1fr; } }
  .domain-header:hover { background: var(--panel-2); }
  .domain-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .chevron { display: inline-block; width: 18px; font-size: 12px; color: var(--muted); transition: transform .15s; }
  .domain-card.open .chevron { transform: rotate(90deg); }
  .domain-body { display: none; border-top: 1px solid var(--border); padding: 12px 18px 16px; background: var(--bg); }
  .domain-card.open .domain-body { display: block; }
  .scenario-item { background: var(--panel); border: 1px solid var(--border); border-radius: 9px; margin-bottom: 8px; overflow: hidden; }
  .scenario-row { padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; gap: 10px; cursor: pointer; }
  .scenario-row:hover { background: var(--panel-2); }
  .scenario-title { font-size: 13.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .status-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; display: inline-block; }
  .status-dot.passed { background: var(--green); }
  .status-dot.failed { background: var(--red); }
  .status-dot.automated { background: var(--accent); }
  .status-dot.explored { background: var(--amber); }
  .journey-steps { display: none; border-top: 1px dashed var(--border); padding: 10px 16px 12px 34px; background: var(--panel-2); font-size: 12.5px; }
  .scenario-item.open .journey-steps { display: block; }
  .journey-steps ol { margin: 4px 0 0; padding-left: 18px; }
  .journey-steps li { margin-bottom: 5px; color: var(--text); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 14px; box-shadow: var(--shadow); }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 10px; flex-wrap: wrap; }
  .tab-btn { background: var(--panel); color: var(--muted); border: 1px solid var(--border); padding: 7px 14px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 12.5px; }
  .tab-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  [data-theme="dark"] .tab-btn.active { color: #06121e; }
  .view { display: none; }
  .view.active { display: block; }
  .flow-grid { display: grid; grid-template-columns: 290px 1fr; gap: 16px; }
  @media (max-width: 900px) { .flow-grid { grid-template-columns: 1fr; } }
  .flow-item { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel-2); margin-bottom: 8px; cursor: pointer; }
  .flow-item.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .seq-step { border: 1px solid var(--border); border-radius: 10px; background: var(--panel-2); padding: 13px; margin-bottom: 10px; }
  .seq-row { display: grid; grid-template-columns: 1.2fr 1fr 1.3fr 1fr; gap: 10px; align-items: start; margin-top: 10px; }
  @media (max-width: 900px) { .seq-row { grid-template-columns: 1fr; } }
  .lane { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 12px; }
  .lane h4 { margin: 0 0 6px 0; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .api-badge { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; padding: 4px 6px; background: var(--accent-soft); border: 1px solid var(--border); border-radius: 6px; margin-bottom: 5px; display: block; word-break: break-all; }
  .schema { font-family: ui-monospace, monospace; font-size: 11px; color: var(--muted); }
  .arch-swimlane { border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 12px; background: var(--panel); }
  .arch-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-size: 11px; text-transform: uppercase; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--accent); }
  @media print {
    :root, [data-theme="dark"] {
      --bg: #ffffff; --panel: #ffffff; --panel-2: #f8fafc; --border: #cbd5e1;
      --text: #0f172a; --muted: #475569; --accent: #0369a1; --shadow: none;
    }
    header { position: static; box-shadow: none; }
    .header-controls, .toolbar { display: none !important; }
    #lens-engineering { display: none !important; }
    #lens-business { display: block !important; }
    .domain-card .domain-body { display: block !important; }
    .domain-card, .kpi, .card { break-inside: avoid; }
  }
</style>
</head>
<body>
<header>
  <div>
    <h1>
      <span id="app-title">System &amp; Business Coverage</span>
      <span id="maturity-pill" class="pill purple"></span>
      ${liveReload ? '<span class="pill green"><span class="live-dot"></span>Live Auto-Refresh</span>' : ''}
    </h1>
    <div class="subtitle" id="app-meta"></div>
  </div>
  <div class="header-controls">
    <div class="segmented" role="tablist" aria-label="Audience Lens">
      <button class="seg-btn active" data-lens="business" id="btn-lens-business">Business View</button>
      <button class="seg-btn" data-lens="engineering" id="btn-lens-engineering">Engineering Lens</button>
    </div>
    <button class="icon-btn" id="btn-theme" title="Toggle Light/Dark Theme">Theme</button>
    <button class="icon-btn" id="btn-print" title="Print or Save Executive PDF">Print / PDF</button>
    <span id="generated-at" class="pill neutral"></span>
  </div>
</header>

<main>
  <!-- DEFAULT LENS: BUSINESS STAKEHOLDER VIEW -->
  <section id="lens-business" class="lens active">
    <div class="exec-top">
      <div class="kpis" id="biz-kpis"></div>
      <div class="trend-card" id="trend-card"></div>
    </div>
    <div id="attention-banner"></div>

    <div class="toolbar">
      <input type="search" id="biz-search" class="search-input" placeholder="Search business domains, journeys, or audit steps..." />
      <div class="filter-group" id="biz-filters">
        <button class="filter-chip active" data-filter="all">All Domains</button>
        <button class="filter-chip" data-filter="p0">@p0 Critical</button>
        <button class="filter-chip" data-filter="smoke">@smoke</button>
        <button class="filter-chip" data-filter="attention">Needs Attention</button>
        <button class="filter-chip" data-filter="explored">Explored Only</button>
      </div>
      <button class="icon-btn" id="btn-expand-toggle">Expand All</button>
    </div>

    <div id="domain-list"></div>

    <div class="card" id="biz-defects-card" style="display:none; margin-top:18px;">
      <h3 style="margin:0 0 10px;font-size:14.5px;">Open Product Defects Requiring Triage</h3>
      <div id="biz-defect-list"></div>
    </div>
  </section>

  <!-- SECONDARY LENS: ENGINEERING / SDET ARCHITECTURE -->
  <section id="lens-engineering" class="lens">
    <div class="kpis" id="eng-kpis" style="margin-bottom:16px;"></div>
    <div class="tabs">
      <button class="tab-btn active" data-tab="arch">Domain-Grouped Topology</button>
      <button class="tab-btn" data-tab="flows">Session Tapes &amp; 4-Lane API Sequence</button>
      <button class="tab-btn" data-tab="contracts">Shard &amp; API Contract Matrix</button>
    </div>
    <section id="view-arch" class="view active">
      <div id="arch-swimlanes"></div>
    </section>
    <section id="view-flows" class="view">
      <div class="flow-grid">
        <div class="card">
          <h3 style="margin-top:0;font-size:14px;">Recorded Session Tapes</h3>
          <div id="flow-list"></div>
        </div>
        <div class="card" id="flow-detail"></div>
      </div>
    </section>
    <section id="view-contracts" class="view">
      <div class="card">
        <h3 style="margin-top:0;font-size:14px;">Domain Shards &amp; Traceability</h3>
        <table id="shard-table"></table>
      </div>
      <div class="card">
        <h3 style="margin-top:0;font-size:14px;">Discovered Backend API Contracts</h3>
        <table id="api-table"></table>
      </div>
    </section>
  </section>
</main>

<script>
const MODEL = ${safeJson};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Theme initialization (respects saved preference or OS prefers-color-scheme)
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('asqe_map_theme'); } catch {}
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
})();

document.getElementById('btn-theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', cur);
  try { localStorage.setItem('asqe_map_theme', cur); } catch {}
});
document.getElementById('btn-print').addEventListener('click', () => window.print());

// Header metadata
const EX = MODEL.executive;
document.getElementById('app-title').textContent = MODEL.env.appName + ' — Business Coverage Overview';
document.getElementById('maturity-pill').textContent = 'Stage ' + EX.maturity.stage + ' · ' + EX.maturity.name;
document.getElementById('app-meta').textContent =
  (MODEL.env.baseUrl || 'Target URL pending') +
  (EX.lastRunAt ? '  ·  Last Test Execution: ' + new Date(EX.lastRunAt).toLocaleString() : '');
document.getElementById('generated-at').textContent = 'Updated ' + new Date(MODEL.generatedAt).toLocaleString();

// Audience Lens switcher
document.querySelectorAll('.seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.lens').forEach(l => l.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('lens-' + btn.dataset.lens).classList.add('active');
  });
});

// Business Scorecard KPIs
const covBarClass = EX.domainCoveragePct >= 80 ? '' : EX.domainCoveragePct >= 40 ? 'amber' : 'red';
const deltaBadge = EX.scenarioDelta > 0 ? '<span class="pill green">+' + EX.scenarioDelta + ' growth</span>' : '';
const execHealthVal = EX.passRatePct !== null ? EX.passRatePct + '%' : (EX.automatedScenarios > 0 ? 'Ready' : '—');
const execHealthSub = EX.executedScenarios > 0
  ? (EX.passedScenarios + '/' + EX.executedScenarios + ' passed' + (EX.failedScenarios ? ' · ' + EX.failedScenarios + ' failed' : ''))
  : 'Run tests to record live pass/fail';

const bizKpis = [
  {
    val: EX.domainCoveragePct + '%',
    lbl: 'Business Domain Coverage',
    sub: EX.totalShards ? (EX.coveredShards + ' of ' + EX.totalShards + ' domains automated') : 'Active journey coverage',
    barPct: EX.domainCoveragePct,
    barClass: covBarClass,
  },
  {
    val: EX.automatedScenarios,
    badge: deltaBadge,
    lbl: 'Automated Business Journeys',
    sub: EX.totalBusinessSteps + ' plain-English audit steps' + (EX.exploredOnlyScenarios ? ' · +' + EX.exploredOnlyScenarios + ' explored' : ''),
  },
  {
    val: EX.p0Scenarios,
    lbl: 'Critical Path (@p0) Protected',
    sub: EX.smokeScenarios + ' smoke-gated scenarios',
  },
  {
    val: execHealthVal,
    badge: EX.failedScenarios > 0 ? '<span class="pill red">' + EX.failedScenarios + ' Failing</span>' : (EX.passRatePct === 100 ? '<span class="pill green">Passing</span>' : ''),
    lbl: 'Latest Execution Health',
    sub: execHealthSub,
  },
  {
    val: EX.openDefects,
    badge: EX.openDefects > 0 ? '<span class="pill red">Action Needed</span>' : '<span class="pill green">Clean</span>',
    lbl: 'Open Product Defects',
    sub: EX.openDefects > 0 ? 'Documented in defects/' : 'Zero open regressions',
  },
];

document.getElementById('biz-kpis').innerHTML = bizKpis.map(k =>
  '<div class="kpi">' +
    '<div><div class="val-row"><div class="val">' + esc(k.val) + '</div>' + (k.badge || '') + '</div>' +
    '<div class="lbl">' + esc(k.lbl) + '</div></div>' +
    (typeof k.barPct === 'number'
      ? '<div class="progress-track"><div class="progress-fill ' + (k.barClass || '') + '" style="width:' + k.barPct + '%"></div></div>'
      : '') +
    '<div class="sub">' + esc(k.sub) + '</div>' +
  '</div>'
).join('');

// Coverage Growth Sparkline
(function renderTrend() {
  const box = document.getElementById('trend-card');
  const pts = MODEL.trend || [];
  if (pts.length <= 1) {
    const cur = pts[0] || { automatedScenarios: EX.automatedScenarios };
    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;"><strong style="font-size:12.5px;">Automation Growth Trend</strong><span class="pill neutral">Baseline</span></div>' +
      '<div class="subtitle" style="margin-top:8px;">Currently tracking <strong>' + cur.automatedScenarios + '</strong> automated business scenario(s). As new waves or commits land, coverage velocity will chart here automatically.</div>';
    return;
  }
  const w = 270, h = 64, pad = 6;
  const maxVal = Math.max(1, ...pts.map(p => p.automatedScenarios));
  const coords = pts.map((p, i) => {
    const x = pad + (i / (pts.length - 1)) * (w - pad * 2);
    const y = h - pad - (p.automatedScenarios / maxVal) * (h - pad * 2);
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, p };
  });
  const poly = coords.map(c => c.x + ',' + c.y).join(' ');
  const area = pad + ',' + (h - pad) + ' ' + poly + ' ' + (w - pad) + ',' + (h - pad);
  const first = pts[0].automatedScenarios;
  const last = pts[pts.length - 1].automatedScenarios;
  const diff = last - first;
  box.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;">' +
      '<strong style="font-size:12.5px;">Coverage Velocity</strong>' +
      '<span class="pill ' + (diff >= 0 ? 'green' : 'neutral') + '">' + first + ' → ' + last + ' scenarios</span>' +
    '</div>' +
    '<svg width="100%" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="margin-top:6px;">' +
      '<polygon points="' + area + '" fill="rgba(2,132,199,0.14)" />' +
      '<polyline points="' + poly + '" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />' +
      coords.map(c => '<circle cx="' + c.x + '" cy="' + c.y + '" r="3" fill="var(--accent)"><title>' + esc(c.p.label + ': ' + c.p.automatedScenarios + ' scenarios') + '</title></circle>').join('') +
    '</svg>' +
    '<div class="subtitle" style="display:flex;justify-content:space-between;font-size:11px;"><span>' + esc(pts[0].label) + '</span><span>' + pts.length + ' milestones</span><span>Now</span></div>';
})();

// Risk & Attention Banner
(function renderBanner() {
  const el = document.getElementById('attention-banner');
  const items = EX.attentionItems || [];
  if (!items.length) {
    el.innerHTML = '<div class="banner calm"><div><strong>All Clear:</strong> Every discovered business domain has automated scenario coverage with zero open defects.</div><span class="pill green">Release Ready</span></div>';
    return;
  }
  const hasHigh = items.some(i => i.level === 'high');
  el.innerHTML =
    '<div class="banner ' + (hasHigh ? 'alert' : 'warn') + '">' +
      '<div><strong>Stakeholder Attention:</strong> ' + items.map(i => esc(i.text)).join('  ·  ') + '</div>' +
      '<span class="pill ' + (hasHigh ? 'red' : 'amber') + '">' + items.length + ' item(s)</span>' +
    '</div>';
})();

// Progressive Domain & Business Journey Renderer
const scenarioById = new Map(MODEL.scenarios.map(s => [s.id, s]));
let activeFilter = 'all';
let searchQuery = '';
// Auto-collapse domain cards when suite grows past 8 scenarios so large suites stay calm on 1 screen
let expandAll = MODEL.scenarios.length <= 8;
const openDomains = new Set(expandAll ? MODEL.domains.map(d => d.id) : []);
const openScenarios = new Set();

function matchesScenarioFilter(sc, dom) {
  if (activeFilter === 'p0' && !sc.isP0) return false;
  if (activeFilter === 'smoke' && !sc.isSmoke) return false;
  if (activeFilter === 'explored' && sc.lifecycle !== 'explored-only') return false;
  if (activeFilter === 'attention' && sc.executionStatus !== 'failed' && dom.health !== 'gap' && dom.defectCount === 0) return false;
  if (!searchQuery) return true;
  const hay = (dom.title + ' ' + dom.ownerSquad + ' ' + sc.title + ' ' + sc.tags.join(' ') + ' ' + sc.steps.join(' ')).toLowerCase();
  return hay.includes(searchQuery);
}

function renderBusinessDomains() {
  const container = document.getElementById('domain-list');
  document.getElementById('btn-expand-toggle').textContent = expandAll ? 'Collapse All' : 'Expand All';

  const cardsHtml = [];
  for (const dom of MODEL.domains) {
    const allDomScenarios = dom.scenarioIds.map(id => scenarioById.get(id)).filter(Boolean);
    const visibleScenarios = allDomScenarios.filter(sc => matchesScenarioFilter(sc, dom));

    const domMatchesEmptyGap =
      allDomScenarios.length === 0 &&
      (activeFilter === 'all' || activeFilter === 'attention') &&
      (!searchQuery || (dom.title + ' ' + dom.ownerSquad + ' ' + dom.routes.join(' ')).toLowerCase().includes(searchQuery));

    if (visibleScenarios.length === 0 && !domMatchesEmptyGap) continue;

    const isOpen = openDomains.has(dom.id) || Boolean(searchQuery) || activeFilter !== 'all';
    const healthPill =
      dom.health === 'healthy'
        ? '<span class="pill green">Covered</span>'
        : dom.health === 'attention'
          ? '<span class="pill red">Needs Attention</span>'
          : dom.health === 'explored'
            ? '<span class="pill amber">Explored Only</span>'
            : '<span class="pill amber">Uncovered Gap</span>';

    const pct = (dom.automatedCount > 0 || dom.sharedAutomatedCount > 0) ? 100 : dom.exploredCount > 0 ? 40 : 0;
    const barCls = dom.health === 'attention' ? 'red' : (dom.automatedCount > 0 || dom.sharedAutomatedCount > 0) ? '' : 'amber';
    const countLabel = dom.automatedCount > 0
      ? (dom.automatedCount + ' Automated')
      : dom.sharedAutomatedCount > 0
        ? ('Covered via ' + dom.sharedAutomatedCount + ' Cross-Domain Journey(s)')
        : '0 Automated';

    const scenariosHtml = visibleScenarios.length
      ? visibleScenarios.map(sc => {
          const scOpen = openScenarios.has(sc.id) || Boolean(searchQuery);
          const dotCls =
            sc.executionStatus === 'passed'
              ? 'passed'
              : sc.executionStatus === 'failed'
                ? 'failed'
                : sc.lifecycle === 'automated'
                  ? 'automated'
                  : 'explored';
          const statusLabel =
            sc.executionStatus === 'passed'
              ? '<span class="pill green">Passed</span>'
              : sc.executionStatus === 'failed'
                ? '<span class="pill red">Failed</span>'
                : sc.lifecycle === 'explored-only'
                  ? '<span class="pill amber">Explored · Pending Spec</span>'
                  : '<span class="pill neutral">Automated</span>';

          return (
            '<div class="scenario-item ' + (scOpen ? 'open' : '') + '" data-scid="' + esc(sc.id) + '">' +
              '<div class="scenario-row">' +
                '<div class="scenario-title">' +
                  '<span class="status-dot ' + dotCls + '"></span>' +
                  '<span>' + esc(sc.title) + '</span>' +
                '</div>' +
                '<div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;">' +
                  (sc.isP0 ? '<span class="pill purple">@p0</span>' : sc.isSmoke ? '<span class="pill">@smoke</span>' : '') +
                  (sc.persona && sc.persona !== 'standard' ? '<span class="pill neutral">' + esc(sc.persona) + '</span>' : '') +
                  '<span class="pill neutral">' + sc.steps.length + ' step' + (sc.steps.length === 1 ? '' : 's') + '</span>' +
                  statusLabel +
                '</div>' +
              '</div>' +
              '<div class="journey-steps">' +
                (sc.steps.length
                  ? '<div class="subtitle" style="font-weight:600;margin-bottom:4px;">Business Audit Steps:</div><ol>' +
                    sc.steps.map(st => '<li>' + esc(st) + '</li>').join('') +
                    '</ol>'
                  : '<div class="subtitle">Single-step automated verification (' + esc(sc.specFile || sc.tapeId || '') + ')</div>') +
              '</div>' +
            '</div>'
          );
        }).join('')
      : (dom.sharedAutomatedCount > 0
          ? '<div class="subtitle" style="padding:6px 2px;">Exercised end-to-end by cross-domain journeys: ' + (dom.sharedTitles || []).map(t => '<strong>' + esc(t) + '</strong>').join(', ') + '</div>'
          : '<div class="subtitle" style="padding:6px 2px;">No automated journeys mapped to this domain yet. Run exploration to capture baseline flows.</div>');

    cardsHtml.push(
      '<div class="domain-card ' + (isOpen ? 'open' : '') + '" data-domid="' + esc(dom.id) + '">' +
        '<div class="domain-header">' +
          '<div>' +
            '<div class="domain-title"><span class="chevron">▶</span>' + esc(dom.title) + ' ' + healthPill + '</div>' +
            '<div class="subtitle" style="margin-left:26px;">Owner: <strong>' + esc(dom.ownerSquad) + '</strong>' +
              (dom.routes.length ? '  ·  ' + dom.routes.slice(0, 4).map(r => '<code>' + esc(r) + '</code>').join(' ') : '') +
            '</div>' +
          '</div>' +
          '<div>' +
            '<div style="display:flex;justify-content:space-between;font-size:12px;font-weight:600;">' +
              '<span>' + countLabel + (dom.exploredCount ? ' · ' + dom.exploredCount + ' Explored' : '') + '</span>' +
              '<span class="subtitle">' + (dom.stepCount ? dom.stepCount + ' steps' : '') + '</span>' +
            '</div>' +
            '<div class="progress-track"><div class="progress-fill ' + barCls + '" style="width:' + pct + '%"></div></div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">' +
            (dom.p0Count ? '<span class="pill purple">' + dom.p0Count + ' @p0</span>' : '') +
            (dom.passedCount ? '<span class="pill green">' + dom.passedCount + ' Passed</span>' : '') +
            (dom.failedCount ? '<span class="pill red">' + dom.failedCount + ' Failed</span>' : '') +
            (dom.defectCount ? '<span class="pill red">' + dom.defectCount + ' Defect(s)</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="domain-body">' + scenariosHtml + '</div>' +
      '</div>'
    );
  }

  container.innerHTML = cardsHtml.length
    ? cardsHtml.join('')
    : '<div class="card"><div class="subtitle">No business domains or journeys match your current filter.</div></div>';

  container.querySelectorAll('.domain-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      const id = hdr.parentElement.dataset.domid;
      if (openDomains.has(id)) openDomains.delete(id);
      else openDomains.add(id);
      hdr.parentElement.classList.toggle('open');
    });
  });

  container.querySelectorAll('.scenario-row').forEach(row => {
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = row.parentElement.dataset.scid;
      if (openScenarios.has(id)) openScenarios.delete(id);
      else openScenarios.add(id);
      row.parentElement.classList.toggle('open');
    });
  });
}

document.getElementById('biz-search').addEventListener('input', (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  renderBusinessDomains();
});

document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    activeFilter = chip.dataset.filter;
    renderBusinessDomains();
  });
});

document.getElementById('btn-expand-toggle').addEventListener('click', () => {
  expandAll = !expandAll;
  openDomains.clear();
  if (expandAll) MODEL.domains.forEach(d => openDomains.add(d.id));
  renderBusinessDomains();
});

if (MODEL.defects.length > 0) {
  document.getElementById('biz-defects-card').style.display = 'block';
  document.getElementById('biz-defect-list').innerHTML = MODEL.defects.map(d =>
    '<div class="flow-item"><span class="pill red">' + esc(d.severity) + '</span> <strong>' + esc(d.title) + '</strong>' +
    '<div class="subtitle" style="margin-top:4px;">' + esc(d.route) + (d.endpoint ? ' · <code>' + esc(d.endpoint) + '</code>' : '') + '</div></div>'
  ).join('');
}

// ---------------- ENGINEERING LENS ----------------
const engKpis = [
  { val: MODEL.shards.length, lbl: 'Domain Shards' },
  { val: MODEL.specs.length, lbl: 'Spec Files (' + EX.automatedScenarios + ' tests)' },
  { val: MODEL.tapes.length, lbl: 'Session Tapes' },
  { val: MODEL.src.pages.length + MODEL.src.steps.length, lbl: 'SOLID Pages & Steps' },
  { val: MODEL.src.components.length, lbl: 'UI Components' },
  { val: (MODEL.src.seeders || []).length, lbl: 'State Seeders' },
  { val: MODEL.apis.length, lbl: 'API Contracts' },
];
document.getElementById('eng-kpis').innerHTML = engKpis.map(k =>
  '<div class="kpi"><div class="val">' + k.val + '</div><div class="lbl">' + esc(k.lbl) + '</div></div>'
).join('');

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.tab).classList.add('active');
  });
});

function renderEngineeringTopology() {
  const wrap = document.getElementById('arch-swimlanes');
  const renderList = (arr) => arr.length ? arr.slice(0, 12).map(x => '<div><code>' + esc(x) + '</code></div>').join('') + (arr.length > 12 ? '<div class="subtitle">+' + (arr.length - 12) + ' more</div>' : '') : '<span class="subtitle">—</span>';
  wrap.innerHTML = MODEL.domains.map(d =>
    '<div class="arch-swimlane">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">' +
        '<div><strong>' + esc(d.title) + '</strong> <span class="pill neutral">' + esc(d.ownerSquad) + '</span></div>' +
        '<div class="subtitle">' + d.routes.map(r => '<code>' + esc(r) + '</code>').join(' ') + '</div>' +
      '</div>' +
      '<div class="arch-cols">' +
        '<div class="lane"><h4>Pages &amp; Steps (' + (d.engineering.pages.length + d.engineering.steps.length) + ')</h4>' + renderList([...d.engineering.pages, ...d.engineering.steps]) + '</div>' +
        '<div class="lane"><h4>UI Components (' + d.engineering.components.length + ')</h4>' + renderList(d.engineering.components) + '</div>' +
        '<div class="lane"><h4>State Seeders (' + d.engineering.seeders.length + ')</h4>' + renderList(d.engineering.seeders) + '</div>' +
        '<div class="lane"><h4>Backend APIs (' + d.engineering.apis.length + ')</h4>' + renderList(d.engineering.apis) + '</div>' +
      '</div>' +
    '</div>'
  ).join('');
}

let selectedTape = 0;
function renderEngineeringFlows() {
  const list = document.getElementById('flow-list');
  const detail = document.getElementById('flow-detail');
  if (!MODEL.tapes.length) {
    list.innerHTML = '<div class="subtitle">No Session Tapes recorded. Specs authored directly appear in Business View.</div>';
    detail.innerHTML = '';
    return;
  }
  list.innerHTML = MODEL.tapes.map((t, i) =>
    '<div class="flow-item ' + (i === selectedTape ? 'active' : '') + '" data-idx="' + i + '">' +
      '<div style="font-weight:600;font-size:13px;">' + esc(t.title) + '</div>' +
      '<div style="margin-top:5px;display:flex;gap:5px;flex-wrap:wrap;">' +
        '<span class="pill neutral">' + esc(t.charter) + '</span>' +
        t.tags.map(tg => '<span class="pill green">' + esc(tg) + '</span>').join('') +
      '</div>' +
    '</div>'
  ).join('');
  list.querySelectorAll('.flow-item').forEach(el => {
    el.addEventListener('click', () => { selectedTape = Number(el.dataset.idx); renderEngineeringFlows(); });
  });

  const t = MODEL.tapes[selectedTape];
  detail.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;">' +
      '<div><h3 style="margin:0;font-size:15.5px;">' + esc(t.title) + '</h3>' +
      '<div class="subtitle">Scenario: <code>' + esc(t.scenarioId) + '</code> · Persona: <code>' + esc(t.personaRole) + '</code> · Builder: <code>' + esc(t.dataBuilderRef || '—') + '</code></div></div>' +
      '<div>' + t.tags.map(tg => '<span class="pill green" style="margin-left:4px;">' + esc(tg) + '</span>').join('') + '</div>' +
    '</div>' +
    t.businessSteps.map((s, idx) =>
      '<div class="seq-step">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;"><strong>' + (idx + 1) + '. ' + esc(s.title) + '</strong>' + (s.pageRoute ? '<span class="pill neutral">' + esc(s.pageRoute) + '</span>' : '') + '</div>' +
        '<div class="seq-row">' +
          '<div class="lane"><h4>User Interaction</h4>' + (s.actions.length ? s.actions.map(a => '<div><code>' + esc(a.action) + '</code> ' + esc(a.intent) + '</div>').join('') : '<span class="subtitle">Assertion step</span>') + '</div>' +
          '<div class="lane"><h4>UI Components</h4>' + (s.components.length ? s.components.map(c => '<div><code>' + esc(c) + '</code></div>').join('') : '<span class="subtitle">—</span>') + '</div>' +
          '<div class="lane"><h4>Backend API Calls</h4>' + (s.apis.length ? s.apis.map(api => '<span class="api-badge">' + esc(api.method) + ' ' + esc(api.urlPattern) + ' → ' + esc(api.expectedStatus) + '</span><div class="schema">' + esc(api.responseSchemaSummary) + '</div>').join('') : '<span class="subtitle">Client-side</span>') + '</div>' +
          '<div class="lane"><h4>Expected Outcome</h4>' + (s.outcomes.length ? s.outcomes.map(o => '<div><code>' + esc(o.assertionType) + '</code> ' + esc(o.description) + '</div>').join('') : '<span class="subtitle">Advances flow</span>') + '</div>' +
        '</div>' +
      '</div>'
    ).join('');
}

function renderContractsTable() {
  document.getElementById('shard-table').innerHTML =
    '<thead><tr><th>Shard</th><th>Owner</th><th>Routes</th><th>Automated</th><th>Status</th><th>Last Verified</th></tr></thead><tbody>' +
    MODEL.shards.map(s =>
      '<tr><td><strong>' + esc(s.title) + '</strong><br/><code>' + esc(s.file) + '</code></td>' +
      '<td>' + esc(s.ownerSquad) + '</td>' +
      '<td>' + s.routes.map(r => '<code>' + esc(r) + '</code>').join(' ') + '</td>' +
      '<td>' + (s.automatedCount || 0) + ' scenario(s)</td>' +
      '<td>' + (s.isCovered ? '<span class="pill green">Covered</span>' : '<span class="pill amber">Uncovered</span>') + '</td>' +
      '<td>' + esc(s.lastVerified || '—') + '</td></tr>'
    ).join('') + '</tbody>';

  document.getElementById('api-table').innerHTML = MODEL.apis.length
    ? '<thead><tr><th>Endpoint</th><th>Expected HTTP</th><th>Client Candidate</th><th>Scenarios</th></tr></thead><tbody>' +
      MODEL.apis.map(a =>
        '<tr><td><code>' + esc(a.method + ' ' + a.urlPattern) + '</code></td>' +
        '<td>' + esc(a.expectedStatus) + '</td>' +
        '<td><code>' + esc(a.clientCandidate || '—') + '</code></td>' +
        '<td>' + a.scenarios.map(sc => '<code>' + esc(sc) + '</code>').join(' ') + '</td></tr>'
      ).join('') + '</tbody>'
    : '<tbody><tr><td class="subtitle">No API network contracts recorded yet.</td></tr></tbody>';
}

renderBusinessDomains();
renderEngineeringTopology();
renderEngineeringFlows();
renderContractsTable();
${liveReloadScript}
</script>
</body>
</html>`;
}

export function buildSystemMap({
  rootDir = process.cwd(),
  outPath = path.join(rootDir, 'reports', 'system-map.html'),
  quiet = false,
  jsonOnly = false,
  persistWaveSnapshot = true,
} = {}) {
  ROOT = path.resolve(rootDir);
  const resolvedRoot = ROOT;
  const resolvedOut = assertSafeWorkspacePath(resolvedRoot, outPath, 'system map');

  const model = collectSystemKnowledge(resolvedRoot, { persistWaveSnapshot: !jsonOnly && persistWaveSnapshot });
  if (jsonOnly) {
    if (!quiet) console.log(JSON.stringify(model, null, 2));
    return { model, outPath: resolvedOut };
  }
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, renderHtml(model, { liveReload: false }), 'utf8');
  if (!quiet) {
    console.log(
      `🗺️  Generated Stakeholder & System Map -> ${rel(resolvedOut)} (${model.executive.domainCoveragePct}% domain coverage, ${model.executive.automatedScenarios} automated journey(s), ${model.shards.length} shard(s), ${model.defects.length} defect(s)).`
    );
  }
  return { model, outPath: resolvedOut };
}

/**
 * Starts a loopback-only live-reload HTTP server (`npx cortex map --serve`)
 * that regenerates `reports/system-map.html` and notifies connected browsers via SSE
 * whenever automation coverage or test execution state updates.
 */
export function serveSystemMap({
  rootDir = process.cwd(),
  outPath = path.join(rootDir, 'reports', 'system-map.html'),
  port = 4321,
} = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const safePort = Number(port);
  if (!Number.isInteger(safePort) || safePort < 1024 || safePort > 65535) {
    throw new Error(`Invalid --port '${port}'. Must be an integer between 1024 and 65535.`);
  }

  let latestModel = buildSystemMap({ rootDir: resolvedRoot, outPath, quiet: true }).model;
  const clients = new Set();

  const server = http.createServer((req, res) => {
    const reqUrl = (req.url || '/').split('?')[0];
    if (reqUrl === '/__asqe_events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (reqUrl === '/api/model.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(latestModel));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderHtml(latestModel, { liveReload: true }));
  });

  const watchTargets = ['tests', '.exploratory/tapes', '.agents/domain', 'defects', 'src', 'reports'];
  let debounceTimer = null;
  const watchers = [];
  const scheduleRefresh = (changedFile = '') => {
    if (changedFile && changedFile.endsWith('system-map.html')) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        latestModel = buildSystemMap({ rootDir: resolvedRoot, outPath, quiet: true }).model;
        for (const client of clients) {
          client.write('data: refresh\n\n');
        }
      } catch {
        /* ignore transient partial-write errors */
      }
    }, 250);
  };

  for (const relDir of watchTargets) {
    const fullDir = path.join(resolvedRoot, relDir);
    if (!fs.existsSync(fullDir)) continue;
    try {
      watchers.push(
        fs.watch(fullDir, { recursive: true }, (_event, filename) => {
          scheduleRefresh(String(filename || ''));
        })
      );
    } catch {
      /* recursive fs.watch fallback ignored if unsupported */
    }
  }

  server.listen(safePort, '127.0.0.1', () => {
    console.log(
      `🟢 Live Stakeholder Coverage Map running at http://127.0.0.1:${safePort} (auto-refreshing on coverage & test updates)`
    );
  });

  const shutdown = () => {
    clearTimeout(debounceTimer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {}
    }
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: cortex map [--out <path>] [--json] [--serve [--port 4321]]`);
    process.exit(0);
  }
  const outEq = args.find((a) => a.startsWith('--out='));
  const outIdx = args.indexOf('--out');
  const outPath = outEq
    ? outEq.slice('--out='.length)
    : outIdx !== -1 && args[outIdx + 1]
      ? args[outIdx + 1]
      : path.join(process.cwd(), 'reports', 'system-map.html');
  const portEq = args.find((a) => a.startsWith('--port='));
  const portIdx = args.indexOf('--port');
  const port = portEq
    ? Number(portEq.slice('--port='.length))
    : portIdx !== -1 && args[portIdx + 1]
      ? Number(args[portIdx + 1])
      : 4321;

  if (args.includes('--serve')) {
    serveSystemMap({ rootDir: process.cwd(), outPath, port });
  } else {
    const jsonOnly = args.includes('--json');
    buildSystemMap({ rootDir: process.cwd(), outPath, jsonOnly });
  }
}
