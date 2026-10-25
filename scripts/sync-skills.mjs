#!/usr/bin/env node
/**
 * Upgrades or installs the Core Engine (.agents/skills/, session-tape.schema.json, AGENTS.md,
 * .github/copilot-instructions.md) into a target project directory WITHOUT overwriting
 * existing .agents/domain/domain-memory.md, src/, or tests/.
 *
 * Usage: npm run sync:skills -- /path/to/target-repo
 */
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_ROOT = process.cwd();
const targetArg = process.argv[2];

if (!targetArg) {
  console.log('Usage: npm run sync:skills -- <target-project-directory>');
  console.log('Copies/updates core skills while preserving domain-memory.md, src/, and tests/.');
  process.exit(0);
}

const TARGET_ROOT = path.resolve(targetArg);

function copyRecursiveOverwrite(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursiveOverwrite(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 1. Always sync static Core Engine layers
const alwaysSync = [
  '.agents/skills',
  '.agents/domain/session-tape.schema.json',
  'AGENTS.md',
  '.github/copilot-instructions.md',
  'scripts/audit-solid.mjs',
  'scripts/validate-tapes.mjs',
];

for (const relPath of alwaysSync) {
  const srcPath = path.join(SOURCE_ROOT, relPath);
  const destPath = path.join(TARGET_ROOT, relPath);
  copyRecursiveOverwrite(srcPath, destPath);
  console.log(`🔄 Synced Core Engine: ${relPath}`);
}

// 2. Seed domain-memory.md ONLY if it does not already exist in target
const domainMemoryRel = '.agents/domain/domain-memory.md';
const targetDomainMemory = path.join(TARGET_ROOT, domainMemoryRel);
if (!fs.existsSync(targetDomainMemory)) {
  copyRecursiveOverwrite(path.join(SOURCE_ROOT, domainMemoryRel), targetDomainMemory);
  console.log(`🌱 Seeded starter ${domainMemoryRel}`);
} else {
  console.log(`🛡️  Preserved existing ${domainMemoryRel}`);
}

console.log(`\n✅ Agentic-SOLID-QE Core Engine synced to ${TARGET_ROOT}`);
