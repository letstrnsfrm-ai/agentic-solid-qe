#!/usr/bin/env node
/**
 * CLI Installer & Upgrader for Agentic-SOLID-QE.
 *
 * Usage in any existing project:
 *   npx github:letstrnsfrm-ai/agentic-solid-qe init [target-dir]   # Scaffolds skills + starter SOLID folders without overwriting existing user files
 *   npx github:letstrnsfrm-ai/agentic-solid-qe sync [target-dir]   # Upgrades Core Engine (.agents/skills, schema, audit scripts) while preserving domain-memory.md & src/
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

// 1. Always sync static Core Engine layers
const coreEnginePaths = [
  '.agents/skills',
  '.agents/domain/session-tape.schema.json',
  'AGENTS.md',
  '.github/copilot-instructions.md',
  'scripts/audit-solid.mjs',
  'scripts/validate-tapes.mjs',
];

console.log(`\n🚀 Running agentic-solid-qe (${command}) -> ${TARGET_ROOT}\n`);

for (const relPath of coreEnginePaths) {
  copyRecursive(path.join(SOURCE_ROOT, relPath), path.join(TARGET_ROOT, relPath), {
    overwrite: true,
  });
}

// 2. Seed domain-memory.md ONLY if it does not already exist in target
copyRecursive(
  path.join(SOURCE_ROOT, '.agents/domain/domain-memory.md'),
  path.join(TARGET_ROOT, '.agents/domain/domain-memory.md'),
  { overwrite: false }
);

// 3. When running `init`, also scaffold starter SOLID folders (src/, tests/, .exploratory/tapes/) without overwriting
if (command === 'init') {
  const starterPaths = ['src', 'tests', '.exploratory/tapes', 'defects'];
  for (const relPath of starterPaths) {
    copyRecursive(path.join(SOURCE_ROOT, relPath), path.join(TARGET_ROOT, relPath), {
      overwrite: false,
    });
  }
}

console.log(`\n✅ Agentic-SOLID-QE (${command}) complete!`);
console.log(`   Next steps:`);
console.log(`   1. Edit .agents/domain/domain-memory.md with your app's URL, personas, and rules.`);
console.log(`   2. Prompt your IDE agent: "Use 01-cli-explorer to explore our app and record a Session Tape."`);
console.log(`   3. Prompt your IDE agent: "Use 02-solid-architect to compile the Session Tape into SOLID specs."\n`);
