#!/usr/bin/env node
/**
 * Token-Efficient Coverage, Traceability & Onboarding Analyzer for 01-cli-explorer & 02-solid-architect.
 * Scans domain-memory.md, shards, .exploratory/tapes/, defects/, src/, and tests/*.spec.ts
 * to compute uncompiled Session Tapes, uncovered shards, open defects, and recommended next actions.
 */
import fs from 'node:fs';
import path from 'node:path';

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

// 0. Parse Target Application Metadata from domain-memory.md
const domainMemoryPath = path.join(ROOT, '.agents/domain/domain-memory.md');
let appName = 'Unknown';
let baseUrl = 'http://localhost:3000';
if (fs.existsSync(domainMemoryPath)) {
  const memContent = fs.readFileSync(domainMemoryPath, 'utf8');
  const nameMatch = memContent.match(/-\s*\*\*Application Name:\*\*\s*(.+)/);
  const urlMatch = memContent.match(/-\s*\*\*Base URL:\*\*\s*`([^`]+)`/);
  if (nameMatch) appName = nameMatch[1].trim();
  if (urlMatch) baseUrl = urlMatch[1].trim();
}
const needsTargetUrlConfig =
  baseUrl.includes('localhost:3000') || baseUrl.includes('your-app-url');

// 1. Automated Specs & Test Cases
const specFiles = walkFiles(path.join(ROOT, 'tests'), '.spec.ts');
const specsWithContent = specFiles.map((f) => {
  const content = fs.readFileSync(f, 'utf8');
  const testTitles = [...content.matchAll(/\btest\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  return {
    file: path.relative(ROOT, f),
    testCount: testTitles.length,
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

// 3. Domain Shards & Coverage Mapping
const shardFiles = walkFiles(path.join(ROOT, '.agents/domain/shards'), '.md');
const shards = shardFiles.map((f) => {
  const content = fs.readFileSync(f, 'utf8');
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : path.basename(f);
  const shardKey = path.basename(f, '.md').toLowerCase();
  const routes = [...title.matchAll(/`(\/[^`]*)`/g)].map((m) => m[1]);
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
    file: path.relative(ROOT, f),
    title,
    routes,
    isCoveredBySpec,
  };
});

const uncoveredShards = shards.filter((s) => !s.isCoveredBySpec).map((s) => s.file);

// 4. Open Defects
const defectFiles = walkFiles(path.join(ROOT, 'defects'), '.md').filter(
  (f) => path.basename(f).toLowerCase() !== 'readme.md'
);
const openDefects = defectFiles.map((f) => path.relative(ROOT, f));

// 5. Existing SOLID Architecture
const contracts = walkFiles(path.join(ROOT, 'src/contracts'), '.ts').map((f) => path.basename(f));
const components = walkFiles(path.join(ROOT, 'src/components'), '.ts').map((f) => path.basename(f));
const pages = walkFiles(path.join(ROOT, 'src/pages'), '.ts').map((f) => path.basename(f));
const dataBuilders = walkFiles(path.join(ROOT, 'src/data'), '.ts').map((f) => path.basename(f));

// 6. Compute Recommended Next Action
let recommendedNextAction;
if (uncompiledTapes.length > 0) {
  recommendedNextAction = `Invoke /02-solid-architect to compile uncompiled Session Tape(s): ${uncompiledTapes.join(', ')}`;
} else if (shards.length === 0 && specsWithContent.length === 0) {
  recommendedNextAction = needsTargetUrlConfig
    ? `Update Base URL via 'npm run init:app -- --url <https://your-app> --name "<App Name>"' (or edit .agents/domain/domain-memory.md), then invoke /01-cli-explorer.`
    : `Invoke /01-cli-explorer to open ${baseUrl} in --headed mode and discover Top 3 P0 Golden Path scenarios.`;
} else if (uncoveredShards.length > 0) {
  recommendedNextAction = `Invoke /01-cli-explorer to record Session Tapes for uncovered domain shard(s): ${uncoveredShards.join(', ')}`;
} else {
  recommendedNextAction = `All ${shards.length} domain shard(s) and ${tapes.length} tape(s) have spec coverage. Invoke /01-cli-explorer with P1/P2 charters (multi-persona-auth, boundary-analysis, state-interruption) to expand coverage.`;
}

const report = {
  targetApp: {
    appName,
    baseUrl,
    needsTargetUrlConfig,
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

console.log('📊 Agentic-SOLID-QE Coverage & Gap Snapshot:\n');
console.log(JSON.stringify(report, null, 2));
