#!/usr/bin/env node
/**
 * Deterministic SOLID & Skill Token Budget Gate (FR-3.2, FR-3.3, Section 6).
 * Zero external runtime dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const MAX_COMPONENT_LINES = 150;
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

// 4. Audit Specs (OCP/ISP Fixture injection + DIP Data Builder usage)
const specFiles = walkFiles(path.join(ROOT, 'tests'), '.spec.ts');
const BANNED_SPEC_STRINGS = ['secret_sauce', 'standard_user', 'locked_out_user', 'problem_user'];

for (const file of specFiles) {
  const content = fs.readFileSync(file, 'utf8');

  if (/from\s+['"]@playwright\/test['"]/.test(content)) {
    violations.push(
      `[OCP/ISP Fixture Rule] ${rel(file)} imports directly from '@playwright/test'. Import { test, expect } from '@fixtures/app.fixture' instead.`
    );
  }

  if (!/from\s+['"]@data\//.test(content) && !/from\s+['"].*\/data\//.test(content)) {
    violations.push(
      `[DIP Data Builder Rule] ${rel(file)} does not import any Data Builder from src/data/.`
    );
  }

  for (const magic of BANNED_SPEC_STRINGS) {
    if (content.includes(magic)) {
      violations.push(
        `[DIP Magic String Ban] ${rel(file)} contains hardcoded credential '${magic}'. Use UserBuilder instead.`
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
  `✅ SOLID Architecture Audit Passed (${skillFiles.length} skills < ${MAX_SKILL_TOKENS} tokens, ${componentFiles.length} components <= ${MAX_COMPONENT_LINES} lines, ${pageFiles.length} pages, ${specFiles.length} specs verified).`
);
