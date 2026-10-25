#!/usr/bin/env node
/**
 * Deterministic SOLID & Skill Token Budget Gate (FR-3.2, FR-3.3, Section 6).
 * App-agnostic: dynamically extracts Data Builder values from src/data/*.builder.ts
 * to enforce DIP across any consumer application. Zero external runtime dependencies.
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
  return path.relative(ROOT, filePath);
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

// 1b. Audit Domain Memory Scalability (Hub + Shards <= 150 lines each, no unindexed shards)
const domainIndexFile = path.join(ROOT, '.agents/domain/domain-memory.md');
const shardFiles = walkFiles(path.join(ROOT, '.agents/domain/shards'), '.md');
if (fs.existsSync(domainIndexFile)) {
  const indexContent = fs.readFileSync(domainIndexFile, 'utf8');
  const indexLines = indexContent.split('\n').length;
  if (indexLines > MAX_DOMAIN_LINES) {
    violations.push(
      `[Domain Memory Cap] ${rel(domainIndexFile)} has ${indexLines} lines (max ${MAX_DOMAIN_LINES}). Move feature details into .agents/domain/shards/*.md.`
    );
  }
  for (const shard of shardFiles) {
    const shardRel = rel(shard).replace(/\\/g, '/');
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
}

function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

// 2. Audit Components (SRP <= 150 lines, Zero expect(), LSP contract implementation)
const componentFiles = walkFiles(path.join(ROOT, 'src/components'), '.ts');
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

// 3. Audit Pages (SRP Zero expect())
const pageFiles = walkFiles(path.join(ROOT, 'src/pages'), '.ts');
for (const file of pageFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const codeOnly = stripComments(content);
  if (/\bexpect\s*\(/.test(codeOnly)) {
    violations.push(
      `[SRP Assertion Ban] ${rel(file)} contains an expect() call. Expose readonly Locators and assert in tests/*.spec.ts.`
    );
  }
}

// 4. Dynamically extract domain constants from src/data/*.builder.ts for App-Agnostic DIP auditing
const builderFiles = walkFiles(path.join(ROOT, 'src/data'), '.builder.ts');
const dynamicBuilderLiterals = new Map(); // literal -> source builder file

for (const bFile of builderFiles) {
  const bCode = stripComments(fs.readFileSync(bFile, 'utf8'))
    .replace(/^\s*import\s+.*$/gm, '')
    .replace(/\brole\s*:\s*[^,\n}]+/g, '');
  const stringMatches = bCode.matchAll(/(['"])((?:\\.|(?!\1).)+)\1/g);
  for (const match of stringMatches) {
    const val = match[2].trim();
    if (val.length >= 5) {
      dynamicBuilderLiterals.set(val, rel(bFile));
    }
  }
}

// 5. Audit Specs (OCP/ISP Fixture injection + App-Agnostic DIP Data Builder & URL rules)
const specFiles = walkFiles(path.join(ROOT, 'tests'), '.spec.ts');

for (const file of specFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const codeWithoutComments = stripComments(content);

  if (/from\s+['"]@playwright\/test['"]/.test(codeWithoutComments)) {
    violations.push(
      `[OCP/ISP Fixture Rule] ${rel(file)} imports directly from '@playwright/test'. Import { test, expect } from '@fixtures/app.fixture' instead.`
    );
  }

  if (
    !/from\s+['"]@data\//.test(codeWithoutComments) &&
    !/from\s+['"].*\/data\//.test(codeWithoutComments)
  ) {
    violations.push(
      `[DIP Data Builder Rule] ${rel(file)} does not import any Data Builder from src/data/.`
    );
  }

  // Strip import lines and test/describe title strings before checking spec body literals
  const specBodyOnly = codeWithoutComments
    .replace(/^\s*import\s+.*$/gm, '')
    .replace(/\btest(?:\.describe)?\s*\(\s*(['"`])(?:\\.|(?!\1).)*\1/g, 'test(');

  if (/['"`]https?:\/\/[^'"`]+['"`]/.test(specBodyOnly)) {
    violations.push(
      `[DIP Hardcoded URL Ban] ${rel(file)} contains a hardcoded http(s):// URL. Use baseURL via Page objects or Data Builders.`
    );
  }

  const specLiterals = new Set(
    [...specBodyOnly.matchAll(/(['"`])((?:\\.|(?!\1).)+)\1/g)].map((m) => m[2].trim())
  );

  for (const [builderVal, sourceBuilder] of dynamicBuilderLiterals.entries()) {
    if (specLiterals.has(builderVal)) {
      violations.push(
        `[DIP Magic String Ban] ${rel(file)} hardcodes '${builderVal}' which is already defined in ${sourceBuilder}. Consume the Data Builder method instead.`
      );
    }
  }
}

if (violations.length > 0) {
  console.error('\n❌ SOLID Architecture Audit Failed:\n');
  for (const v of violations) {
    console.error(`  - ${v}`);
  }
  process.exit(1);
}

console.log(
  `✅ SOLID & Memory Audit Passed (${skillFiles.length} skills < ${MAX_SKILL_TOKENS} tokens, 1 hub + ${shardFiles.length} domain shards <= ${MAX_DOMAIN_LINES} lines, ${componentFiles.length} components <= ${MAX_COMPONENT_LINES} lines, ${pageFiles.length} pages, ${specFiles.length} specs verified against ${dynamicBuilderLiterals.size} Data Builder literals).`
);
