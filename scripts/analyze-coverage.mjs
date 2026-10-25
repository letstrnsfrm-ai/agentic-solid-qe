#!/usr/bin/env node
/**
 * Token-Efficient Coverage & Risk Gap Analyzer for 01-cli-explorer.
 * Scans domain-memory.md, shards, .exploratory/tapes/, src/, and tests/*.spec.ts
 * so the agent can recommend high-risk uncovered Golden Path scenarios without reading every file.
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

// 1. Domain Shards
const shardFiles = walkFiles(path.join(ROOT, '.agents/domain/shards'), '.md');
const shards = shardFiles.map((f) => {
  const content = fs.readFileSync(f, 'utf8');
  const titleMatch = content.match(/^#\s+(.+)$/m);
  return {
    file: path.relative(ROOT, f),
    title: titleMatch ? titleMatch[1].trim() : path.basename(f),
  };
});

// 2. Recorded Session Tapes
const tapeFiles = walkFiles(path.join(ROOT, '.exploratory/tapes'), '.json');
const tapes = tapeFiles.map((f) => {
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    return {
      scenarioId: data.scenarioId,
      charter: data.charter,
      persona: data.persona?.role,
      title: data.title,
    };
  } catch {
    return { scenarioId: path.basename(f), charter: 'invalid-json' };
  }
});

// 3. Automated Specs & Test Cases
const specFiles = walkFiles(path.join(ROOT, 'tests'), '.spec.ts');
const specs = specFiles.map((f) => {
  const content = fs.readFileSync(f, 'utf8');
  const testTitles = [...content.matchAll(/\btest\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  return {
    file: path.relative(ROOT, f),
    testCount: testTitles.length,
    tests: testTitles,
  };
});

// 4. Existing SOLID Components & Pages
const components = walkFiles(path.join(ROOT, 'src/components'), '.ts').map((f) => path.basename(f));
const pages = walkFiles(path.join(ROOT, 'src/pages'), '.ts').map((f) => path.basename(f));

const report = {
  domainShards: shards,
  recordedSessionTapes: tapes,
  automatedSpecs: specs,
  existingArchitecture: { pages, components },
};

console.log('📊 Agentic-SOLID-QE Coverage & Gap Snapshot:\n');
console.log(JSON.stringify(report, null, 2));
