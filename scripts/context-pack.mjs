#!/usr/bin/env node
/**
 * Cortex Context Pack Builder (`npx cortex context`).
 *
 * Replaces 5–8 multi-turn file reads (domain-memory, domain-graph, shards,
 * pages, components, builders, and 200+ line tape JSON) with a single
 * token-bounded (<400 tok default) context pack scoped to a route, squad,
 * Session Tape, or Playwright spec.
 *
 * Usage:
 *   npx cortex context
 *   npx cortex context --route /checkout
 *   npx cortex context --squad motor-b2c
 *   npx cortex context --tape saucedemo-e2e-checkout
 *   npx cortex context --spec tests/e2e-checkout.spec.ts
 *   npx cortex context --max-tokens 500 --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capToTokens, estimateTokens } from './lib/cli-output.mjs';
import { buildImpactGraph, getFileImpact } from './impact-graph.mjs';

const __filename = fileURLToPath(import.meta.url);

function readTextSafe(filePath) {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  } catch {
    return '';
  }
}

function readJsonSafe(filePath) {
  const raw = readTextSafe(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function walkFiles(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) return [];
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      results.push(...walkFiles(full, predicate));
    } else if (predicate(full)) {
      results.push(full);
    }
  }
  return results.sort();
}

function extractClassSignature(filePath, rootDir) {
  const src = readTextSafe(filePath);
  const rel = path.relative(rootDir, filePath).replace(/\\/g, '/');
  const classMatch = src.match(/export\s+class\s+(\w+)/);
  const className = classMatch ? classMatch[1] : path.basename(filePath, '.ts');
  const locators = [...src.matchAll(/readonly\s+(\w+)\s*:\s*Locator/g)].map((m) => m[1]);
  const methods = [
    ...src.matchAll(/^\s*(?:public\s+)?(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/gm),
  ]
    .map((m) => m[1])
    .filter((m) => !['constructor', 'if', 'for', 'while', 'switch', 'catch'].includes(m));
  return {
    rel,
    className,
    locators: [...new Set(locators)],
    methods: [...new Set(methods)],
  };
}

function formatLocatorShort(lc) {
  if (!lc || typeof lc !== 'object') return '?';
  const strat = lc.strategy || '?';
  if (strat === 'url') return `url(${lc.value || '/'})`;
  if (strat === 'getByRole') return `role:${lc.role || '?'}[${JSON.stringify(lc.value || '')}]`;
  return `${strat}(${JSON.stringify(lc.value || '')})`;
}

/**
 * Formats a v1 Session Tape JSON object into an ultra-compact DSL view (~120–180 tok vs ~1,700 tok JSON).
 */
export function summarizeTapeCompact(tape) {
  if (!tape || typeof tape !== 'object') return '';
  const lines = [];
  const tags = Array.isArray(tape.tags) ? tape.tags.join(' ') : '';
  const persona = tape.persona
    ? `${tape.persona.role || '?'}${tape.persona.dataBuilderRef ? ` (${tape.persona.dataBuilderRef})` : ''}`
    : 'none';
  lines.push(`TAPE   | ${tape.scenarioId || '?'} — ${tape.title || ''}`);
  lines.push(
    `META   | charter=${tape.charter || '?'} | tags=${tags || 'none'} | persona=${persona}${tape.baseUrl ? ` | base=${tape.baseUrl}` : ''}`
  );
  if (tape.resumesFrom?.scenarioId) {
    lines.push(
      `RESUME | from=${tape.resumesFrom.scenarioId} (${tape.resumesFrom.handoffStrategy || 'ui-prereq'})`
    );
  }
  const steps = Array.isArray(tape.semanticSteps) ? tape.semanticSteps : [];
  if (steps.length > 0) {
    lines.push(`STEPS (${steps.length}):`);
    for (const st of steps) {
      const idx = st.stepIndex ?? '?';
      const act = st.action || '?';
      const comp = st.componentCandidate ? ` @${st.componentCandidate}` : '';
      const loc = st.locatorContract ? ` ${formatLocatorShort(st.locatorContract)}` : '';
      const val = st.inputDataRef
        ? ` <- ${st.inputDataRef}`
        : st.key
          ? ` key=${st.key}`
          : '';
      const wait = st.waitForUrl ? ` -> url:${st.waitForUrl}` : '';
      lines.push(`  ${idx}. ${act}${comp}${loc}${val}${wait}  # ${st.intent || ''}`);
    }
  }
  const expects = Array.isArray(tape.expectedStates) ? tape.expectedStates : [];
  if (expects.length > 0) {
    lines.push(`EXPECT (${expects.length}):`);
    for (const ex of expects) {
      const target = [ex.targetComponent || ex.target || '?', ex.targetProperty].filter(Boolean).join('.');
      const assertion = ex.assertionType || ex.assertion || ex.type || '?';
      const valRef = ex.expectedValueRef || (ex.expectedValue !== undefined ? JSON.stringify(ex.expectedValue) : '');
      lines.push(`  - ${target}: ${assertion}${valRef ? `(${valRef})` : ''}`);
    }
  }
  return lines.join('\n');
}

function loadTapeById(rootDir, tapeId) {
  const safeId = String(tapeId || '').replace(/\.json$/i, '').trim();
  if (!safeId || safeId.includes('..') || /[\\/]/.test(safeId)) return null;
  const resolvedRoot = path.resolve(rootDir);
  const tapesRoot = path.resolve(resolvedRoot, '.exploratory/tapes');
  const direct = path.resolve(tapesRoot, `${safeId}.json`);
  if ((direct === tapesRoot || direct.startsWith(`${tapesRoot}${path.sep}`)) && fs.existsSync(direct)) {
    try {
      if (fs.lstatSync(direct).isSymbolicLink()) return null;
      const realRoot = fs.realpathSync(resolvedRoot);
      const realDirect = fs.realpathSync(direct);
      const rel = path.relative(realRoot, realDirect);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    } catch {
      return null;
    }
    return { path: direct, data: readJsonSafe(direct) };
  }
  const allTapes = walkFiles(tapesRoot, (f) => f.endsWith('.json'));
  for (const f of allTapes) {
    const data = readJsonSafe(f);
    if (data?.scenarioId === safeId || path.basename(f, '.json') === safeId) {
      return { path: f, data };
    }
  }
  return null;
}

function collectShards(rootDir, { route = '', squad = '' } = {}) {
  const shardFiles = [
    ...walkFiles(path.join(rootDir, '.agents/domain/shards'), (f) => f.endsWith('.md')),
    ...walkFiles(
      path.join(rootDir, '.agents/domain/domains'),
      (f) => f.replace(/\\/g, '/').includes('/shards/') && f.endsWith('.md')
    ),
  ];
  const normRoute = String(route || '').trim().toLowerCase();
  const routeSlug = normRoute.replace(/^\/+/, '');
  const normSquad = String(squad || '').trim().toLowerCase();
  const shards = [];
  for (const file of shardFiles) {
    const rel = path.relative(rootDir, file).replace(/\\/g, '/');
    const content = readTextSafe(file);
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const routes = [...new Set([...content.matchAll(/`(\/[a-zA-Z0-9._:/{}-]*)`/g)].map((m) => m[1]))];
    const shardSquad = rel.includes('/domains/') ? rel.split('/domains/')[1].split('/')[0].toLowerCase() : 'root';
    const matchesSquad = !normSquad || shardSquad === normSquad || rel.toLowerCase().includes(normSquad);
    const matchesRoute =
      !normRoute ||
      routes.some((r) => {
        const rl = r.toLowerCase();
        if (rl === '/' || normRoute === '/') return rl === normRoute;
        return rl.includes(normRoute) || normRoute.includes(rl);
      }) ||
      (routeSlug.length > 0 && path.basename(file, '.md').toLowerCase().includes(routeSlug));
    if (matchesSquad && matchesRoute) {
      const bullets = content
        .split('\n')
        .filter((l) => /^\s*[-*]\s+/.test(l))
        .map((l) => l.trim().slice(0, 110))
        .slice(0, 6);
      shards.push({
        rel,
        squad: shardSquad,
        title: titleMatch ? titleMatch[1].trim() : path.basename(file, '.md'),
        routes,
        bullets,
      });
    }
  }
  return shards;
}

function collectArchitecture(rootDir, { squad = '', keywords = [] } = {}) {
  const normSquad = String(squad || '').trim().toLowerCase();
  if (normSquad && !/^[a-z0-9-]+$/.test(normSquad)) {
    throw new Error(`Security Error: Invalid --squad '${squad}'. Must match /^[a-z0-9-]+$/.`);
  }
  const resolvedRoot = path.resolve(rootDir);
  const kwLower = keywords.map((k) => String(k || '').toLowerCase()).filter((k) => k.length >= 2);
  const srcRoot = normSquad
    ? path.resolve(resolvedRoot, 'src/domains', normSquad)
    : path.resolve(resolvedRoot, 'src');
  const relSrc = path.relative(resolvedRoot, srcRoot);
  if (relSrc.startsWith('..') || path.isAbsolute(relSrc)) {
    throw new Error(`Security Error: Squad source root escapes workspace root.`);
  }

  const scanDir = (relSub) => {
    const candidates = [path.join(rootDir, 'src', relSub)];
    if (normSquad) candidates.unshift(path.join(srcRoot, relSub));
    else {
      const domDir = path.join(rootDir, 'src/domains');
      if (fs.existsSync(domDir)) {
        for (const d of fs.readdirSync(domDir, { withFileTypes: true })) {
          if (d.isDirectory()) candidates.push(path.join(domDir, d.name, relSub));
        }
      }
    }
    const seen = new Set();
    const out = [];
    for (const dir of candidates) {
      for (const f of walkFiles(dir, (p) => p.endsWith('.ts'))) {
        if (seen.has(f)) continue;
        seen.add(f);
        out.push(extractClassSignature(f, rootDir));
      }
    }
    if (kwLower.length > 0) {
      const matched = out.filter((item) => {
        const hay = `${item.rel} ${item.className} ${item.methods.join(' ')} ${item.locators.join(' ')}`.toLowerCase();
        return kwLower.some((k) => hay.includes(k));
      });
      return matched.length > 0 ? matched : out.slice(0, 4);
    }
    return out;
  };

  return {
    pages: scanDir('pages'),
    components: scanDir('components'),
    builders: scanDir('data'),
    apiClients: scanDir('api'),
    seeders: scanDir('seeders'),
    flows: scanDir('flows'),
  };
}

const NON_TEST_TAGS = new Set([
  '@fixtures',
  '@data',
  '@pages',
  '@components',
  '@contracts',
  '@domains',
  '@shared',
  '@playwright',
]);

function inspectSpec(rootDir, specArg) {
  const resolvedRoot = path.resolve(rootDir);
  const resolved = path.resolve(resolvedRoot, String(specArg || ''));
  const relCheck = path.relative(resolvedRoot, resolved);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return null;
  try {
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    const realRoot = fs.realpathSync(resolvedRoot);
    const realTarget = fs.realpathSync(resolved);
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null;
  } catch {
    return null;
  }
  const src = readTextSafe(resolved);
  const rel = path.relative(resolvedRoot, resolved).replace(/\\/g, '/');
  const tags = [...new Set([...src.matchAll(/@[a-zA-Z0-9_-]+/g)].map((m) => m[0]))].filter(
    (t) => !NON_TEST_TAGS.has(t)
  );
  const steps = [...src.matchAll(/test\.step\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const fixturesUsed = [
    ...new Set(
      [...src.matchAll(/async\s*\(\s*\{([^}]+)\}/g)]
        .flatMap((m) => m[1].split(',').map((s) => s.trim().split(':')[0].trim()))
        .filter(Boolean)
    ),
  ];
  const tapeMatch =
    src.match(/tapes\/([a-zA-Z0-9_-]+)\.json/) ||
    src.match(/Compiled from Session Tape:\s*([a-zA-Z0-9_-]+)/i);
  return {
    rel,
    tags,
    steps,
    fixturesUsed,
    linkedTapeId: tapeMatch ? tapeMatch[1] : null,
  };
}

export function buildContextPack(
  rootDir = process.cwd(),
  { route = '', squad = '', tape = '', spec = '', file = '' } = {}
) {
  const domainMemory = readTextSafe(path.join(rootDir, '.agents/domain/domain-memory.md'));
  const baseUrlMatch = domainMemory.match(/Base URL[^`]*`([^`]+)`/i) || domainMemory.match(/https?:\/\/[^\s)>`]+/);
  const baseUrl = baseUrlMatch ? (baseUrlMatch[1] || baseUrlMatch[0]) : 'unconfigured';

  const authDir = path.join(rootDir, '.auth');
  const authSessions = fs.existsSync(authDir)
    ? fs.readdirSync(authDir).filter((f) => f.endsWith('.json')).sort()
    : [];

  const tapeEntry = tape ? loadTapeById(rootDir, tape) : null;
  const specInfo = spec ? inspectSpec(rootDir, spec) : null;
  const effectiveTape = tapeEntry || (specInfo?.linkedTapeId ? loadTapeById(rootDir, specInfo.linkedTapeId) : null);

  const keywords = [];
  if (route) keywords.push(...route.split(/[/?=&_-]+/).filter(Boolean));
  if (squad) keywords.push(squad);
  if (file) keywords.push(...path.basename(file, '.ts').split(/[.-]+/).filter(Boolean));
  if (effectiveTape?.data) {
    keywords.push(...String(effectiveTape.data.scenarioId || '').split('-'));
    for (const st of effectiveTape.data.semanticSteps || []) {
      if (st.componentCandidate) keywords.push(st.componentCandidate.replace(/Component|Page/g, ''));
    }
  }
  if (specInfo) {
    keywords.push(...specInfo.fixturesUsed.map((f) => f.replace(/Page|Component/g, '')));
    keywords.push(...path.basename(specInfo.rel, '.spec.ts').split('-'));
  }

  const shards = collectShards(rootDir, { route, squad });
  const arch = collectArchitecture(rootDir, { squad, keywords });

  // Compute reverse-dependency blast radius for --file or shared modules consumed by --spec
  let impact = null;
  if (file || specInfo) {
    try {
      const graph = buildImpactGraph(rootDir);
      if (file) {
        const fileImpact = getFileImpact(rootDir, file, { graph });
        impact = { target: fileImpact, sharedModules: fileImpact.isShared || fileImpact.fanIn >= 2 ? [fileImpact] : [] };
      } else if (specInfo) {
        const sharedModules = Object.values(graph.nodes)
          .filter((n) => n.affectedSpecs.includes(specInfo.rel) && (n.isShared || n.fanIn >= 2))
          .sort((a, b) => b.fanIn - a.fanIn)
          .slice(0, 6);
        if (sharedModules.length > 0) {
          impact = { target: null, sharedModules };
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  const lowerKeywords = [...new Set(keywords.map((k) => String(k).toLowerCase()).filter((k) => k.length >= 2))];
  const scoreRelevance = (text) => {
    if (lowerKeywords.length === 0) return 0;
    const hay = String(text || '').toLowerCase();
    let score = 0;
    for (const kw of lowerKeywords) {
      if (hay.includes(kw)) score += kw.length;
    }
    return score;
  };

  const allTapes = walkFiles(path.join(rootDir, '.exploratory/tapes'), (f) => f.endsWith('.json'))
    .map((f) => {
      const d = readJsonSafe(f);
      const scenarioId = d?.scenarioId || path.basename(f, '.json');
      const routesText = (d?.semanticSteps || []).map((s) => `${s.pageRoute || ''} ${s.locatorContract?.value || ''}`).join(' ');
      return {
        scenarioId,
        steps: Array.isArray(d?.semanticSteps) ? d.semanticSteps.length : 0,
        tags: Array.isArray(d?.tags) ? d.tags : [],
        _score: scoreRelevance(`${scenarioId} ${d?.title || ''} ${routesText}`),
      };
    })
    .sort((a, b) => b._score - a._score || a.scenarioId.localeCompare(b.scenarioId))
    .map(({ _score, ...rest }) => rest);

  const allSpecs = walkFiles(path.join(rootDir, 'tests'), (f) => f.endsWith('.spec.ts'))
    .map((f) => path.relative(rootDir, f).replace(/\\/g, '/'))
    .sort((a, b) => scoreRelevance(b) - scoreRelevance(a) || a.localeCompare(b));

  return {
    scope: {
      route: route || null,
      squad: squad || null,
      tape: tape || null,
      spec: spec || null,
      file: file || null,
    },
    app: { baseUrl, authSessions },
    shards,
    architecture: arch,
    impact,
    tapeSummary: effectiveTape?.data ? summarizeTapeCompact(effectiveTape.data) : null,
    tapeData: effectiveTape?.data || null,
    specInfo,
    tapes: allTapes,
    specs: allSpecs,
  };
}

export function formatContextPack(pack, { maxTokens = 400 } = {}) {
  const lines = [];
  const scopeBits = Object.entries(pack.scope)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`);
  lines.push(`CONTEXT | ${scopeBits.length > 0 ? scopeBits.join(' ') : 'repo-overview'} | base=${pack.app.baseUrl} | auth=[${pack.app.authSessions.join(', ') || 'none'}]`);

  if (pack.specInfo) {
    lines.push(
      `SPEC   | ${pack.specInfo.rel} | tags=${pack.specInfo.tags.join(' ') || 'none'} | fixtures=[${pack.specInfo.fixturesUsed.join(', ')}]`
    );
    if (pack.specInfo.steps.length > 0) {
      lines.push(`BSTEPS | ${pack.specInfo.steps.join(' -> ')}`);
    }
  }

  if (pack.impact?.target) {
    const t = pack.impact.target;
    const tag = t.isShared ? `SHARED risk=${t.riskTier}` : `risk=${t.riskTier}`;
    lines.push(
      `IMPACT | ${t.file} [${tag} fanIn=${t.fanIn}] -> ${t.affectedSpecs.slice(0, 5).join(', ') || 'none'}${t.affectedSpecs.length > 5 ? ` (+${t.affectedSpecs.length - 5} more)` : ''}`
    );
  } else if (pack.impact?.sharedModules?.length) {
    const items = pack.impact.sharedModules
      .slice(0, 4)
      .map((m) => `${path.basename(m.file)}(${m.fanIn}s${m.isShared ? ',SHARED' : ''})`)
      .join(', ');
    lines.push(`IMPACT | Shared deps (prefer additive OCP or run affected): ${items}`);
  }

  if (pack.tapeSummary) {
    lines.push(pack.tapeSummary);
  }

  if (pack.shards.length > 0) {
    lines.push(`SHARDS (${pack.shards.length}):`);
    for (const sh of pack.shards.slice(0, 5)) {
      lines.push(`  - ${sh.rel} [${sh.routes.join(', ') || 'no-routes'}]: ${sh.title}`);
      if (pack.scope.route || pack.scope.squad) {
        for (const b of sh.bullets.slice(0, 3)) {
          lines.push(`    ${b}`);
        }
      }
    }
  }

  const fmtSig = (item) => {
    const parts = [];
    if (item.methods.length) parts.push(`fn:${item.methods.slice(0, 5).join(',')}`);
    if (item.locators.length) parts.push(`loc:${item.locators.slice(0, 5).join(',')}`);
    return `${item.className}(${parts.join('; ')})`;
  };

  const { pages, components, builders, apiClients, seeders, flows } = pack.architecture;
  if (pages.length) lines.push(`PAGES  | ${pages.slice(0, 6).map(fmtSig).join(' | ')}`);
  if (components.length) lines.push(`COMPS  | ${components.slice(0, 8).map(fmtSig).join(' | ')}`);
  if (builders.length) lines.push(`DATA   | ${builders.slice(0, 6).map(fmtSig).join(' | ')}`);
  if (apiClients.length) lines.push(`API    | ${apiClients.slice(0, 4).map(fmtSig).join(' | ')}`);
  if (seeders.length) lines.push(`SEEDS  | ${seeders.slice(0, 4).map(fmtSig).join(' | ')}`);
  if (flows.length) lines.push(`FLOWS  | ${flows.slice(0, 4).map(fmtSig).join(' | ')}`);

  if (!pack.tapeSummary && pack.tapes.length > 0) {
    lines.push(
      `TAPES  | ${pack.tapes.slice(0, 8).map((t) => `${t.scenarioId}(${t.steps}s)`).join(', ')}`
    );
  }
  if (!pack.specInfo && pack.specs.length > 0) {
    lines.push(`SPECS  | ${pack.specs.slice(0, 8).join(', ')}`);
  }

  return capToTokens(lines.join('\n'), maxTokens, 'narrow --route/--squad/--tape/--spec/--file or raise --max-tokens');
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
})();

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: npx cortex context [--route <path>] [--squad <squad>] [--tape <id>] [--spec <path>] [--file <src-path>] [--max-tokens <n>] [--json]`);
    process.exit(0);
  }
  const getVal = (flag) => {
    const idx = args.indexOf(flag);
    if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    return eq ? eq.slice(flag.length + 1) : '';
  };
  const route = getVal('--route');
  const squad = getVal('--squad');
  const tape = getVal('--tape');
  const spec = getVal('--spec');
  const file = getVal('--file');
  const maxTokens = Math.max(120, Math.min(2000, Number(getVal('--max-tokens')) || 400));
  const jsonOnly = args.includes('--json');

  const pack = buildContextPack(process.cwd(), { route, squad, tape, spec, file });
  if (jsonOnly) {
    const out = { ...pack, tapeData: undefined, estimatedTokens: estimateTokens(formatContextPack(pack, { maxTokens })) };
    console.log(JSON.stringify(out));
  } else {
    console.log(formatContextPack(pack, { maxTokens }));
  }
}
