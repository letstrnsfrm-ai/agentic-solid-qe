#!/usr/bin/env node
/**
 * CLI Installer & Upgrader for Agentic-SOLID-QE.
 *
 * Usage in any existing project:
 *   npx --yes github:letstrnsfrm-ai/agentic-solid-qe init [target-dir]   # Scaffolds skills + starter SOLID folders without overwriting existing user files
 *   npx --yes github:letstrnsfrm-ai/agentic-solid-qe sync [target-dir]   # Upgrades Core Engine (.agents/skills, schema, audit scripts) while preserving domain-memory.md & src/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const command = ['init', 'sync'].includes(args[0]) ? args[0] : 'sync';
const targetArg = ['init', 'sync'].includes(args[0]) ? args[1] || '.' : args[0] || '.';
const TARGET_ROOT = path.resolve(process.cwd(), targetArg);

function copyRecursive(src, dest, { overwrite = true } = {}) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry), { overwrite });
    }
  } else {
    if (!overwrite && fs.existsSync(dest)) {
      console.log(`⏭️  Skipped existing: ${path.relative(TARGET_ROOT, dest)}`);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`${overwrite ? '🔄 Synced' : '🌱 Created'}: ${path.relative(TARGET_ROOT, dest)}`);
  }
}

// 1. Always sync static Core Engine layers (including sync-skills.mjs itself)
const coreEnginePaths = [
  '.agents/skills',
  '.agents/domain/session-tape.schema.json',
  'AGENTS.md',
  '.github/copilot-instructions.md',
  'scripts/audit-solid.mjs',
  'scripts/validate-tapes.mjs',
  'scripts/sync-skills.mjs',
];

console.log(`\n🚀 Running agentic-solid-qe (${command}) -> ${TARGET_ROOT}\n`);

for (const relPath of coreEnginePaths) {
  copyRecursive(path.join(SOURCE_ROOT, relPath), path.join(TARGET_ROOT, relPath), {
    overwrite: true,
  });
}

// 2. Domain Memory Handling:
//    - New consumer (no domain-memory.md): seed starter domain-memory.md + reference shards.
//    - Existing consumer (has domain-memory.md): preserve their domain-memory.md, ensure .agents/domain/shards/ dir exists,
//      and non-destructively append the Feature Shard Index section if they are upgrading from a pre-sharded version.
const targetDomainMemory = path.join(TARGET_ROOT, '.agents/domain/domain-memory.md');
const targetShardsDir = path.join(TARGET_ROOT, '.agents/domain/shards');

if (!fs.existsSync(targetDomainMemory)) {
  copyRecursive(path.join(SOURCE_ROOT, '.agents/domain/domain-memory.md'), targetDomainMemory, {
    overwrite: false,
  });
  copyRecursive(path.join(SOURCE_ROOT, '.agents/domain/shards'), targetShardsDir, {
    overwrite: false,
  });
} else {
  console.log(`🛡️  Preserved existing: .agents/domain/domain-memory.md`);
  fs.mkdirSync(targetShardsDir, { recursive: true });

  const existingMemory = fs.readFileSync(targetDomainMemory, 'utf8');
  if (!existingMemory.includes('Feature Shard Index')) {
    const shardMigrationBlock = `\n---\n\n## Feature Shard Index (Progressive Disclosure)\n\n| Feature / Domain Area | Routes | Shard Path | Summary |\n| :--- | :--- | :--- | :--- |\n`;
    fs.appendFileSync(targetDomainMemory, shardMigrationBlock, 'utf8');
    console.log(
      `✨ Upgraded .agents/domain/domain-memory.md with a 'Feature Shard Index' table (existing content preserved).`
    );
  }
}

// 3. When running `init`, also scaffold starter SOLID folders (src/, tests/, .exploratory/tapes/) without overwriting
if (command === 'init') {
  const starterPaths = ['src', 'tests', '.exploratory/tapes', 'defects'];
  for (const relPath of starterPaths) {
    copyRecursive(path.join(SOURCE_ROOT, relPath), path.join(TARGET_ROOT, relPath), {
      overwrite: false,
    });
  }
}

console.log(`\n✅ Agentic-SOLID-QE (${command}) complete!\n`);
