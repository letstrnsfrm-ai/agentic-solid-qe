#!/usr/bin/env node
/**
 * CLI Installer, Onboarding Initializer & Upgrader for Agentic-SOLID-QE.
 *
 * Usage:
 *   npx --yes github:letstrnsfrm-ai/agentic-solid-qe init [target-dir] [--url <url>] [--name <app-name>] [--reset] [--demo]
 *   npx --yes github:letstrnsfrm-ai/agentic-solid-qe sync [target-dir]
 *   npm run init:app -- --url https://your-app.com --name "Your App"
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_ROOT = path.resolve(__dirname, '..');

const rawArgs = process.argv.slice(2);
let command = 'sync';
let targetArg = '.';
let appUrl = '';
let appName = '';
let resetDemo = false;
let includeDemo = false;

const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--reset' || arg === '--clean') {
    resetDemo = true;
  } else if (arg === '--demo') {
    includeDemo = true;
  } else if (arg === '--url' && rawArgs[i + 1]) {
    appUrl = rawArgs[++i];
  } else if (arg.startsWith('--url=')) {
    appUrl = arg.slice('--url='.length);
  } else if (arg === '--name' && rawArgs[i + 1]) {
    appName = rawArgs[++i];
  } else if (arg.startsWith('--name=')) {
    appName = arg.slice('--name='.length);
  } else if (!arg.startsWith('-')) {
    positional.push(arg);
  }
}

if (positional[0] && ['init', 'sync'].includes(positional[0])) {
  command = positional[0];
  targetArg = positional[1] || '.';
} else if (positional[0]) {
  targetArg = positional[0];
}

const TARGET_ROOT = path.resolve(process.cwd(), targetArg);
const resolvedUrl = appUrl || process.env.BASE_URL || 'http://localhost:3000';
const resolvedAppName = appName || 'Target Web Application';

function rel(dest) {
  return path.relative(TARGET_ROOT, dest) || '.';
}

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
      console.log(`⏭️  Skipped existing: ${rel(dest)}`);
      return;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (path.resolve(src) !== path.resolve(dest)) {
      fs.copyFileSync(src, dest);
    }
    console.log(`${overwrite ? '🔄 Synced' : '🌱 Created'}: ${rel(dest)}`);
  }
}

function writeFileSafe(dest, content, { overwrite = false } = {}) {
  if (!overwrite && fs.existsSync(dest)) {
    console.log(`⏭️  Skipped existing: ${rel(dest)}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  console.log(`${overwrite ? '✨ Initialized' : '🌱 Created'}: ${rel(dest)}`);
}

function clearDirectoryFiles(dirPath, extFilter) {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      clearDirectoryFiles(fullPath, extFilter);
    } else if (!extFilter || entry.name.endsWith(extFilter)) {
      fs.unlinkSync(fullPath);
      console.log(`🧹 Removed demo artifact: ${rel(fullPath)}`);
    }
  }
}

function buildCleanDomainMemory(name, url) {
  return `# Domain Memory Index (Global Context & Shard Router)

> **Scalability Rule (Hub-and-Spoke):** Keep this index file **≤ 150 lines (< 600 tokens)**. Store only global environment config, personas, and the **Feature Shard Index**. Load and append feature-specific rules and discovered quirks inside \`.agents/domain/shards/<feature>.md\`.

---

## 1. Global Environment & Target Application

- **Application Name:** ${name}
- **Base URL:** \`${url}\`
- **Custom Test ID Attribute:** \`data-testid\` (\`testIdAttribute\` in \`playwright.config.ts\`)
- **Session Mechanism:** Browser cookies / \`localStorage\` / \`sessionStorage\`

---

## 2. Global Personas (Mapped to \`src/data/user.builder.ts\`)

| Persona Key | Builder Method | Global Behaviour |
| :--- | :--- | :--- |
| \`standard\` | \`UserBuilder.standardUser()\` | Default authenticated user for P0 Golden Path flows. |
| \`unauthenticated\` | \`N/A\` | Anonymous visitor for public routes and auth redirect checks. |

---

## 3. Feature Shard Index (Progressive Disclosure)

> **Agent Instruction:** Read **only** the shard(s) matching the route or feature under test. When discovering new behaviours, append them to the matching shard (or create a new \`.agents/domain/shards/<feature>.md\` ≤ 150 lines and register it below).

| Feature / Domain Area | Routes | Shard Path | Summary |
| :--- | :--- | :--- | :--- |

---

## 4. Memory Hygiene & Auto-Sharding Protocol

1. **Line Cap:** Neither \`domain-memory.md\` nor any \`.agents/domain/shards/*.md\` file may exceed **150 lines** (enforced by \`npm run audit:solid\`).
2. **Deduplication & Compaction:** Before appending to a shard, merge duplicate observations and remove outdated quirks.
3. **Auto-Splitting:** When a shard exceeds 120 lines, split it into sub-domain shards and update the table in Section 3.
`;
}

function scaffoldCleanSolidSkeleton({ overwrite = false } = {}) {
  const dirs = [
    '.agents/domain/shards',
    '.exploratory/tapes',
    'defects',
    'src/contracts',
    'src/components',
    'src/pages',
    'src/fixtures',
    'src/data',
    'tests',
  ];
  for (const d of dirs) {
    fs.mkdirSync(path.join(TARGET_ROOT, d), { recursive: true });
  }

  writeFileSafe(
    path.join(TARGET_ROOT, 'src/contracts/identifiable-component.contract.ts'),
    `import type { Locator } from '@playwright/test';

/**
 * Liskov Substitution Contract (LSP) for all atomic UI components.
 */
export interface IdentifiableComponent {
  readonly root: Locator;
}
`,
    { overwrite }
  );

  writeFileSafe(
    path.join(TARGET_ROOT, 'src/contracts/error-banner.contract.ts'),
    `import type { Locator } from '@playwright/test';
import type { IdentifiableComponent } from '@contracts/identifiable-component.contract';

/**
 * Shared contract for components that surface inline validation or alert banners.
 */
export interface ErrorBannerContract extends IdentifiableComponent {
  readonly errorBanner: Locator;
  dismissError(): Promise<void>;
}
`,
    { overwrite }
  );

  writeFileSafe(
    path.join(TARGET_ROOT, 'src/data/user.builder.ts'),
    `export interface UserPersona {
  readonly role: 'standard' | 'admin' | 'unauthenticated' | string;
  readonly username: string;
  readonly password: string;
  readonly expectedErrorBanner?: string;
}

const DEFAULT_USERNAME = process.env.TEST_USERNAME ?? 'test.user@example.com';
const DEFAULT_PASSWORD = process.env.TEST_PASSWORD ?? 'ChangeMe123!';

/**
 * Typed Data Builder (DIP) centralizing persona credentials and expected validation messages.
 * Specs must reference UserBuilder methods rather than hardcoding magic strings.
 */
export class UserBuilder {
  static standardUser(): UserPersona {
    return {
      role: 'standard',
      username: DEFAULT_USERNAME,
      password: DEFAULT_PASSWORD,
    };
  }
}
`,
    { overwrite }
  );

  writeFileSafe(
    path.join(TARGET_ROOT, 'src/fixtures/app.fixture.ts'),
    `import { test as base, expect } from '@playwright/test';

/**
 * Segregated Fixture Contract (OCP & ISP).
 * Register Page and Component objects here as 02-solid-architect compiles Session Tapes.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AppFixtures {}

export const test = base.extend<AppFixtures>({});

export { expect };
`,
    { overwrite }
  );
}

function mergeConsumerPackageJson() {
  const pkgPath = path.join(TARGET_ROOT, 'package.json');
  const requiredScripts = {
    test: 'playwright test --project=chromium --pass-with-no-tests',
    'test:headed': 'playwright test --headed',
    'test:ui': 'playwright test --ui',
    report: 'playwright show-report',
    typecheck: 'tsc --noEmit',
    'coverage:gaps': 'node scripts/analyze-coverage.mjs',
    'audit:solid': 'node scripts/audit-solid.mjs',
    'validate:tapes': 'node scripts/validate-tapes.mjs',
    verify: 'npm run typecheck && npm run audit:solid && npm run validate:tapes && npm test',
    'init:app': 'node scripts/sync-skills.mjs init --reset',
    'sync:skills': 'node scripts/sync-skills.mjs',
    'upgrade:skills': 'npx --yes github:letstrnsfrm-ai/agentic-solid-qe sync',
  };
  const requiredDevDeps = {
    '@playwright/cli': '^0.1.0',
    '@playwright/test': '^1.51.0',
    '@types/node': '^22.10.0',
    typescript: '^5.7.0',
  };

  if (!fs.existsSync(pkgPath)) {
    const newPkg = {
      name: path.basename(TARGET_ROOT) || 'my-app-e2e',
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: requiredScripts,
      devDependencies: requiredDevDeps,
    };
    fs.writeFileSync(pkgPath, JSON.stringify(newPkg, null, 2) + '\n', 'utf8');
    console.log(`🌱 Created: package.json`);
    return;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.scripts = pkg.scripts || {};
    pkg.devDependencies = pkg.devDependencies || {};
    const allDeps = { ...(pkg.dependencies || {}), ...pkg.devDependencies };

    let modified = false;
    for (const [k, v] of Object.entries(requiredScripts)) {
      if (!pkg.scripts[k] || (k === 'test' && pkg.scripts[k] === 'playwright test --project=chromium')) {
        pkg.scripts[k] = v;
        modified = true;
      }
    }
    for (const [dep, ver] of Object.entries(requiredDevDeps)) {
      if (!allDeps[dep]) {
        pkg.devDependencies[dep] = ver;
        modified = true;
      }
    }
    if (modified) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      console.log(`🔧 Merged SOLID QE scripts & devDependencies into: package.json`);
    }
  } catch {
    console.warn(`⚠️  Could not parse existing package.json; skipping script merge.`);
  }
}

function mergeConsumerTsConfig() {
  const tsconfigPath = path.join(TARGET_ROOT, 'tsconfig.json');
  const requiredPaths = {
    '@contracts/*': ['src/contracts/*'],
    '@components/*': ['src/components/*'],
    '@pages/*': ['src/pages/*'],
    '@fixtures/*': ['src/fixtures/*'],
    '@data/*': ['src/data/*'],
  };

  if (!fs.existsSync(tsconfigPath)) {
    copyRecursive(path.join(SOURCE_ROOT, 'tsconfig.json'), tsconfigPath, { overwrite: false });
    return;
  }

  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.compilerOptions = parsed.compilerOptions || {};
    if (!parsed.compilerOptions.baseUrl) {
      parsed.compilerOptions.baseUrl = '.';
    }
    parsed.compilerOptions.paths = parsed.compilerOptions.paths || {};
    let modified = false;
    for (const [alias, target] of Object.entries(requiredPaths)) {
      if (!parsed.compilerOptions.paths[alias]) {
        parsed.compilerOptions.paths[alias] = target;
        modified = true;
      }
    }
    if (modified) {
      fs.writeFileSync(tsconfigPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      console.log(`🔧 Merged @contracts/@components/@pages/@fixtures/@data aliases into: tsconfig.json`);
    }
  } catch {
    console.warn(`⚠️  Could not auto-merge tsconfig.json (may contain comments); verify @* path aliases manually.`);
  }
}

function configurePlaywrightConfig() {
  const pwConfigPath = path.join(TARGET_ROOT, 'playwright.config.ts');
  if (!fs.existsSync(pwConfigPath)) {
    const templateConfig = fs.readFileSync(path.join(SOURCE_ROOT, 'playwright.config.ts'), 'utf8');
    const customized = templateConfig.replace(
      /baseURL:\s*process\.env\.BASE_URL\s*\|\|\s*['"][^'"]+['"]/,
      `baseURL: process.env.BASE_URL || '${resolvedUrl}'`
    );
    fs.writeFileSync(pwConfigPath, customized, 'utf8');
    console.log(`🌱 Created: playwright.config.ts (baseURL -> ${resolvedUrl})`);
  } else if (appUrl || resetDemo) {
    const existing = fs.readFileSync(pwConfigPath, 'utf8');
    const updated = existing.replace(
      /baseURL:\s*process\.env\.BASE_URL\s*\|\|\s*['"][^'"]+['"]/,
      `baseURL: process.env.BASE_URL || '${resolvedUrl}'`
    );
    if (updated !== existing) {
      fs.writeFileSync(pwConfigPath, updated, 'utf8');
      console.log(`🔧 Updated baseURL in playwright.config.ts -> ${resolvedUrl}`);
    }
  }
}

// 1. Always sync static Core Engine layers
const coreEnginePaths = [
  '.agents/skills',
  '.agents/domain/session-tape.schema.json',
  'AGENTS.md',
  '.github/copilot-instructions.md',
  '.github/prompts',
  '.claude/commands',
  'scripts/analyze-coverage.mjs',
  'scripts/audit-solid.mjs',
  'scripts/validate-tapes.mjs',
  'scripts/sync-skills.mjs',
];

console.log(`\n🚀 Running agentic-solid-qe (${command}${resetDemo ? ' --reset' : ''}${includeDemo ? ' --demo' : ''}) -> ${TARGET_ROOT}\n`);

for (const relPath of coreEnginePaths) {
  copyRecursive(path.join(SOURCE_ROOT, relPath), path.join(TARGET_ROOT, relPath), {
    overwrite: true,
  });
}

const targetDomainMemory = path.join(TARGET_ROOT, '.agents/domain/domain-memory.md');
const targetShardsDir = path.join(TARGET_ROOT, '.agents/domain/shards');

if (command === 'init') {
  if (resetDemo) {
    // Wipe reference SauceDemo artifacts when resetting a template clone for a real consumer app
    clearDirectoryFiles(path.join(TARGET_ROOT, '.agents/domain/shards'), '.md');
    clearDirectoryFiles(path.join(TARGET_ROOT, '.exploratory/tapes'), '.json');
    clearDirectoryFiles(path.join(TARGET_ROOT, 'defects'), '.md');
    clearDirectoryFiles(path.join(TARGET_ROOT, 'src/components'), '.ts');
    clearDirectoryFiles(path.join(TARGET_ROOT, 'src/pages'), '.ts');
    clearDirectoryFiles(path.join(TARGET_ROOT, 'src/data'), '.ts');
    clearDirectoryFiles(path.join(TARGET_ROOT, 'tests'), '.spec.ts');

    writeFileSafe(targetDomainMemory, buildCleanDomainMemory(resolvedAppName, resolvedUrl), {
      overwrite: true,
    });
    scaffoldCleanSolidSkeleton({ overwrite: true });
  } else if (includeDemo) {
    // Explicitly requested SauceDemo reference suite
    copyRecursive(path.join(SOURCE_ROOT, '.agents/domain/domain-memory.md'), targetDomainMemory, {
      overwrite: false,
    });
    copyRecursive(path.join(SOURCE_ROOT, '.agents/domain/shards'), targetShardsDir, {
      overwrite: false,
    });
    for (const relPath of ['src', 'tests', '.exploratory/tapes', 'defects']) {
      copyRecursive(path.join(SOURCE_ROOT, relPath), path.join(TARGET_ROOT, relPath), {
        overwrite: false,
      });
    }
  } else {
    // Default clean consumer onboarding (no SauceDemo bloat)
    if (!fs.existsSync(targetDomainMemory)) {
      writeFileSafe(targetDomainMemory, buildCleanDomainMemory(resolvedAppName, resolvedUrl), {
        overwrite: false,
      });
    } else if (appUrl || appName) {
      let existingMem = fs.readFileSync(targetDomainMemory, 'utf8');
      if (appName) {
        existingMem = existingMem.replace(
          /- \*\*Application Name:\*\* .+/,
          `- **Application Name:** ${resolvedAppName}`
        );
      }
      if (appUrl) {
        existingMem = existingMem.replace(
          /- \*\*Base URL:\*\* `.+`/,
          `- **Base URL:** \`${resolvedUrl}\``
        );
      }
      fs.writeFileSync(targetDomainMemory, existingMem, 'utf8');
      console.log(`🔧 Updated Application Name / Base URL in .agents/domain/domain-memory.md`);
    } else {
      console.log(`🛡️  Preserved existing: .agents/domain/domain-memory.md`);
    }
    scaffoldCleanSolidSkeleton({ overwrite: false });
  }

  mergeConsumerPackageJson();
  mergeConsumerTsConfig();
  configurePlaywrightConfig();
} else {
  // sync mode: preserve consumer domain-memory.md and src/
  if (!fs.existsSync(targetDomainMemory)) {
    writeFileSafe(targetDomainMemory, buildCleanDomainMemory(resolvedAppName, resolvedUrl), {
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
}

console.log(`\n✅ Agentic-SOLID-QE (${command}) complete! Next step: run 'npm run coverage:gaps' or invoke '/01-cli-explorer'.\n`);
