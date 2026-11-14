#!/usr/bin/env node
/**
 * Deterministic SOLID, 3-Tier Federated Brain & Skill Token Budget Gate (FR-3.2, FR-3.3, Section 6).
 * Supports both single-team flat layout and 100+ engineer Federated Domain layout
 * (.agents/domain/domains/<squad>/, src/domains/<squad>/, and composed @fixtures/*.fixture).
 * Zero external runtime dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MAX_COMPONENT_LINES = 150;
const MAX_DOMAIN_LINES = 150;
const MAX_SKILL_TOKENS = 500;

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
      files.push(fullPath);
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
}

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

// 2. Audit Components across src/components, src/shared/components, and src/domains/*/components
const componentFiles = [
  ...walkFiles(path.join(ROOT, 'src/components'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/shared/components'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.component.ts'),
];
for (const file of componentFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const codeOnly = stripComments(content);
  const lines = content.split('\n').length;

  if (lines > MAX_COMPONENT_LINES) {
    violations.push(
      `[SRP Line Cap] ${rel(file)} has ${lines} lines (max ${MAX_COMPONENT_LINES}). Split into smaller atomic components.`
    );
  }

  if (/\bexpect\s*\(/.test(codeOnly)) {
    violations.push(
      `[SRP Assertion Ban] ${rel(file)} contains an expect() call. Assertions belong strictly in tests/*.spec.ts.`
    );
  }

  if (!/\bimplements\s+[A-Za-z0-9_]+/.test(codeOnly)) {
    violations.push(
      `[LSP Contract] ${rel(file)} must implement a shared contract interface from src/contracts/.`
    );
  }
}

// 3. Audit Pages across src/pages and src/domains/*/pages (SRP Zero expect())
const pageFiles = [
  ...walkFiles(path.join(ROOT, 'src/pages'), '.ts'),
  ...walkFiles(path.join(ROOT, 'src/domains'), '.page.ts'),
];
for (const file of pageFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const codeOnly = stripComments(content);
  if (/\bexpect\s*\(/.test(codeOnly)) {
    violations.push(
      `[SRP Assertion Ban] ${rel(file)} contains an expect() call. Expose readonly Locators and assert in tests/*.spec.ts.`
    );
  }
}

// 3a. Audit Backend API Clients across src/api and src/domains/*/api (SRP Zero expect() & LSP ApiClientContract)
const apiClientFiles = [
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
    const stringMatches = bCode.matchAll(/(['"])((?:\\.|(?!\1).)+)\1/g);
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

const squadBuilderLiterals = new Map(); // squad -> Map(literal -> sourceFile)
const srcDomainsDir = path.join(ROOT, 'src/domains');
if (fs.existsSync(srcDomainsDir)) {
  for (const entry of fs.readdirSync(srcDomainsDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const sFiles = walkFiles(path.join(srcDomainsDir, entry.name, 'data'), '.builder.ts');
    squadBuilderLiterals.set(entry.name, extractBuilderLiterals(sFiles));
  }
}

// 5. Audit Specs (OCP/ISP Fixture injection + Scoped DIP Data Builder & URL rules)
const specFiles = walkFiles(path.join(ROOT, 'tests'), '.spec.ts');

for (const file of specFiles) {
  const specRel = rel(file);
  const content = fs.readFileSync(file, 'utf8');
  const codeWithoutComments = stripComments(content);

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
    .replace(/\btest(?:\.describe)?\s*\(\s*(['"`])(?:\\.|(?!\1).)*\1/g, 'test(');

  if (/['"`]https?:\/\/[^'"`]+['"`]/.test(specBodyOnly)) {
    violations.push(
      `[DIP Hardcoded URL Ban] ${specRel} contains a hardcoded http(s):// URL. Use baseURL via Page objects or Data Builders.`
    );
  }

  const specLiterals = new Set(
    [...specBodyOnly.matchAll(/(['"`])((?:\\.|(?!\1).)+)\1/g)].map((m) => m[2].trim())
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
}

// 6. Audit src/, tests/, .agents/skills/, .agents/domain/, and defects/ for leaked secret tokens
const SECRET_PATTERNS = [
  { name: 'GitHub Token', regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub Fine-Grained PAT', regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'API Secret Key (sk-*)', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'AWS Access Key ID', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Private Key Block', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Raw JWT Bearer Token', regex: /\bBearer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Insecure Default Password Placeholder', regex: /['"`]ChangeMe123!['"`]/ },
];

const allCodeAndArtifactFiles = [
  ...walkFiles(path.join(ROOT, 'src'), '.ts'),
  ...walkFiles(path.join(ROOT, 'tests'), '.ts'),
  ...walkFiles(path.join(ROOT, '.agents/skills')),
  ...walkFiles(path.join(ROOT, '.agents/domain'), '.md'),
  ...walkFiles(path.join(ROOT, 'defects'), '.md'),
];
for (const targetFile of allCodeAndArtifactFiles) {
  const rawText = fs.readFileSync(targetFile, 'utf8');
  const inspectText = targetFile.endsWith('.ts') ? stripComments(rawText) : rawText;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.regex.test(inspectText)) {
      violations.push(
        `[Secret Hygiene Gate] ${rel(targetFile)} contains a ${pattern.name}. Inject sensitive values via environment variables in src/data/*.builder.ts.`
      );
    }
  }
  const relTarget = rel(targetFile);
  if (
    relTarget.startsWith('.agents/skills/') &&
    relTarget.includes('/scripts/') &&
    /(?:password|secret|api[_-]?key|token)\s*[:=]\s*['"`][^'"`$]{4,}['"`]/i.test(rawText)
  ) {
    violations.push(
      `[Secret Hygiene Gate] ${relTarget} contains a hardcoded credential assignment. Parameterize secrets via process.env.`
    );
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
