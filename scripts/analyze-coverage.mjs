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

// 2. Recorded Session Tapes & Traceability to Specs
const tapeFiles = walkFiles(path.join(ROOT, '.exploratory/tapes'), '.json');
const tapes = tapeFiles.map((f) => {
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    const scenarioId = data.scenarioId || path.basename(f, '.json');
    const matchingSpec = specsWithContent.find((s) => s.rawContent.includes(scenarioId));
    return {
      scenarioId,
      charter: data.charter,
      persona: data.persona?.role,
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
  ...walkFiles(path.join(ROOT, 'src/components'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/shared/components'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.component.ts'),
].map((f) => path.basename(f));
const pages = [
  ...walkFiles(path.join(ROOT, 'src/pages'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.page.ts'),
].map((f) => path.basename(f));
const dataBuilders = [
  ...walkFiles(path.join(ROOT, 'src/data'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.builder.ts'),
].map((f) => path.basename(f));

// 6. Compute Recommended Next Action
let recommendedNextAction;
if (uncompiledTapes.length > 0) {
  recommendedNextAction = `Invoke /02-solid-architect to compile uncompiled Session Tape(s): ${uncompiledTapes.join(', ')}`;
} else if (shards.length === 0 && specsWithContent.length === 0) {
  recommendedNextAction = needsTargetUrlConfig
    ? `Invoke /00-env-bootstrap (or run 'npm run init:app -- --url <https://your-app> --name "<App Name>"') to configure Base URL, capture auth state, and discover initial feature shards.`
    : `Invoke /00-env-bootstrap to capture persona auth state and map unfamiliar app routes, or /01-cli-explorer to explore ${baseUrl} in --headed mode.`;
} else if (uncoveredShards.length > 0) {
  recommendedNextAction = `Invoke /01-cli-explorer to explore and curate Session Tapes for uncovered domain shard(s): ${uncoveredShards.join(', ')}`;
} else if (staleShards.length > 0) {
  recommendedNextAction = `Invoke /03-drift-healer or /01-cli-explorer to re-verify stale domain shard(s): ${staleShards.join(', ')}`;
} else {
  recommendedNextAction = `All ${shards.length} domain shard(s) and ${tapes.length} tape(s) have spec coverage. Invoke /01-cli-explorer for P1/P2 charters, /03-drift-healer to triage test failures, or /04-ci-pipeline to curate CI tags & sharded workflows.`;
}

const report = {
  targetApp: {
    appName,
    baseUrl,
    needsTargetUrlConfig,
    savedAuthSessions,
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
  openDefects,
  automatedSpecs: specsWithContent.map(({ rawContent, ...rest }) => rest),
  existingArchitecture: { contracts, pages, components, dataBuilders },
  recommendedNextAction,
};

console.log('📊 Agentic-SOLID-QE Coverage & Federated Brain Snapshot:\n');
console.log(JSON.stringify(report, null, 2));
