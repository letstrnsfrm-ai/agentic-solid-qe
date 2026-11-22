#!/usr/bin/env node
/**
 * Token-Efficient Coverage, Traceability, Federated Brain & Onboarding Analyzer.
 * Scans domain-memory.md, 3-Tier Domain Hubs & Shards, .exploratory/tapes/, defects/, src/, and tests/*.spec.ts
 * to compute uncompiled Session Tapes, uncovered/stale shards, open defects, and recommended next actions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDomainGraph } from './build-domain-graph.mjs';
import { isCompactMode } from './lib/cli-output.mjs';

const MAX_SCAN_FILE_BYTES = 1024 * 1024; // 1 MB cap

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
        /* skip unreadable file */
      }
    }
  }
  return files;
}

export function analyzeCoverage(
  rootDir = process.cwd(),
  { squad = null, summary = false, full = false, writeGraph = true } = {}
) {
  const ROOT = rootDir;
  const filterSquad = squad ? String(squad).trim().toLowerCase() : null;
  if (filterSquad && !/^[a-z0-9-]+$/.test(filterSquad)) {
    throw new Error(`Invalid --squad value '${filterSquad}'. Must match ^[a-z0-9-]+$.`);
  }
  const forceSummary = Boolean(summary);
  const forceFull = Boolean(full);

  // 0. Compile Federated Domain Graph (.agents/domain/domain-graph.json)
  const domainGraph = buildDomainGraph({ rootDir: ROOT, writeToDisk: writeGraph });
  const { appName, baseUrl } = domainGraph.targetApp;
  const needsTargetUrlConfig =
    baseUrl.includes('localhost:3000') || baseUrl.includes('your-app-url');
  const savedAuthSessions = walkFiles(path.join(ROOT, '.auth'), '.json').map((f) =>
    path.relative(ROOT, f)
  );

// 1. Automated Specs & Test Cases
const specFiles = walkFiles(path.join(ROOT, 'tests'), '.spec.ts');
const specsWithContent = specFiles.map((f) => {
  const content = fs.readFileSync(f, 'utf8');
  const testTitles = [...content.matchAll(/\btest\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const tags = [...new Set([...content.matchAll(/@[a-z0-9-]+/gi)].map((m) => m[0]))].filter(
    (t) =>
      ![
        '@playwright',
        '@fixtures',
        '@components',
        '@pages',
        '@contracts',
        '@data',
        '@domains',
        '@shared',
      ].includes(t)
  );
  return {
    file: path.relative(ROOT, f),
    testCount: testTitles.length,
    tags,
    tests: testTitles,
    rawContent: content,
  };
});

// 2. Recorded Session Tapes, API Contracts, Multi-Portal Auth Readiness & Traceability to Specs
const apiClientFilePaths = [
  ...walkFiles(path.join(ROOT, 'src/api'), '.client.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.client.ts'),
];
const exportedApiClientClasses = new Set();
for (const cf of apiClientFilePaths) {
  const code = fs.readFileSync(cf, 'utf8');
  for (const m of code.matchAll(/\bexport\s+class\s+([A-Za-z0-9_]+)/g)) {
    exportedApiClientClasses.add(m[1]);
  }
}

const discoveredApiContracts = [];
const unimplementedApiClientSet = new Set();
const missingAuthSessionSet = new Set();
const handoffRecommendations = [];
const MILESTONE_REGEX = /\b(checkout|submit|payment|order|quote|policy|claim|approve|create|register|confirm)\b/i;

const tapeFiles = walkFiles(path.join(ROOT, '.exploratory/tapes'), '.json');
const tapes = tapeFiles.map((f) => {
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const scenarioId = data.scenarioId || path.basename(f, '.json');
    const scenarioIdRe = new RegExp(`(?<![a-z0-9-])${String(scenarioId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`);
    const matchingSpec =
      specsWithContent.find((s) => path.basename(s.file, '.spec.ts') === scenarioId) ||
      specsWithContent.find((s) => scenarioIdRe.test(s.rawContent));

    const requiredSessions = [];
    if (data.persona?.storageStatePath) {
      requiredSessions.push(data.persona.storageStatePath);
    }
    if (Array.isArray(data.actors)) {
      for (const actor of data.actors) {
        if (actor?.storageStatePath) {
          requiredSessions.push(actor.storageStatePath);
        }
      }
    }
    for (const sessRel of requiredSessions) {
      if (!fs.existsSync(path.join(ROOT, sessRel))) {
        missingAuthSessionSet.add(sessRel);
      }
    }

    if (Array.isArray(data.networkContracts)) {
      for (const nc of data.networkContracts) {
        const candidate = nc.clientCandidate || null;
        const isClientImplemented = candidate ? exportedApiClientClasses.has(candidate) : false;
        if (candidate && !isClientImplemented) {
          unimplementedApiClientSet.add(candidate);
        }
        discoveredApiContracts.push({
          scenarioId,
          method: nc.method,
          urlPattern: nc.urlPattern || nc.endpointPattern,
          expectedStatus: nc.expectedStatus,
          clientCandidate: candidate,
          isClientImplemented,
        });
      }
    }

    const steps = Array.isArray(data.semanticSteps) ? data.semanticSteps : [];
    const stepCount = steps.length;
    const distinctRoutes = [
      ...new Set(
        steps
          .map((s) => s.pageRoute || (s.action === 'goto' ? s.locatorContract?.value : null))
          .filter(Boolean)
      ),
    ];
    const distinctPortals = [
      ...new Set(steps.map((s) => s.portalUrl).filter(Boolean)),
    ];
    let milestoneStepIndex = 0;
    for (let idx = 0; idx < steps.length - 1; idx++) {
      const s = steps[idx];
      if (
        s.capturesVariable ||
        s.action === 'apiCall' ||
        MILESTONE_REGEX.test(`${s.intent || ''} ${s.businessStep || ''}`)
      ) {
        milestoneStepIndex = s.stepIndex || idx + 1;
      }
    }

    const splitReasons = [];
    if (stepCount >= 10) splitReasons.push(`stepCount=${stepCount} (>= 10)`);
    if (distinctRoutes.length >= 3) splitReasons.push(`distinctRoutes=${distinctRoutes.length} (>= 3)`);
    if (distinctPortals.length >= 2 || (Array.isArray(data.actors) && data.actors.length >= 2)) {
      splitReasons.push('cross-portal/multi-actor boundary');
    }
    if (milestoneStepIndex > 0 && stepCount >= 6) {
      splitReasons.push(`state-creation milestone at step ${milestoneStepIndex}`);
    }

    if (!data.resumesFrom && splitReasons.length > 0) {
      const suggestedSplitStep =
        milestoneStepIndex > 0 ? Math.min(milestoneStepIndex + 1, stepCount) : Math.ceil(stepCount / 2) + 1;
      const hasApiSignals =
        (Array.isArray(data.networkContracts) && data.networkContracts.length > 0) ||
        steps.some((s) => s.action === 'apiCall');
      const recommendedHandoffStrategy = hasApiSignals ? 'api-seed' : 'checkpoint-state';
      handoffRecommendations.push({
        scenarioId,
        stepCount,
        distinctRoutesCount: distinctRoutes.length,
        reasons: splitReasons,
        suggestedSplitStep,
        recommendedHandoffStrategy,
        suggestedNextAction: `Split '${scenarioId}' at step ${suggestedSplitStep} into '${scenarioId}-part-1' -> '${scenarioId}-part-2' with resumesFrom ({ scenarioId: '${scenarioId}-part-1', handoffStrategy: '${recommendedHandoffStrategy}' }) or run 'npm run test:explore' to attach at Point B.`,
      });
    }

    return {
      scenarioId,
      charter: data.charter,
      persona: data.persona?.role,
      actors: Array.isArray(data.actors) ? data.actors.map((a) => a.actorId) : [],
      apiContractCount: Array.isArray(data.networkContracts) ? data.networkContracts.length : 0,
      stepCount,
      resumesFrom: data.resumesFrom || null,
      title: data.title,
      compiledToSpec: matchingSpec ? matchingSpec.file : null,
    };
  } catch {
    return {
      scenarioId: path.basename(f),
      charter: 'invalid-json',
      compiledToSpec: null,
    };
  }
});

const uncompiledTapes = tapes
  .filter((t) => !t.compiledToSpec && t.charter !== 'invalid-json')
  .map((t) => t.scenarioId);
const unimplementedApiClients = [...unimplementedApiClientSet];
const missingAuthSessions = [...missingAuthSessionSet];

// 3. Domain Shards (Global + Squad-Scoped) & Coverage Mapping
const shards = domainGraph.shards.map((shard) => {
  const shardKey = shard.id.toLowerCase();
  const isCoveredBySpec = specsWithContent.some((s) => {
    const specName = path.basename(s.file, '.spec.ts').toLowerCase();
    const parts = shardKey.split('-').filter((p) => p.length > 2);
    return (
      specName.includes(shardKey) ||
      parts.some((p) => specName.includes(p)) ||
      s.rawContent.toLowerCase().includes(shardKey)
    );
  });
  return {
    file: shard.path,
    squad: shard.squad,
    ownerSquad: shard.ownerSquad,
    lastVerified: shard.lastVerified,
    isStale: shard.isStale,
    publishedCapabilities: shard.publishedCapabilities,
    title: shard.title,
    routes: shard.routes,
    isCoveredBySpec,
  };
});

const uncoveredShards = shards.filter((s) => !s.isCoveredBySpec).map((s) => s.file);
const staleShards = shards.filter((s) => s.isStale).map((s) => s.file);

// 4. Open Defects
const defectFiles = walkFiles(path.join(ROOT, 'defects'), '.md').filter(
  (f) => path.basename(f).toLowerCase() !== 'readme.md'
);
const openDefects = defectFiles.map((f) => path.relative(ROOT, f));

// 5. Existing SOLID Architecture (Global + Domain-Scoped)
const contracts = walkFiles(path.join(ROOT, 'src/contracts'), '.ts').map((f) => path.basename(f));
const components = [
  ...walkFiles(path.join(ROOT, 'src/components'), '.ts').filter((f) => !f.endsWith('.step.ts')),
  ...walkFiles(path.join(ROOT, 'src/shared/components'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.component.ts'),
].map((f) => path.basename(f));
const wizardSteps = [
  ...walkFiles(path.join(ROOT, 'src/components'), '.step.ts'),
  ...walkFiles(path.join(ROOT, 'src/steps'), '.step.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.step.ts'),
].map((f) => path.basename(f));
const pages = [
  ...walkFiles(path.join(ROOT, 'src/pages'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.page.ts'),
].map((f) => path.basename(f));
const dataBuilders = [
  ...walkFiles(path.join(ROOT, 'src/data'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.builder.ts'),
].map((f) => path.basename(f));
const apiClients = apiClientFilePaths.map((f) => path.basename(f));

// 6. Compute Recommended Next Action & 5-Stage Incremental Coverage Maturity
let recommendedNextAction;
let nextSingleScenarioToAutomate = null;
let coverageMaturityStage;

const hasMultiPersonaOrBoundary = tapes.some((t) =>
  ['multi-persona-auth', 'boundary-analysis', 'state-interruption', 'accessibility-audit'].includes(
    t.charter
  )
);
const hasEnterprisePatterns =
  wizardSteps.length > 0 ||
  apiClients.length > 0 ||
  tapes.some((t) => ['api-contract', 'cross-portal-handoff'].includes(t.charter));

if (missingAuthSessions.length > 0 || (shards.length === 0 && specsWithContent.length === 0)) {
  coverageMaturityStage = {
    stage: 0,
    name: 'Stage 0: Foundation, Auth & Legacy Onboarding',
    nextMilestone:
      'Configure target Base URL, capture .auth/<persona>.json via /00-env-bootstrap, and seed initial route shards (or migrate legacy prompts/scripts via /05-skill-migrator).',
  };
} else if (uncompiledTapes.length > 0 || uncoveredShards.length > 0) {
  coverageMaturityStage = {
    stage: 1,
    name: 'Stage 1: P0 Golden-Path Baseline (1 Test at a Time)',
    nextMilestone:
      'Cover every domain shard with 1 @p0 happy-path Session Tape (/01-cli-explorer) and compile it into SOLID TypeScript (/02-solid-architect <scenario>).',
  };
} else if (!hasMultiPersonaOrBoundary) {
  coverageMaturityStage = {
    stage: 2,
    name: 'Stage 2: Persona, Boundary & Resilience Expansion (@smoke / @regression)',
    nextMilestone:
      'Layer multi-persona-auth, boundary-analysis, state-interruption, and accessibility-audit scenarios reusing existing SOLID Components and Data Builders.',
  };
} else if (!hasEnterprisePatterns || unimplementedApiClients.length > 0) {
  coverageMaturityStage = {
    stage: 3,
    name: 'Stage 3: Complex Wizards, Backend API Seeding & Cross-Portal Handoffs',
    nextMilestone:
      'Add WizardStepContract steps, ApiClientContract + AuthTokenBridge backend seeders, and cross-portal-handoff multi-actor flows 1 test at a time.',
  };
} else {
  coverageMaturityStage = {
    stage: 4,
    name: 'Stage 4: Sharded CI/CD Execution & Continuous Drift Healing',
    nextMilestone:
      'Curate @p0/@smoke/@regression tags in sharded CI (/04-ci-pipeline), re-verify stale shards, and heal live drift via /03-drift-healer.',
  };
}

if (missingAuthSessions.length > 0) {
  recommendedNextAction = `Invoke /00-env-bootstrap to capture missing persona session(s) required by Session Tapes: ${missingAuthSessions.join(', ')}`;
} else if (uncompiledTapes.length > 0) {
  nextSingleScenarioToAutomate = uncompiledTapes[0];
  recommendedNextAction = `Invoke '/02-solid-architect ${nextSingleScenarioToAutomate}' (or run 'npx cortex compile ${nextSingleScenarioToAutomate} --apply') to compile and verify 1 Session Tape at a time (${uncompiledTapes.length} uncompiled: ${uncompiledTapes.join(', ')})`;
} else if (shards.length === 0 && specsWithContent.length === 0) {
  recommendedNextAction = needsTargetUrlConfig
    ? `Invoke /00-env-bootstrap (or run 'npm run init:app -- --url <https://your-app> --name "<App Name>"') to configure Base URL, capture auth state, and discover initial feature shards.`
    : `Invoke /00-env-bootstrap to capture persona auth state and map unfamiliar app routes, or /01-cli-explorer to explore ${baseUrl} in --headed mode.`;
} else if (uncoveredShards.length > 0) {
  nextSingleScenarioToAutomate = uncoveredShards[0];
  recommendedNextAction = `Invoke /01-cli-explorer to explore 1 critical business flow for uncovered shard '${nextSingleScenarioToAutomate}' (${uncoveredShards.length} uncovered total: ${uncoveredShards.join(', ')})`;
} else if (staleShards.length > 0) {
  recommendedNextAction = `Invoke /03-drift-healer or /01-cli-explorer to re-verify stale domain shard(s): ${staleShards.join(', ')}`;
} else {
  recommendedNextAction = `All ${shards.length} domain shard(s) and ${tapes.length} tape(s) have spec coverage. Invoke /agentic-solid-qe to plan the next incremental coverage stage, /01-cli-explorer for the next single P1/P2 business scenario or backend API contract, /03-drift-healer to triage test failures, or /04-ci-pipeline to curate CI tags & sharded workflows.`;
}

const matchSquad = (p) =>
  !filterSquad || String(p || '').toLowerCase().includes(filterSquad);

const scopedShards = shards.filter((s) => !filterSquad || s.squad === filterSquad || matchSquad(s.path));
const scopedUncovered = uncoveredShards.filter(matchSquad);
const scopedStale = staleShards.filter(matchSquad);
const scopedTapes = tapes.filter((t) => !filterSquad || matchSquad(t.file) || matchSquad(t.scenarioId));
const scopedUncompiled = uncompiledTapes.filter(matchSquad);
const scopedSpecs = specsWithContent
  .filter((s) => !filterSquad || matchSquad(s.file))
  .map(({ rawContent, ...rest }) => rest);

const pendingUpgradePatches = walkFiles(path.join(ROOT, '.agents/upgrade-patches')).map((f) =>
  path.relative(ROOT, f).replace(/\\/g, '/')
);
let installedFrameworkVersion = null;
const manifestFilePath = path.join(ROOT, '.agents/framework-manifest.json');
if (fs.existsSync(manifestFilePath)) {
  try {
    installedFrameworkVersion = JSON.parse(fs.readFileSync(manifestFilePath, 'utf8')).version || null;
  } catch {
    /* ignore malformed manifest */
  }
}
const upgradeStatus = {
  installedVersion: installedFrameworkVersion,
  pendingUpgradePatches,
};

const scopedHandoffRecommendations = handoffRecommendations.filter(
  (h) => !filterSquad || matchSquad(h.scenarioId)
);

let legacyMigrationProgress = null;
const migrationManifestPath = path.join(ROOT, '.agents/domain/migration-manifest.json');
if (fs.existsSync(migrationManifestPath)) {
  try {
    const mm = JSON.parse(fs.readFileSync(migrationManifestPath, 'utf8'));
    const items = Object.values(mm.items || {});
    const countsByStatus = { discovered: 0, decomposed: 0, taped: 0, verified: 0 };
    let nextRecommendedLegacyTest = null;
    for (const item of items) {
      const hasCompiledSpec =
        Array.isArray(item.tapes) &&
        item.tapes.some((tp) => {
          const sid = path.basename(tp, '.json');
          return specsWithContent.some((s) => s.rawContent.includes(sid));
        });
      const effectiveStatus = hasCompiledSpec ? 'verified' : item.status || 'discovered';
      countsByStatus[effectiveStatus] = (countsByStatus[effectiveStatus] || 0) + 1;
      if (!nextRecommendedLegacyTest && effectiveStatus === 'discovered') {
        nextRecommendedLegacyTest = {
          id: item.id,
          wave: item.wave,
          kind: item.kind,
          file: item.file,
          command: `npm run migrate:skill -- --legacy ${item.id}`,
        };
      }
    }
    legacyMigrationProgress = {
      stacks: mm.stacks || [],
      legacySourceRoot: mm.legacySourceRoot || '..',
      totalLegacyTests: items.length,
      ...countsByStatus,
      nextRecommendedLegacyTest,
    };
  } catch {
    /* ignore malformed migration manifest */
  }
}

const isCompact = !forceFull && (forceSummary || scopedSpecs.length + scopedTapes.length > 25);

const report = isCompact
  ? {
      masterOrchestratorSkill: '/agentic-solid-qe',
      mode: 'compact-summary',
      ...(filterSquad ? { squadFilter: filterSquad } : {}),
      coverageMaturityStage,
      upgradeStatus,
      ...(legacyMigrationProgress ? { legacyMigrationProgress } : {}),
      targetApp: {
        appName,
        baseUrl,
        needsTargetUrlConfig,
        savedAuthSessionsCount: savedAuthSessions.length,
        missingAuthSessions,
      },
      counts: {
        domainShards: scopedShards.length,
        uncoveredShards: scopedUncovered.length,
        staleShards: scopedStale.length,
        recordedTapes: scopedTapes.length,
        uncompiledTapes: scopedUncompiled.length,
        automatedSpecs: scopedSpecs.length,
        components: components.length,
        pages: pages.length,
        wizardSteps: wizardSteps.length,
        apiClients: apiClients.length,
        openDefects: openDefects.length,
        pendingUpgradePatches: pendingUpgradePatches.length,
        handoffRecommendations: scopedHandoffRecommendations.length,
      },
      topUncoveredShards: scopedUncovered.slice(0, 10),
      topUncompiledTapes: scopedUncompiled.slice(0, 10),
      topStaleShards: scopedStale.slice(0, 10),
      topOpenDefects: openDefects.slice(0, 10),
      topHandoffRecommendations: scopedHandoffRecommendations.slice(0, 5),
      nextSingleScenarioToAutomate,
      recommendedNextAction,
    }
  : {
      masterOrchestratorSkill: '/agentic-solid-qe',
      ...(filterSquad ? { squadFilter: filterSquad } : {}),
      coverageMaturityStage,
      upgradeStatus,
      ...(legacyMigrationProgress ? { legacyMigrationProgress } : {}),
      targetApp: {
        appName,
        baseUrl,
        needsTargetUrlConfig,
        savedAuthSessions,
        missingAuthSessions,
      },
      federatedBrain: {
        domainGraphPath: '.agents/domain/domain-graph.json',
        domainHubs: domainGraph.domainHubs,
        routeIndex: domainGraph.routeIndex,
        staleShards: scopedStale,
      },
      domainShards: scopedShards,
      uncoveredShards: scopedUncovered,
      recordedSessionTapes: scopedTapes,
      uncompiledTapes: scopedUncompiled,
      handoffRecommendations: scopedHandoffRecommendations,
      discoveredApiContracts,
      unimplementedApiClients,
      nextSingleScenarioToAutomate,
      openDefects,
      automatedSpecs: scopedSpecs,
      existingArchitecture: {
        contracts,
        pages: pages.filter(matchSquad),
        components: components.filter(matchSquad),
        wizardSteps: wizardSteps.filter(matchSquad),
        dataBuilders: dataBuilders.filter(matchSquad),
        apiClients: apiClients.filter(matchSquad),
      },
      recommendedNextAction,
    };

  return report;
}

export function formatCompactCoverage(report) {
  const stage = report.coverageMaturityStage || {};
  const counts = report.counts || {
    domainShards: (report.domainShards || []).length,
    uncoveredShards: (report.uncoveredShards || []).length,
    recordedTapes: (report.recordedSessionTapes || []).length,
    uncompiledTapes: (report.uncompiledTapes || []).length,
    automatedSpecs: (report.automatedSpecs || []).length,
    components: (report.existingArchitecture?.components || []).length,
    pages: (report.existingArchitecture?.pages || []).length,
    openDefects: (report.openDefects || []).length,
  };
  const uncompiled = (report.uncompiledTapes || report.topUncompiledTapes || [])
    .map((t) => (typeof t === 'string' ? t : t.scenarioId || t.file))
    .slice(0, 5);
  const uncovered = (report.uncoveredShards || report.topUncoveredShards || [])
    .map((s) => (typeof s === 'string' ? s : s.file || s.shard))
    .slice(0, 5);
  const missingAuth = (report.targetApp?.missingAuthSessions || []).slice(0, 4);
  const lines = [
    `STAGE  | ${stage.stage ?? '?'} — ${stage.name || 'Unknown'}`,
    `APP    | ${report.targetApp?.baseUrl || 'unconfigured'}${missingAuth.length ? ` | missingAuth=[${missingAuth.join(', ')}]` : ''}`,
    `COUNTS | shards=${counts.domainShards} uncovered=${counts.uncoveredShards} tapes=${counts.recordedTapes} uncompiled=${counts.uncompiledTapes} specs=${counts.automatedSpecs} comps=${counts.components} defects=${counts.openDefects}`,
  ];
  if (uncompiled.length) lines.push(`UNCOMP | ${uncompiled.join(', ')}`);
  if (uncovered.length) lines.push(`UNCOV  | ${uncovered.join(', ')}`);
  if (report.nextSingleScenarioToAutomate) {
    const nxt = report.nextSingleScenarioToAutomate;
    lines.push(`PICK   | ${typeof nxt === 'string' ? nxt : nxt.scenarioId || JSON.stringify(nxt)}`);
  }
  const rawNext = String(report.recommendedNextAction || '').trim();
  const clippedNext =
    rawNext.length > 180 ? `${rawNext.slice(0, 177).replace(/\s+\S*$/, '')}...` : rawNext;
  lines.push(`NEXT   | ${clippedNext}`);
  return lines.join('\n');
}

const isMain =
  Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: npx cortex coverage [--squad <id>] [--summary|--compact|--full|--verbose] [--json]'
    );
    process.exit(0);
  }
  let filterSquad = null;
  let forceSummary = false;
  let forceFull = false;
  let jsonOnly = false;
  let compactOut = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--squad' && args[i + 1]) {
      filterSquad = args[++i].trim().toLowerCase();
    } else if (args[i].startsWith('--squad=')) {
      filterSquad = args[i].slice('--squad='.length).trim().toLowerCase();
    } else if (args[i] === '--summary') {
      forceSummary = true;
    } else if (args[i] === '--full' || args[i] === '--verbose') {
      forceFull = true;
    } else if (args[i] === '--json') {
      jsonOnly = true;
    } else if (args[i] === '--compact') {
      compactOut = true;
    }
  }
  const useCompact =
    !jsonOnly &&
    !forceSummary &&
    !forceFull &&
    (compactOut || isCompactMode(args, { autoNonTty: false }));

  let report;
  try {
    report = analyzeCoverage(process.cwd(), {
      squad: filterSquad,
      summary: forceSummary || useCompact,
      full: forceFull,
      writeGraph: true,
    });
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
  if (useCompact) {
    console.log(formatCompactCoverage(report));
  } else {
    if (!jsonOnly) {
      console.log('📊 Agentic-SOLID-QE Coverage & Federated Brain Snapshot:\n');
    }
    console.log(JSON.stringify(report, null, 2));
  }
}
