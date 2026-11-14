#!/usr/bin/env node
/**
 * Token-Efficient Coverage, Traceability, Federated Brain & Onboarding Analyzer.
 * Scans domain-memory.md, 3-Tier Domain Hubs & Shards, .exploratory/tapes/, defects/, src/, and tests/*.spec.ts
 * to compute uncompiled Session Tapes, uncovered/stale shards, open defects, and recommended next actions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDomainGraph } from './build-domain-graph.mjs';

const ROOT = process.cwd();

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
      files.push(fullPath);
    }
  }
  return files;
}

// 0. Compile Federated Domain Graph (.agents/domain/domain-graph.json)
const domainGraph = buildDomainGraph({ writeToDisk: true });
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

const tapeFiles = walkFiles(path.join(ROOT, '.exploratory/tapes'), '.json');
const tapes = tapeFiles.map((f) => {
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const scenarioId = data.scenarioId || path.basename(f, '.json');
    const matchingSpec = specsWithContent.find((s) => s.rawContent.includes(scenarioId));

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

    return {
      scenarioId,
      charter: data.charter,
      persona: data.persona?.role,
      actors: Array.isArray(data.actors) ? data.actors.map((a) => a.actorId) : [],
      apiContractCount: Array.isArray(data.networkContracts) ? data.networkContracts.length : 0,
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

// 6. Compute Recommended Next Action (1-Test-at-a-Time Vertical Slice Loop)
let recommendedNextAction;
let nextSingleScenarioToAutomate = null;
if (missingAuthSessions.length > 0) {
  recommendedNextAction = `Invoke /00-env-bootstrap to capture missing persona session(s) required by Session Tapes: ${missingAuthSessions.join(', ')}`;
} else if (uncompiledTapes.length > 0) {
  nextSingleScenarioToAutomate = uncompiledTapes[0];
  recommendedNextAction = `Invoke '/02-solid-architect ${nextSingleScenarioToAutomate}' to compile and verify 1 Session Tape at a time (${uncompiledTapes.length} uncompiled: ${uncompiledTapes.join(', ')})`;
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
  recommendedNextAction = `All ${shards.length} domain shard(s) and ${tapes.length} tape(s) have spec coverage. Invoke /01-cli-explorer for the next single P1/P2 business scenario or backend API contract, /03-drift-healer to triage test failures, or /04-ci-pipeline to curate CI tags & sharded workflows.`;
}

const report = {
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
    staleShards,
  },
  domainShards: shards,
  uncoveredShards,
  recordedSessionTapes: tapes,
  uncompiledTapes,
  discoveredApiContracts,
  unimplementedApiClients,
  nextSingleScenarioToAutomate,
  openDefects,
  automatedSpecs: specsWithContent.map(({ rawContent, ...rest }) => rest),
  existingArchitecture: {
    contracts,
    pages,
    components,
    wizardSteps,
    dataBuilders,
    apiClients,
  },
  recommendedNextAction,
};

console.log('📊 Agentic-SOLID-QE Coverage & Federated Brain Snapshot:\n');
console.log(JSON.stringify(report, null, 2));

