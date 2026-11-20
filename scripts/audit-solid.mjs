#!/usr/bin/env node
/**
 * Deterministic SOLID, 3-Tier Federated Brain & Skill Token Budget Gate (FR-3.2, FR-3.3, Section 6).
 * Supports both single-team flat layout and 100+ engineer Federated Domain layout
 * (.agents/domain/domains/<squad>/, src/domains/<squad>/, and composed @fixtures/*.fixture).
 * Zero external runtime dependencies.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MAX_COMPONENT_LINES = 150;
const MAX_PAGE_LINES = 250;
const MAX_FIXTURE_LINES = 200;
const MAX_BUILDER_LINES = 200;
const MAX_TESTS_PER_SPEC = 10;
const MAX_DOMAIN_LINES = 150;
const MAX_GLOBAL_SHARDS_BEFORE_SQUAD_HUB = 10;
const SHARD_STALE_DAYS = 90;
const MAX_SKILL_TOKENS = 500;
const MAX_SCAN_FILE_BYTES = 1024 * 1024; // 1 MB cap
const warnings = [];

const args = process.argv.slice(2);
let filterSquad = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--squad' && args[i + 1]) {
    filterSquad = args[++i].trim().toLowerCase();
  } else if (args[i].startsWith('--squad=')) {
    filterSquad = args[i].slice('--squad='.length).trim().toLowerCase();
  }
}
if (filterSquad && !/^[a-z0-9-]+$/.test(filterSquad)) {
  console.error(`❌ Invalid --squad value '${filterSquad}'. Must match ^[a-z0-9-]+$.`);
  process.exit(1);
}

let violations = [];

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

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

// 1. Audit SKILL.md Token Budget (< 500 tokens per SKILL.md)
const skillFiles = walkFiles(path.join(ROOT, '.agents/skills'), 'SKILL.md');
for (const file of skillFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  // Conservative token estimate: max(words * 1.35, chars / 4)
  const estimatedTokens = Math.ceil(Math.max(words * 1.35, content.length / 4));
  if (estimatedTokens > MAX_SKILL_TOKENS) {
    violations.push(
      `[NFR Token Budget] ${rel(file)} is ~${estimatedTokens} tokens (max ${MAX_SKILL_TOKENS}). Move detailed templates to references/.`
    );
  }

  const refsDir = path.join(path.dirname(file), 'references');
  if (fs.existsSync(refsDir)) {
    for (const refFile of walkFiles(refsDir, '.md')) {
      const refName = path.basename(refFile);
      if (refName === 'local-overrides.md') continue;
      if (!content.includes(refName)) {
        violations.push(
          `[Orphaned Skill Reference] ${rel(refFile)} is not indexed in ${rel(file)}. Link every reference file from SKILL.md so progressive disclosure never loses knowledge.`
        );
      }
    }
  }
}

// 1b. Audit 3-Tier Federated Domain Memory (Tier 0 Hub + Tier 1 Squad Hubs + Tier 2 Shards <= 150 lines)
const domainIndexFile = path.join(ROOT, '.agents/domain/domain-memory.md');
const globalShardFiles = walkFiles(path.join(ROOT, '.agents/domain/shards'), '.md');
const domainsRoot = path.join(ROOT, '.agents/domain/domains');
const squadHubFiles = [];
const squadShardFiles = [];

if (fs.existsSync(domainsRoot)) {
  for (const entry of fs.readdirSync(domainsRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (filterSquad && entry.name !== filterSquad) continue;
    const hubFile = path.join(domainsRoot, entry.name, 'index.md');
    if (fs.existsSync(hubFile)) squadHubFiles.push(hubFile);
    squadShardFiles.push(...walkFiles(path.join(domainsRoot, entry.name, 'shards'), '.md'));
  }
}

if (fs.existsSync(domainIndexFile)) {
  const indexContent = fs.readFileSync(domainIndexFile, 'utf8');
  const indexLines = indexContent.split('\n').length;
  if (indexLines > MAX_DOMAIN_LINES) {
    violations.push(
      `[Domain Memory Cap] ${rel(domainIndexFile)} has ${indexLines} lines (max ${MAX_DOMAIN_LINES}). Move squad details into .agents/domain/domains/<squad>/index.md.`
    );
  }

  for (const hub of squadHubFiles) {
    const hubRel = rel(hub);
    const hubContent = fs.readFileSync(hub, 'utf8');
    const hubLines = hubContent.split('\n').length;
    if (hubLines > MAX_DOMAIN_LINES) {
      violations.push(
        `[Domain Sub-Hub Cap] ${hubRel} has ${hubLines} lines (max ${MAX_DOMAIN_LINES}). Split into feature shards.`
      );
    }
    const squadName = path.basename(path.dirname(hub));
    if (!indexContent.includes(hubRel) && !indexContent.includes(`domains/${squadName}`)) {
      violations.push(
        `[Unindexed Domain Sub-Hub] ${hubRel} is not referenced in .agents/domain/domain-memory.md.`
      );
    }
  }

  for (const shard of globalShardFiles) {
    const shardRel = rel(shard);
    const shardLines = fs.readFileSync(shard, 'utf8').split('\n').length;
    if (shardLines > MAX_DOMAIN_LINES) {
      violations.push(
        `[Domain Shard Cap] ${shardRel} has ${shardLines} lines (max ${MAX_DOMAIN_LINES}). Compact duplicates or split into sub-feature shards.`
      );
    }
    if (!indexContent.includes(path.basename(shard))) {
      violations.push(
        `[Unindexed Domain Shard] ${shardRel} is not referenced in .agents/domain/domain-memory.md.`
      );
    }
  }

  for (const shard of squadShardFiles) {
    const shardRel = rel(shard);
    const shardLines = fs.readFileSync(shard, 'utf8').split('\n').length;
    if (shardLines > MAX_DOMAIN_LINES) {
      violations.push(
        `[Domain Shard Cap] ${shardRel} has ${shardLines} lines (max ${MAX_DOMAIN_LINES}). Compact duplicates or split into sub-feature shards.`
      );
    }
    const squadDir = path.dirname(path.dirname(shard));
    const parentHub = path.join(squadDir, 'index.md');
    const parentHubContent = fs.existsSync(parentHub) ? fs.readFileSync(parentHub, 'utf8') : '';
    if (
      !parentHubContent.includes(path.basename(shard)) &&
      !indexContent.includes(path.basename(shard))
    ) {
      violations.push(
        `[Unindexed Squad Shard] ${shardRel} is not referenced in ${rel(parentHub)} or .agents/domain/domain-memory.md.`
      );
    }
  }

  if (globalShardFiles.length > MAX_GLOBAL_SHARDS_BEFORE_SQUAD_HUB && squadHubFiles.length === 0) {
    violations.push(
      `[Federated Scaling Cap] Found ${globalShardFiles.length} global shards in .agents/domain/shards/ (max ${MAX_GLOBAL_SHARDS_BEFORE_SQUAD_HUB} without Tier-1 squad hubs). Move shards into .agents/domain/domains/<squad>/shards/ with an index.md hub.`
    );
  }

  // Domain Brain Hygiene: duplicate routes & stale Last Verified (> 90 days)
  const routeToShards = new Map();
  const nowMs = Date.now();
  for (const shard of [...globalShardFiles, ...squadShardFiles]) {
    const shardRel = rel(shard);
    const shardText = fs.readFileSync(shard, 'utf8');
    const verifiedMatch = shardText.match(/\*\*Last Verified:\*\*\s*`?(\d{4}-\d{2}-\d{2})`?/i);
    if (verifiedMatch) {
      const verifiedMs = Date.parse(verifiedMatch[1]);
      if (!Number.isNaN(verifiedMs)) {
        const ageDays = Math.floor((nowMs - verifiedMs) / (1000 * 60 * 60 * 24));
        if (ageDays > SHARD_STALE_DAYS) {
          warnings.push(
            `[Stale Domain Shard] ${shardRel} was last verified ${ageDays} days ago (${verifiedMatch[1]} > ${SHARD_STALE_DAYS}d). Re-verify via /01-cli-explorer or /03-drift-healer.`
          );
        }
      }
    }
    const routeLineMatch = shardText.match(/\*\*(?:Route|Routes|URL Paths?):\*\*([^\n]+)/i);
    if (routeLineMatch) {
      for (const rm of routeLineMatch[1].matchAll(/`(\/[a-zA-Z0-9/_:-]*)`/g)) {
        const route = rm[1];
        if (route === '/') continue;
        const list = routeToShards.get(route) || [];
        list.push(shardRel);
        routeToShards.set(route, list);
      }
    }
  }
  for (const [route, shardList] of routeToShards.entries()) {
    if (shardList.length > 1) {
      warnings.push(
        `[Duplicate Domain Route] Route '${route}' is declared in multiple shards: ${shardList.join(', ')}.`
      );
    }
  }
}

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

// 2. Audit Components & Wizard Steps across src/components, src/steps, src/shared/components, and src/domains/*/{components,steps}
const componentFiles = [
  ...new Set(
    filterSquad
      ? [
          ...walkFiles(path.join(ROOT, 'src/shared/components'), '.ts'),
          ...walkFiles(path.join(ROOT, 'src/domains', filterSquad), '.component.ts'),
          ...walkFiles(path.join(ROOT, 'src/domains', filterSquad), '.step.ts'),
        ]
      : [
          ...walkFiles(path.join(ROOT, 'src/components'), '.ts'),
          ...walkFiles(path.join(ROOT, 'src/steps'), '.step.ts'),
          ...walkFiles(path.join(ROOT, 'src/shared/components'), '.ts'),
          ...walkFiles(path.join(ROOT, 'src/domains'), '.component.ts'),
          ...walkFiles(path.join(ROOT, 'src/domains'), '.step.ts'),
        ]
  ),
];
for (const file of componentFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const codeOnly = stripComments(content);
  const lines = content.split('\n').length;

  if (lines > MAX_COMPONENT_LINES) {
    violations.push(
      `[SRP Line Cap] ${rel(file)} has ${lines} lines (max ${MAX_COMPONENT_LINES}). Split into smaller atomic components or wizard steps.`
    );
  }

  if (/\bexpect\s*\(/.test(codeOnly)) {
    violations.push(
      `[SRP Assertion Ban] ${rel(file)} contains an expect() call. Assertions belong strictly in tests/*.spec.ts.`
    );
  }

  if (!/\bimplements\s+[A-Za-z0-9_]+/.test(codeOnly)) {
    violations.push(
      `[LSP Contract] ${rel(file)} must implement a shared contract interface from src/contracts/ (e.g., IdentifiableComponent or WizardStepContract).`
    );
  }
}

// 3. Audit Pages across src/pages and src/domains/*/pages (SRP Zero expect())
const pageFiles = filterSquad
  ? walkFiles(path.join(ROOT, 'src/domains', filterSquad), '.page.ts')
  : [
      ...walkFiles(path.join(ROOT, 'src/pages'), '.ts'),
      ...walkFiles(path.join(ROOT, 'src/domains'), '.page.ts'),
    ];
for (const file of pageFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const codeOnly = stripComments(content);
  const pageLines = content.split('\n').length;
  if (pageLines > MAX_PAGE_LINES) {
    violations.push(
      `[SRP Page Line Cap] ${rel(file)} has ${pageLines} lines (max ${MAX_PAGE_LINES}). Extract sub-sections into src/components/.`
    );
  }
  if (/\bexpect\s*\(/.test(codeOnly)) {
    violations.push(
      `[SRP Assertion Ban] ${rel(file)} contains an expect() call. Expose readonly Locators and assert in tests/*.spec.ts.`
    );
  }
}

// 3a-fix. Audit Fixtures (src/fixtures/app.fixture.ts & src/domains/*/fixtures/*.fixture.ts <= 200 lines)
const fixtureFiles = [
  ...walkFiles(path.join(ROOT, 'src/fixtures'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.fixture.ts'),
];
for (const file of fixtureFiles) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').length;
  if (lines > MAX_FIXTURE_LINES) {
    violations.push(
      `[Fixture Scaling Cap] ${rel(file)} has ${lines} lines (max ${MAX_FIXTURE_LINES}). Split into squad-scoped src/domains/<squad>/fixtures/*.fixture.ts and compose via mergeTests.`
    );
  }
}

// 3a. Audit Backend API Clients across src/api and src/domains/*/api (SRP Zero expect() & LSP ApiClientContract)
const apiClientFiles = filterSquad
  ? walkFiles(path.join(ROOT, 'src/domains', filterSquad), '.client.ts')
  : [
      ...walkFiles(path.join(ROOT, 'src/api'), '.client.ts'),
      ...walkFiles(path.join(ROOT, 'src/domains'), '.client.ts'),
    ];
for (const file of apiClientFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const codeOnly = stripComments(content);
  if (/\bexpect\s*\(/.test(codeOnly)) {
    violations.push(
      `[SRP Assertion Ban] ${rel(file)} contains an expect() call. Return typed ApiResponseEnvelope<T> and assert in tests/*.spec.ts.`
    );
  }
  if (!/\bimplements\s+[A-Za-z0-9_]+/.test(codeOnly)) {
    violations.push(
      `[LSP Contract] ${rel(file)} must implement ApiClientContract from src/contracts/api-client.contract.ts.`
    );
  }
}

// 3a-bis. Audit Composable State Seeders across src/seeders and src/domains/*/seeders (<= 150 lines, zero expect(), StateSeederContract)
const seederFiles = filterSquad
  ? walkFiles(path.join(ROOT, 'src/domains', filterSquad), '.seeder.ts')
  : [
      ...walkFiles(path.join(ROOT, 'src/seeders'), '.seeder.ts'),
      ...walkFiles(path.join(ROOT, 'src/domains'), '.seeder.ts'),
    ];
for (const file of seederFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').length;
  if (lines > MAX_COMPONENT_LINES) {
    violations.push(
      `[SRP Line Cap] ${rel(file)} has ${lines} lines (max ${MAX_COMPONENT_LINES}). Compose smaller domain seeders.`
    );
  }
  const codeOnly = stripComments(content);
  if (/\bexpect\s*\(/.test(codeOnly)) {
    violations.push(
      `[SRP Assertion Ban] ${rel(file)} contains an expect() call. Seeders create isolated state; assertions belong in tests/*.spec.ts.`
    );
  }
  if (!/\bimplements\s+StateSeederContract\b/.test(codeOnly)) {
    violations.push(
      `[LSP Contract] ${rel(file)} must implement StateSeederContract from src/contracts/state-seeder.contract.ts.`
    );
  }
}

// 3a-ter. Audit Reusable SOLID Flows across src/flows and src/domains/*/flows (<= 150 lines, zero expect(), FlowContract)
const flowFiles = filterSquad
  ? walkFiles(path.join(ROOT, 'src/domains', filterSquad), '.flow.ts')
  : [
      ...walkFiles(path.join(ROOT, 'src/flows'), '.flow.ts'),
      ...walkFiles(path.join(ROOT, 'src/domains'), '.flow.ts'),
    ];
for (const file of flowFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n').length;
  if (lines > MAX_COMPONENT_LINES) {
    violations.push(
      `[SRP Line Cap] ${rel(file)} has ${lines} lines (max ${MAX_COMPONENT_LINES}). Compose smaller domain flows.`
    );
  }
  const codeOnly = stripComments(content);
  if (/\bexpect\s*\(/.test(codeOnly)) {
    violations.push(
      `[SRP Assertion Ban] ${rel(file)} contains an expect() call. Flows execute reusable UI journeys; assertions belong in tests/*.spec.ts.`
    );
  }
  if (!/\bimplements\s+FlowContract\b/.test(codeOnly)) {
    violations.push(
      `[LSP Contract] ${rel(file)} must implement FlowContract from src/contracts/flow.contract.ts.`
    );
  }
}

// 3b. Verify Published Capabilities in Domain Shards match exported classes/interfaces in src/
const allSrcTsFiles = walkFiles(path.join(ROOT, 'src'), '.ts');
const exportedSymbols = new Set();
for (const srcFile of allSrcTsFiles) {
  const srcCode = stripComments(fs.readFileSync(srcFile, 'utf8'));
  for (const m of srcCode.matchAll(/\bexport\s+(?:class|interface|type|const)\s+([A-Za-z0-9_]+)/g)) {
    exportedSymbols.add(m[1]);
  }
}

if (exportedSymbols.size > 0) {
  for (const shard of [...globalShardFiles, ...squadShardFiles]) {
    const shardContent = fs.readFileSync(shard, 'utf8');
    const capMatch = shardContent.match(/\*\*Published Capabilities:\*\*\s*(.+)/i);
    if (!capMatch) continue;
    const declaredCaps = capMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^`|`$/g, ''))
      .filter((s) => /^[A-Z][A-Za-z0-9_]*$/.test(s));
    for (const cap of declaredCaps) {
      if (!exportedSymbols.has(cap)) {
        violations.push(
          `[Shard Capability Drift] ${rel(shard)} declares Published Capability '${cap}' which is not exported anywhere in src/.`
        );
      }
    }
  }
}

// 4. Extract domain constants from global src/data/*.builder.ts and squad-scoped src/domains/<squad>/data/*.builder.ts
function extractBuilderLiterals(files) {
  const map = new Map();
  for (const bFile of files) {
    const bCode = stripComments(fs.readFileSync(bFile, 'utf8'))
      .replace(/^\s*import\s+.*$/gm, '')
      .replace(/\brole\s*:\s*[^,\n}]+/g, '');
    const stringMatches = bCode.matchAll(/(['"])((?:\\.|(?!\1)[^\\])+)\1/g);
    for (const match of stringMatches) {
      const val = match[2].trim();
      if (val.length >= 5) {
        map.set(val, rel(bFile));
      }
    }
  }
  return map;
}

const globalBuilderFiles = walkFiles(path.join(ROOT, 'src/data'), '.builder.ts');
const globalBuilderLiterals = extractBuilderLiterals(globalBuilderFiles);

const allBuilderFiles = [...globalBuilderFiles];
const squadBuilderLiterals = new Map(); // squad -> Map(literal -> sourceFile)
const srcDomainsDir = path.join(ROOT, 'src/domains');
if (fs.existsSync(srcDomainsDir)) {
  for (const entry of fs.readdirSync(srcDomainsDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const sFiles = walkFiles(path.join(srcDomainsDir, entry.name, 'data'), '.builder.ts');
    allBuilderFiles.push(...sFiles);
    squadBuilderLiterals.set(entry.name, extractBuilderLiterals(sFiles));
  }
}

for (const bFile of allBuilderFiles) {
  const bLines = fs.readFileSync(bFile, 'utf8').split('\n').length;
  if (bLines > MAX_BUILDER_LINES) {
    violations.push(
      `[Builder Scaling Cap] ${rel(bFile)} has ${bLines} lines (max ${MAX_BUILDER_LINES}). Split into domain-specific *.builder.ts modules.`
    );
  }
}

// 5. Audit Specs (OCP/ISP Fixture injection + Scoped DIP Data Builder & URL rules + 1000+ Test CI Shardability)
const specFiles = filterSquad
  ? walkFiles(path.join(ROOT, 'tests', filterSquad), '.spec.ts')
  : walkFiles(path.join(ROOT, 'tests'), '.spec.ts');

for (const file of specFiles) {
  const specRel = rel(file);
  const content = fs.readFileSync(file, 'utf8');
  const codeWithoutComments = stripComments(content);

  const testMatches = codeWithoutComments.match(/\btest\s*\(/g) || [];
  if (testMatches.length > MAX_TESTS_PER_SPEC) {
    violations.push(
      `[CI Shardability Cap] ${specRel} contains ${testMatches.length} test() blocks (max ${MAX_TESTS_PER_SPEC}). Split into smaller feature-scoped .spec.ts files for balanced CI sharding.`
    );
  }

  if (/\btest\.only\s*\(/.test(codeWithoutComments)) {
    violations.push(
      `[CI Focus Ban] ${specRel} contains test.only(), which silently skips the rest of the suite in CI.`
    );
  }

  if (
    /\.waitForTimeout\s*\(/.test(codeWithoutComments) ||
    /\.waitForLoadState\s*\(\s*['"]networkidle['"]\s*\)/.test(codeWithoutComments)
  ) {
    violations.push(
      `[Flaky Wait Ban] ${specRel} uses waitForTimeout() or waitForLoadState('networkidle'). Use deterministic web-first assertions or waitForResponse().`
    );
  }

  if (
    testMatches.length > 0 &&
    !/@(?:p0|p1|p2|smoke|regression|api-contract)\b/i.test(codeWithoutComments)
  ) {
    violations.push(
      `[CI Tagging Rule] ${specRel} is missing an execution tag (@p0, @smoke, @regression, or @api-contract) for sharded CI filtering.`
    );
  }

  if (/from\s+['"]@playwright\/test['"]/.test(codeWithoutComments)) {
    violations.push(
      `[OCP/ISP Fixture Rule] ${specRel} imports directly from '@playwright/test'. Import { test, expect } from '@fixtures/app.fixture' (or a mergeTests domain fixture) instead.`
    );
  }

  if (
    !/from\s+['"]@data\//.test(codeWithoutComments) &&
    !/from\s+['"]@domains\/[^'"]+\/data\//.test(codeWithoutComments) &&
    !/from\s+['"].*\/data\//.test(codeWithoutComments)
  ) {
    violations.push(
      `[DIP Data Builder Rule] ${specRel} does not import any Data Builder from src/data/ or src/domains/<squad>/data/.`
    );
  }

  // Strip import lines and test/describe title strings before checking spec body literals
  const specBodyOnly = codeWithoutComments
    .replace(/^\s*import\s+.*$/gm, '')
    .replace(/\btest(?:\.describe)?\s*\(\s*(['"`])(?:\\.|(?!\1)[^\\])*\1/g, 'test(');

  if (/['"`]https?:\/\/[^'"`]+['"`]/.test(specBodyOnly)) {
    violations.push(
      `[DIP Hardcoded URL Ban] ${specRel} contains a hardcoded http(s):// URL. Use baseURL via Page objects or Data Builders.`
    );
  }

  const specLiterals = new Set(
    [...specBodyOnly.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])+)\1/g)].map((m) => m[2].trim())
  );

  // Check global builder literals + matching squad builder literals (if spec is inside tests/<squad>/)
  const applicableLiterals = new Map(globalBuilderLiterals);
  const specParts = specRel.split('/');
  if (specParts.length > 2 && squadBuilderLiterals.has(specParts[1])) {
    for (const [k, v] of squadBuilderLiterals.get(specParts[1]).entries()) {
      applicableLiterals.set(k, v);
    }
  }

  for (const [builderVal, sourceBuilder] of applicableLiterals.entries()) {
    if (specLiterals.has(builderVal)) {
      violations.push(
        `[DIP Magic String Ban] ${specRel} hardcodes '${builderVal}' which is already defined in ${sourceBuilder}. Consume the Data Builder method instead.`
      );
    }
  }

  // Require business-domain test.step() blocks for HTML report readability
  if (/\btest\s*\(/.test(codeWithoutComments) && !/\btest\.step\s*\(/.test(codeWithoutComments)) {
    violations.push(
      `[BDD/Business Step Rule] ${specRel} does not use test.step(). Wrap high-level business behaviours in await test.step('...', async () => { ... }) so HTML reports show business behaviour instead of implementation steps.`
    );
  }

  const IMPLEMENTATION_JARGON_REGEX =
    /\b(?:click|fill|press|hover|locator|selector|xpath|css|dom|getbyrole|getbylabel|getbytestid|getbyplaceholder|getbytext|input\s+field|button|checkbox|dropdown)\b/i;
  for (const stepMatch of codeWithoutComments.matchAll(
    /\btest\.step\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])+)\1/g
  )) {
    const stepTitle = stepMatch[2].trim();
    const jargonMatch = stepTitle.match(IMPLEMENTATION_JARGON_REGEX);
    if (jargonMatch) {
      violations.push(
        `[Business Language Rule] ${specRel} uses UI implementation jargon ('${jargonMatch[0]}') in test.step(${JSON.stringify(stepTitle)}). Describe high-level business behaviour instead of UI mechanics.`
      );
    }
  }
}

// 5b. Dead Code Hygiene: warn on unused Components or Data Builders
if (!filterSquad && (specFiles.length > 0 || pageFiles.length > 0)) {
  const combinedUsageCorpus = [...allSrcTsFiles, ...specFiles]
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  for (const candidateFile of [...componentFiles, ...allBuilderFiles]) {
    const code = stripComments(fs.readFileSync(candidateFile, 'utf8'));
    const classMatch = code.match(/\bexport\s+class\s+([A-Za-z0-9_]+)/);
    if (!classMatch) continue;
    const sym = classMatch[1];
    const occurrences = (combinedUsageCorpus.match(new RegExp(`\\b${sym}\\b`, 'g')) || []).length;
    if (occurrences <= 1) {
      warnings.push(
        `[Unused Module Warning] ${rel(candidateFile)} exports '${sym}' which is not referenced outside its own file.`
      );
    }
  }
}

// 6. Audit src/, tests/, .agents/skills/, .agents/domain/, .exploratory/tapes/, .claude/, .github/, and defects/ for leaked secrets, Trojan-Source Unicode, and prompt injection
const SECRET_PATTERNS = [
  { name: 'GitHub Token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub Fine-Grained PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'API Secret Key (sk-*)', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'AWS Access Key ID', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'Google Cloud API Key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack Token', regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'npm Access Token', regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: 'SendGrid API Key', regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { name: 'Private Key Block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: 'Raw JWT Token',
    regex: /\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    name: 'Database Connection URI with Credentials',
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|mssql|amqp|amqps):\/\/[^/\s:@'"`]+:[^/\s@'"`]+@[^\s'"`]+/i,
  },
  {
    name: 'HTTP(S) URL with Embedded Basic Auth Credentials',
    regex: /\bhttps?:\/\/[^/\s:@'"`]+:[^/\s@'"`]+@[^\s'"`]+/i,
  },
  { name: 'Insecure Default Password Placeholder', regex: /['"`]ChangeMe123!['"`]/ },
];

const BIDI_UNICODE_REGEX = /[\u202A-\u202E\u2066-\u2069]/;
const PROMPT_INJECTION_PATTERNS = [
  {
    name: 'Remote Shell Pipe Execution (curl/wget | sh)',
    regex: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b/i,
  },
  {
    name: 'Prompt Override Injection Directive',
    regex: /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions\b/i,
  },
];

const UNSAFE_TS_CODE_PATTERNS = [
  {
    name: 'Dynamic Code Execution (eval / new Function)',
    regex: /\b(?:eval\s*\(|new\s+Function\s*\()/,
  },
  {
    name: 'Shell Process Spawning in Test/Page Layer (child_process)',
    regex: /(?:from\s+['"](?:node:)?child_process['"]|require\s*\(\s*['"](?:node:)?child_process['"]\s*\))/,
  },
  {
    name: 'Hardcoded TLS Verification Bypass (ignoreHTTPSErrors: true / NODE_TLS_REJECT_UNAUTHORIZED=0)',
    regex: /(?:\bignoreHTTPSErrors\s*:\s*true\b|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"`]0['"`])/,
  },
  {
    name: 'Hardcoded Content-Security-Policy Bypass (bypassCSP: true)',
    regex: /\bbypassCSP\s*:\s*true\b/,
  },
];

const allCodeAndArtifactFiles = [
  ...walkFiles(path.join(ROOT, 'src'), '.ts'),
  ...walkFiles(path.join(ROOT, 'tests'), '.ts'),
  ...walkFiles(path.join(ROOT, '.agents/skills')),
  ...walkFiles(path.join(ROOT, '.agents/domain'), '.md'),
  ...walkFiles(path.join(ROOT, '.agents/legacy-backups')),
  ...walkFiles(path.join(ROOT, '.playwright')),
  ...walkFiles(path.join(ROOT, '.exploratory/tapes'), '.json'),
  ...walkFiles(path.join(ROOT, '.claude/commands'), '.md'),
  ...walkFiles(path.join(ROOT, '.github/prompts'), '.md'),
  ...walkFiles(path.join(ROOT, '.github/workflows'), '.yml'),
  ...walkFiles(path.join(ROOT, '.azure-pipelines'), '.yml'),
  ...walkFiles(path.join(ROOT, 'defects'), '.md'),
];

const TS_SENSITIVE_ASSIGN_REGEX =
  /\b(password|passcode|pin|userPin|cardPin|securityPin|otp|cvv|cvc|ssn|secret|clientSecret|client_secret|privateKey|private_key|accessKey|access_key|apiKey|api_key|authToken|auth_token|accessToken|access_token|refreshToken|refresh_token|bearerToken)\s*[:=]\s*(['"`])([^'"`]+)\2/g;

const TS_SENSITIVE_ENV_FALLBACK_REGEX =
  /\bprocess\.env\.([A-Za-z0-9_]+)\s*(?:\?\?|\|\|)\s*(['"`])([^'"`]+)\2/g;

const ARTIFACT_CREDENTIAL_ASSIGN_REGEX =
  /\b(password|passcode|pin|otp|cvv|cvc|ssn|secret|client[_-]?secret|private[_-]?key|access[_-]?key|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token)\s*[:=]\s*(['"`])([^'"`$\n]{4,})\2/gi;

for (const targetFile of allCodeAndArtifactFiles) {
  const rawText = fs.readFileSync(targetFile, 'utf8');
  const relTarget = rel(targetFile);

  if (BIDI_UNICODE_REGEX.test(rawText)) {
    violations.push(
      `[Trojan-Source Unicode Gate] ${relTarget} contains bidirectional Unicode control characters (U+202A..U+202E / U+2066..U+2069). Strip hidden control characters.`
    );
  }

  const isPromptOrMemoryArtifact =
    relTarget.startsWith('.agents/skills/') ||
    relTarget.startsWith('.agents/domain/') ||
    relTarget.startsWith('.agents/legacy-backups/') ||
    relTarget.startsWith('.claude/commands/') ||
    relTarget.startsWith('.github/prompts/');
  if (isPromptOrMemoryArtifact) {
    for (const inj of PROMPT_INJECTION_PATTERNS) {
      if (inj.regex.test(rawText)) {
        violations.push(
          `[Agent Prompt Security Gate] ${relTarget} contains forbidden pattern '${inj.name}'. Remove untrusted shell pipes or prompt-override directives.`
        );
      }
    }
  }

  const inspectText = targetFile.endsWith('.ts') ? stripComments(rawText) : rawText;
  if (relTarget.startsWith('src/') || relTarget.startsWith('tests/')) {
    for (const unsafeRule of UNSAFE_TS_CODE_PATTERNS) {
      if (unsafeRule.regex.test(inspectText)) {
        violations.push(
          `[Enterprise Code Security Gate] ${relTarget} contains forbidden pattern '${unsafeRule.name}'.`
        );
      }
    }

    for (const match of inspectText.matchAll(TS_SENSITIVE_ASSIGN_REGEX)) {
      const propName = match[1];
      const literalVal = match[3].trim();
      if (
        literalVal &&
        literalVal !== 'secret_sauce' &&
        !literalVal.startsWith('${') &&
        !literalVal.startsWith('<')
      ) {
        violations.push(
          `[Secret Hygiene Gate] ${relTarget} hardcodes a plaintext credential in '${propName}'. Inject secrets via requireEnv() in src/data/*.builder.ts.`
        );
      }
    }

    for (const match of inspectText.matchAll(TS_SENSITIVE_ENV_FALLBACK_REGEX)) {
      const envName = match[1];
      const fallbackVal = match[3].trim();
      const isSensitiveEnv =
        /(?:password|passcode|\bpin\b|_pin|pin_|\botp\b|_otp|cvv|cvc|\bssn\b|_ssn|secret|private[_-]?key|access[_-]?key|api[_-]?key|token)/i.test(
          envName
        );
      if (isSensitiveEnv && fallbackVal && fallbackVal !== 'secret_sauce') {
        violations.push(
          `[Secret Hygiene Gate] ${relTarget} defines a non-empty fallback secret literal for process.env.${envName}. Use requireEnv('${envName}') instead of a hardcoded fallback credential.`
        );
      }
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(inspectText)) {
      violations.push(
        `[Secret Hygiene Gate] ${relTarget} contains a ${pattern.name}. Inject sensitive values via environment variables in src/data/*.builder.ts.`
      );
    }
  }

  const isScannedArtifactOrScript =
    (relTarget.startsWith('.agents/skills/') && relTarget.includes('/scripts/')) ||
    relTarget.startsWith('.agents/domain/') ||
    relTarget.startsWith('.agents/legacy-backups/') ||
    relTarget.startsWith('defects/') ||
    relTarget.startsWith('.playwright/');
  if (isScannedArtifactOrScript) {
    for (const match of rawText.matchAll(ARTIFACT_CREDENTIAL_ASSIGN_REGEX)) {
      const keyName = match[1];
      const assignedVal = match[3].trim();
      if (
        assignedVal &&
        assignedVal !== 'secret_sauce' &&
        !assignedVal.startsWith('<') &&
        !assignedVal.includes('process.env') &&
        !assignedVal.includes('UserBuilder.')
      ) {
        violations.push(
          `[Secret Hygiene Gate] ${relTarget} contains a hardcoded '${keyName}' credential assignment. Parameterize secrets via process.env and record only key names in documentation.`
        );
      }
    }
  }
}

// 7. Audit Git Index & Staged Files for accidentally tracked .env, .auth/*.json, .agent-browser/, .playwright-cli/, .playwright/, or .agents/legacy-backups/
const FORBIDDEN_GIT_TRACKED_FILE_REGEX =
  /^(?:\.env|\..*\.env|\.env\.(?!example$)[^/]+|\.auth\/.*\.json|\.agent-browser\/.*|\.playwright-cli\/.*|\.playwright\/.*|\.agents\/legacy-backups\/.*)$/;

if (fs.existsSync(path.join(ROOT, '.git'))) {
  const trackedSet = new Set();
  for (const gitArgs of [
    ['ls-files', '--cached'],
    ['diff', '--cached', '--name-only'],
  ]) {
    try {
      const res = spawnSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' });
      if (res.status === 0 && res.stdout) {
        for (const line of res.stdout.split(/\r?\n/)) {
          const trimmed = line.trim().replace(/\\/g, '/');
          if (trimmed) trackedSet.add(trimmed);
        }
      }
    } catch {
      /* ignore if git binary is unavailable */
    }
  }
  for (const trackedPath of trackedSet) {
    if (FORBIDDEN_GIT_TRACKED_FILE_REGEX.test(trackedPath)) {
      violations.push(
        `[Git Secret File Gate] '${trackedPath}' is tracked or staged in Git. Run 'git rm --cached ${trackedPath}' so sensitive environment/session files are never committed.`
      );
    }
  }
}

// 8. Audit package.json for exact dependency version pinning (no floating ^, ~, *, >=, or latest ranges)
const pkgJsonPath = path.join(ROOT, 'package.json');
if (fs.existsSync(pkgJsonPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const EXACT_SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
    for (const section of ['dependencies', 'devDependencies', 'overrides']) {
      const deps = pkg[section];
      if (!deps || typeof deps !== 'object') continue;
      for (const [depName, depVer] of Object.entries(deps)) {
        if (typeof depVer !== 'string') continue;
        if (!EXACT_SEMVER_REGEX.test(depVer.trim())) {
          violations.push(
            `[Enterprise Dependency Pinning Gate] package.json ${section}["${depName}"] uses non-pinned version "${depVer}". Pin exact semver versions (e.g., "1.2.3") and set save-exact=true in .npmrc.`
          );
        }
      }
    }
  } catch {
    /* ignore malformed package.json */
  }
}

if (warnings.length > 0) {
  console.warn('\n⚠️  SOLID & Scale Hygiene Warnings:\n');
  for (const w of warnings) {
    console.warn(`  - ${w}`);
  }
}

if (violations.length > 0) {
  console.error('\n❌ SOLID Architecture Audit Failed:\n');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

const totalShards = globalShardFiles.length + squadShardFiles.length;
console.log(
  `✅ SOLID & Federated Brain Audit Passed (${skillFiles.length} skills < ${MAX_SKILL_TOKENS} tokens, 1 root hub + ${squadHubFiles.length} domain hub(s) + ${totalShards} shard(s) <= ${MAX_DOMAIN_LINES} lines, ${componentFiles.length} components <= ${MAX_COMPONENT_LINES} lines, ${pageFiles.length} pages, ${specFiles.length} specs verified against ${globalBuilderLiterals.size} global Data Builder literals).`
);
