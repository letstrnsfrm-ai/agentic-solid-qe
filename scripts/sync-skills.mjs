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
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_ROOT = path.resolve(__dirname, '..');

const rawArgs = process.argv.slice(2);

if (rawArgs.includes('--help') || rawArgs.includes('-h') || rawArgs[0] === 'help') {
  console.log(`
🧠 Cortex / ASQE — Agentic-SOLID-QE Unified CLI (cortex | asqe | agentic-solid-qe)

Usage:
  cortex init [target-dir] [--url <url>] [--name "<App Name>"] [--reset] [--demo] [--dry-run]
  cortex sync [target-dir] [--squad <squad-name>] [--org-brain <path>] [--dry-run]
  cortex migrate --discover
  cortex migrate <legacy-path> [--name <skill-id>] [--squad <squad>] [--apply]
  cortex graph                 Compile 3-Tier Federated Brain (.agents/domain/domain-graph.json)
  cortex gaps                  Run Coverage, Staleness & Traceability Analyzer
  cortex audit                 Run SOLID, Token Budget & Domain Shard Gate
`);
  process.exit(0);
}

const subcommandDelegateMap = {
  migrate: 'migrate-skill.mjs',
  graph: 'build-domain-graph.mjs',
  gaps: 'analyze-coverage.mjs',
  audit: 'audit-solid.mjs',
};

if (rawArgs[0] && subcommandDelegateMap[rawArgs[0]]) {
  const scriptFile = path.join(__dirname, subcommandDelegateMap[rawArgs[0]]);
  const res = spawnSync(process.execPath, [scriptFile, ...rawArgs.slice(1)], {
    stdio: 'inherit',
  });
  process.exit(res.status ?? 0);
}

let command = 'sync';
let targetArg = '.';
let appUrl = '';
let appName = '';
let squadName = '';
let orgBrainSource = '';
let resetDemo = false;
let includeDemo = false;
let dryRun = false;

const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--reset' || arg === '--clean') {
    resetDemo = true;
  } else if (arg === '--demo') {
    includeDemo = true;
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--url' && rawArgs[i + 1]) {
    appUrl = rawArgs[++i];
  } else if (arg.startsWith('--url=')) {
    appUrl = arg.slice('--url='.length);
  } else if (arg === '--name' && rawArgs[i + 1]) {
    appName = rawArgs[++i];
  } else if (arg.startsWith('--name=')) {
    appName = arg.slice('--name='.length);
  } else if (arg === '--squad' && rawArgs[i + 1]) {
    squadName = rawArgs[++i];
  } else if (arg.startsWith('--squad=')) {
    squadName = arg.slice('--squad='.length);
  } else if (arg === '--org-brain' && rawArgs[i + 1]) {
    orgBrainSource = rawArgs[++i];
  } else if (arg.startsWith('--org-brain=')) {
    orgBrainSource = arg.slice('--org-brain='.length);
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

function sanitizeAppName(rawName) {
  const cleaned = String(rawName || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\x00-\x1F\x7F|`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Target Web Application';
}

const TARGET_ROOT = path.resolve(process.cwd(), targetArg);
const resolvedUrl = appUrl || process.env.BASE_URL || 'http://localhost:3000';
const resolvedAppName = sanitizeAppName(appName);

function assertSafeTargetDirectory(resolvedTarget) {
  const normalized = path.resolve(resolvedTarget);
  const homeDir = path.resolve(os.homedir());
  const forbiddenExact = new Set([
    '/',
    homeDir,
    '/root',
    '/etc',
    '/usr',
    '/var',
    '/bin',
    '/sbin',
    '/lib',
    '/lib64',
    '/opt',
    '/proc',
    '/sys',
    '/dev',
    '/tmp',
  ]);
  const forbiddenPrefixes = ['/etc/', '/usr/', '/var/', '/bin/', '/sbin/', '/lib/', '/proc/', '/sys/', '/dev/'];
  if (
    forbiddenExact.has(normalized) ||
    forbiddenPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) {
    console.error(`❌ Refusing to run against protected system or home directory: '${normalized}'.`);
    process.exit(1);
  }
  if (fs.existsSync(normalized) && fs.lstatSync(normalized).isSymbolicLink()) {
    console.error(`❌ Refusing to run against symbolic link target directory: '${normalized}'.`);
    process.exit(1);
  }
}

function assertSafeHttpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    console.error(`❌ Invalid URL '${rawUrl}'. Must be a valid http:// or https:// URL.`);
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error(`❌ Unsupported URL protocol '${parsed.protocol}' in '${rawUrl}'. Only http: and https: are allowed.`);
    process.exit(1);
  }
  return parsed.toString().replace(/\/$/, '') || rawUrl;
}

function assertSafeSlug(value, flagName) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value) || value.includes('..')) {
    console.error(`❌ Invalid ${flagName} '${value}'. Must be a kebab-case identifier ([a-z0-9-]) with no path separators.`);
    process.exit(1);
  }
  return value.toLowerCase();
}

assertSafeTargetDirectory(TARGET_ROOT);
assertSafeHttpUrl(resolvedUrl);
if (squadName) {
  squadName = assertSafeSlug(squadName, '--squad');
}

function rel(dest) {
  return path.relative(TARGET_ROOT, dest) || '.';
}

function copyRecursive(src, dest, { overwrite = true } = {}) {
  if (!fs.existsSync(src)) return;
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    if (!dryRun) {
      fs.mkdirSync(dest, { recursive: true });
    }
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry), { overwrite });
    }
  } else {
    if (!overwrite && fs.existsSync(dest)) {
      console.log(`⏭️  Skipped existing: ${rel(dest)}`);
      return;
    }
    if (!dryRun) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (path.resolve(src) !== path.resolve(dest)) {
        fs.copyFileSync(src, dest);
      }
    }
    console.log(`${dryRun ? '🔍 [DRY-RUN] Would sync' : overwrite ? '🔄 Synced' : '🌱 Created'}: ${rel(dest)}`);
  }
}

function writeFileSafe(dest, content, { overwrite = false } = {}) {
  if (!overwrite && fs.existsSync(dest)) {
    console.log(`⏭️  Skipped existing: ${rel(dest)}`);
    return;
  }
  if (!dryRun) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }
  console.log(`${dryRun ? '🔍 [DRY-RUN] Would write' : overwrite ? '✨ Initialized' : '🌱 Created'}: ${rel(dest)}`);
}

function clearDirectoryFiles(dirPath, extFilter) {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      clearDirectoryFiles(fullPath, extFilter);
    } else if (!extFilter || entry.name.endsWith(extFilter)) {
      if (!dryRun) {
        fs.unlinkSync(fullPath);
      }
      console.log(`${dryRun ? '🔍 [DRY-RUN] Would remove' : '🧹 Removed'} demo artifact: ${rel(fullPath)}`);
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

## 3. Federated Domain & Feature Shard Index (Progressive Disclosure)

> **Agent Instruction:** Read **only** the shard(s) matching the route or feature under test. When discovering new behaviours, append them to the matching shard (or create a new \`.agents/domain/shards/<feature>.md\` ≤ 150 lines and register it below).

| Bounded Context / Feature | Owner Squad | Routes | Shard / Sub-Hub Path | Published Capabilities & Summary |
| :--- | :--- | :--- | :--- | :--- |

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
    if (!dryRun) {
      fs.mkdirSync(path.join(TARGET_ROOT, d), { recursive: true });
    }
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

  for (const sharedPath of [
    'src/contracts/api-client.contract.ts',
    'src/contracts/wizard-step.contract.ts',
    'src/shared/api/auth-token.bridge.ts',
    'src/shared/data/relative-date.helper.ts',
  ]) {
    copyRecursive(path.join(SOURCE_ROOT, sharedPath), path.join(TARGET_ROOT, sharedPath), {
      overwrite,
    });
  }

  writeFileSafe(
    path.join(TARGET_ROOT, 'src/data/user.builder.ts'),
    `export interface UserPersona {
  readonly role: 'standard' | 'admin' | 'unauthenticated' | string;
  readonly username: string;
  readonly password: string;
  readonly expectedErrorBanner?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(\`Missing required environment variable: \${name}. Set it in .env or CI secrets.\`);
  }
  return value;
}

/**
 * Typed Data Builder (DIP) centralizing persona credentials and expected validation messages.
 * Specs must reference UserBuilder methods rather than hardcoding magic strings.
 */
export class UserBuilder {
  static standardUser(): UserPersona {
    return {
      role: 'standard',
      username: process.env.TEST_USERNAME ?? 'test.user@example.com',
      password: requireEnv('TEST_PASSWORD'),
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

  writeFileSafe(
    path.join(TARGET_ROOT, '.env.example'),
    `# Agentic-SOLID-QE Environment & Persona Credentials Template
# Copy this file to .env (git-ignored by init) and supply values for your environment.
BASE_URL=${resolvedUrl}
TEST_USERNAME=test.user@example.com
TEST_PASSWORD=
`,
    { overwrite: false }
  );

  writeFileSafe(
    path.join(TARGET_ROOT, 'tests/auth.setup.ts'),
    `import fs from 'node:fs';
import path from 'node:path';
import { test as setup } from '@playwright/test';

const authFile = '.auth/standard.json';

/**
 * Global Persona Auth Setup (wired automatically by playwright.config.ts).
 * Customize the login steps below or run /00-env-bootstrap to capture .auth/standard.json.
 */
setup('authenticate standard persona', async ({ page }) => {
  const username = process.env.TEST_USERNAME;
  const password = process.env.TEST_PASSWORD;
  if (!username || !password) {
    setup.skip(true, 'Set TEST_USERNAME and TEST_PASSWORD in .env or CI secrets to mint .auth/standard.json');
    return;
  }

  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  await page.goto('/');
  // TODO: Replace with your app login steps (or capture via /00-env-bootstrap), then save storageState:
  await page.context().storageState({ path: authFile });
});
`,
    { overwrite }
  );
}

function mergeConsumerPackageJson() {
  const pkgPath = path.join(TARGET_ROOT, 'package.json');
  const requiredScripts = {
    test: 'playwright test --project=chromium --pass-with-no-tests',
    'test:p0': 'playwright test --project=chromium --grep "@p0" --pass-with-no-tests',
    'test:smoke': 'playwright test --project=chromium --grep "@smoke|@p0" --pass-with-no-tests',
    'test:api': 'playwright test --project=chromium --grep "@api-contract" --pass-with-no-tests',
    'test:engine': 'node --test scripts/self-test.mjs',
    'test:headed': 'playwright test --headed',
    'test:ui': 'playwright test --ui',
    report: 'playwright show-report',
    typecheck: 'tsc --noEmit',
    'domain:graph': 'node scripts/build-domain-graph.mjs',
    'migrate:skill': 'node scripts/migrate-skill.mjs',
    'coverage:gaps': 'node scripts/analyze-coverage.mjs',
    'audit:solid': 'node scripts/audit-solid.mjs',
    'validate:tapes': 'node scripts/validate-tapes.mjs',
    verify: 'npm run typecheck && npm run domain:graph && npm run audit:solid && npm run validate:tapes && npm test',
    'init:app': 'node scripts/sync-skills.mjs init --reset',
    'sync:skills': 'node scripts/sync-skills.mjs',
    'upgrade:skills': 'npx --yes github:letstrnsfrm-ai/agentic-solid-qe sync',
  };
  const requiredDevDeps = {
    '@playwright/cli': '0.1.22',
    '@playwright/test': '1.64.1',
    '@types/node': '22.20.5',
    typescript: '5.9.3',
  };

  const requiredOverrides = {
    playwright: '1.64.1',
    'playwright-core': '1.64.1',
  };

  if (!fs.existsSync(pkgPath)) {
    const newPkg = {
      name: path.basename(TARGET_ROOT) || 'my-app-e2e',
      version: '0.1.0',
      private: true,
      type: 'module',
      scripts: requiredScripts,
      devDependencies: requiredDevDeps,
      overrides: requiredOverrides,
    };
    if (!dryRun) {
      fs.writeFileSync(pkgPath, JSON.stringify(newPkg, null, 2) + '\n', 'utf8');
    }
    console.log(`${dryRun ? '🔍 [DRY-RUN] Would create' : '🌱 Created'}: package.json`);
    return;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.scripts = pkg.scripts || {};
    pkg.devDependencies = pkg.devDependencies || {};
    pkg.overrides = pkg.overrides || {};
    const allDeps = { ...(pkg.dependencies || {}), ...pkg.devDependencies };

    let modified = false;
    for (const [k, v] of Object.entries(requiredScripts)) {
      if (
        !pkg.scripts[k] ||
        (k === 'test' && pkg.scripts[k] === 'playwright test --project=chromium') ||
        (k === 'upgrade:skills' && pkg.scripts[k].includes('#v0.2.0'))
      ) {
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
    for (const [ovKey, ovVer] of Object.entries(requiredOverrides)) {
      if (!pkg.overrides[ovKey]) {
        pkg.overrides[ovKey] = ovVer;
        modified = true;
      }
    }
    if (modified) {
      if (!dryRun) {
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      }
      console.log(
        `${dryRun ? '🔍 [DRY-RUN] Would merge' : '🔧 Merged'} SOLID QE scripts & devDependencies into: package.json`
      );
    }
  } catch {
    console.warn(`⚠️  Could not parse existing package.json; skipping script merge.`);
  }
}

/**
 * Strips single-line (//), block (/* * /), and trailing commas outside string literals
 * so real-world JSONC tsconfig.json files can be parsed and merged safely.
 */
function stripJsonCommentsAndTrailingCommas(raw) {
  let out = '';
  let inString = false;
  let quoteChar = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < raw.length) {
        out += raw[++i];
      } else if (ch === quoteChar) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quoteChar = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      if (i < raw.length) out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function mergeConsumerTsConfig() {
  const tsconfigPath = path.join(TARGET_ROOT, 'tsconfig.json');
  const requiredPaths = {
    '@contracts/*': ['src/contracts/*'],
    '@components/*': ['src/components/*'],
    '@pages/*': ['src/pages/*'],
    '@fixtures/*': ['src/fixtures/*'],
    '@data/*': ['src/data/*'],
    '@domains/*': ['src/domains/*'],
    '@shared/*': ['src/shared/*'],
  };

  if (!fs.existsSync(tsconfigPath)) {
    copyRecursive(path.join(SOURCE_ROOT, 'tsconfig.json'), tsconfigPath, { overwrite: false });
    return;
  }

  try {
    const raw = fs.readFileSync(tsconfigPath, 'utf8');
    const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(raw));
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
      if (!dryRun) {
        fs.writeFileSync(tsconfigPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      }
      console.log(
        `${dryRun ? '🔍 [DRY-RUN] Would merge' : '🔧 Merged'} @contracts/@components/@pages/@fixtures/@data/@domains/@shared aliases into: tsconfig.json`
      );
    }
  } catch {
    console.warn(`⚠️  Could not auto-merge tsconfig.json; verify @* path aliases manually.`);
  }
}

function configurePlaywrightConfig() {
  const pwConfigPath = path.join(TARGET_ROOT, 'playwright.config.ts');
  const serializedUrl = JSON.stringify(resolvedUrl);
  if (!fs.existsSync(pwConfigPath)) {
    const templateConfig = fs.readFileSync(path.join(SOURCE_ROOT, 'playwright.config.ts'), 'utf8');
    const customized = templateConfig.replace(
      /baseURL:\s*process\.env\.BASE_URL\s*\|\|\s*['"][^'"]+['"]/,
      `baseURL: process.env.BASE_URL || ${serializedUrl}`
    );
    if (!dryRun) {
      fs.writeFileSync(pwConfigPath, customized, 'utf8');
    }
    console.log(`${dryRun ? '🔍 [DRY-RUN] Would create' : '🌱 Created'}: playwright.config.ts (baseURL -> ${resolvedUrl})`);
  } else if (appUrl || resetDemo) {
    const existing = fs.readFileSync(pwConfigPath, 'utf8');
    const updated = existing.replace(
      /baseURL:\s*process\.env\.BASE_URL\s*\|\|\s*['"][^'"]+['"]/,
      `baseURL: process.env.BASE_URL || ${serializedUrl}`
    );
    if (updated !== existing) {
      if (!dryRun) {
        fs.writeFileSync(pwConfigPath, updated, 'utf8');
      }
      console.log(`${dryRun ? '🔍 [DRY-RUN] Would update' : '🔧 Updated'} baseURL in playwright.config.ts -> ${resolvedUrl}`);
    }
  }
}

const REQUIRED_GITIGNORE_ENTRIES = [
  'node_modules/',
  'test-results/',
  'playwright-report/',
  'blob-report/',
  '.playwright-cli/',
  '.auth/',
  '.env',
  '.env.*',
  '!.env.example',
];

/**
 * Ensures consumer repos never commit secrets or session tokens (.env, .auth/*.json).
 * Creates .gitignore if missing; otherwise appends only the missing entries (non-destructive).
 */
function mergeConsumerGitignore() {
  const ignorePath = path.join(TARGET_ROOT, '.gitignore');
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = REQUIRED_GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const header = existing ? '\n# Added by agentic-solid-qe (secrets, session tokens, artifacts)\n' : '';
  if (!dryRun) {
    fs.writeFileSync(ignorePath, `${existing}${prefix}${header}${missing.join('\n')}\n`, 'utf8');
  }
  console.log(
    `${dryRun ? '🔍 [DRY-RUN] Would update' : existing ? '🔧 Updated' : '🌱 Created'}: .gitignore (+${missing.length} entries: ${missing.join(', ')})`
  );
}

function backupPreExistingInstructionFiles() {
  if (path.resolve(SOURCE_ROOT) === path.resolve(TARGET_ROOT)) return;
  const candidateBackups = [
    { relPath: 'AGENTS.md', backupName: 'AGENTS.legacy.md' },
    { relPath: '.github/copilot-instructions.md', backupName: 'copilot-instructions.legacy.md' },
  ];
  for (const item of candidateBackups) {
    const existingPath = path.join(TARGET_ROOT, item.relPath);
    if (!fs.existsSync(existingPath) || fs.lstatSync(existingPath).isSymbolicLink()) continue;
    const content = fs.readFileSync(existingPath, 'utf8');
    if (content.includes('agentic-solid-qe')) continue;
    const backupDest = path.join(TARGET_ROOT, '.agents/legacy-backups', item.backupName);
    if (!fs.existsSync(backupDest)) {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(backupDest), { recursive: true });
        fs.copyFileSync(existingPath, backupDest);
      }
      console.log(
        `${dryRun ? '🔍 [DRY-RUN] Would back up' : '📦 Backed up'} pre-existing instructions: ${item.relPath} -> ${rel(backupDest)} (discoverable via 'npm run migrate:skill -- --discover')`
      );
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
  'scripts/build-domain-graph.mjs',
  'scripts/migrate-skill.mjs',
  'scripts/analyze-coverage.mjs',
  'scripts/audit-solid.mjs',
  'scripts/validate-tapes.mjs',
  'scripts/sync-skills.mjs',
  'scripts/self-test.mjs',
];

console.log(
  `\n🚀 Running agentic-solid-qe (${command}${resetDemo ? ' --reset' : ''}${includeDemo ? ' --demo' : ''}${dryRun ? ' --dry-run' : ''}) -> ${TARGET_ROOT}\n`
);

backupPreExistingInstructionFiles();

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
      if (!dryRun) {
        fs.writeFileSync(targetDomainMemory, existingMem, 'utf8');
      }
      console.log(`${dryRun ? '🔍 [DRY-RUN] Would update' : '🔧 Updated'} Application Name / Base URL in .agents/domain/domain-memory.md`);
    } else {
      console.log(`🛡️  Preserved existing: .agents/domain/domain-memory.md`);
    }
    scaffoldCleanSolidSkeleton({ overwrite: false });
  }

  mergeConsumerPackageJson();
  mergeConsumerTsConfig();
  configurePlaywrightConfig();
  mergeConsumerGitignore();
  copyRecursive(
    path.join(SOURCE_ROOT, '.github/workflows/playwright-ci.yml'),
    path.join(TARGET_ROOT, '.github/workflows/playwright-ci.yml'),
    { overwrite: false }
  );
} else {
  // sync mode: preserve consumer domain-memory.md and existing src/, while seeding new foundational contracts/shared helpers if missing
  if (!fs.existsSync(targetDomainMemory)) {
    writeFileSafe(targetDomainMemory, buildCleanDomainMemory(resolvedAppName, resolvedUrl), {
      overwrite: false,
    });
  } else {
    console.log(`🛡️  Preserved existing: .agents/domain/domain-memory.md`);
    if (!dryRun) {
      fs.mkdirSync(targetShardsDir, { recursive: true });
    }

    const existingMemory = fs.readFileSync(targetDomainMemory, 'utf8');
    if (!existingMemory.includes('Feature Shard Index')) {
      const shardMigrationBlock = `\n---\n\n## Feature Shard Index (Progressive Disclosure)\n\n| Feature / Domain Area | Routes | Shard Path | Summary |\n| :--- | :--- | :--- | :--- |\n`;
      if (!dryRun) {
        fs.appendFileSync(targetDomainMemory, shardMigrationBlock, 'utf8');
      }
      console.log(
        `${dryRun ? '🔍 [DRY-RUN] Would upgrade' : '✨ Upgraded'} .agents/domain/domain-memory.md with a 'Feature Shard Index' table (existing content preserved).`
      );
    }
  }

  for (const foundationalPath of [
    'src/contracts/identifiable-component.contract.ts',
    'src/contracts/error-banner.contract.ts',
    'src/contracts/api-client.contract.ts',
    'src/contracts/wizard-step.contract.ts',
    'src/shared/api/auth-token.bridge.ts',
    'src/shared/data/relative-date.helper.ts',
  ]) {
    copyRecursive(path.join(SOURCE_ROOT, foundationalPath), path.join(TARGET_ROOT, foundationalPath), {
      overwrite: false,
    });
  }

  mergeConsumerPackageJson();
  mergeConsumerTsConfig();
  mergeConsumerGitignore();
}

// Optional: Federated Org Brain sync (--org-brain <path>)
if (orgBrainSource) {
  const resolvedBrainRoot = path.resolve(process.cwd(), orgBrainSource);
  if (fs.existsSync(resolvedBrainRoot) && !fs.lstatSync(resolvedBrainRoot).isSymbolicLink()) {
    for (const sharedRel of [
      '.agents/domain/domain-memory.md',
      '.agents/domain/domain-graph.json',
      'src/contracts',
      'src/shared',
    ]) {
      const srcPath = path.join(resolvedBrainRoot, sharedRel);
      if (fs.existsSync(srcPath)) {
        copyRecursive(srcPath, path.join(TARGET_ROOT, sharedRel), { overwrite: true });
      }
    }
    console.log(`🌐 Synced Federated Org Brain from: ${resolvedBrainRoot}`);
  } else {
    console.warn(`⚠️  --org-brain path not found: ${resolvedBrainRoot}`);
  }
}

// Optional: Scaffold a Tier 1 Squad Domain Sub-Hub & SOLID Module (--squad <squad-name>)
if (squadName) {
  const cleanSquad = squadName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const squadHubDir = path.join(TARGET_ROOT, '.agents/domain/domains', cleanSquad);
  if (!dryRun) {
    fs.mkdirSync(path.join(squadHubDir, 'shards'), { recursive: true });
    for (const sub of ['api', 'components', 'steps', 'pages', 'data', 'fixtures']) {
      fs.mkdirSync(path.join(TARGET_ROOT, 'src/domains', cleanSquad, sub), { recursive: true });
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const hubFile = path.join(squadHubDir, 'index.md');
  writeFileSafe(
    hubFile,
    `# Domain Sub-Hub: ${cleanSquad} (Tier 1 Bounded Context)

> **Parent Index:** \`.agents/domain/domain-memory.md\` | **Max Lines:** 150
> **Owner Squad:** \`@org/${cleanSquad}-squad\` | **Last Verified:** \`${today}\`
> **Published Capabilities:** \`UserBuilder\`

---

## 1. Bounded Context & Upstream/Downstream Contracts

- **Owned Routes:** \`/${cleanSquad}\`
- **Upstream Preconditions:** Global persona session from \`.auth/<persona>.json\`.

---

## 2. Squad Feature Shard Index

| Feature Shard | Routes | Shard Path | Summary |
| :--- | :--- | :--- | :--- |
`,
    { overwrite: false }
  );

  if (fs.existsSync(targetDomainMemory)) {
    const mem = fs.readFileSync(targetDomainMemory, 'utf8');
    const relHub = `.agents/domain/domains/${cleanSquad}/index.md`;
    if (!mem.includes(relHub)) {
      const row = `| **${cleanSquad} Domain** | \`@org/${cleanSquad}-squad\` | \`/${cleanSquad}\` | \`${relHub}\` | Tier 1 Squad Sub-Hub |\n`;
      if (!dryRun) {
        fs.appendFileSync(targetDomainMemory, row, 'utf8');
      }
      console.log(
        `${dryRun ? '🔍 [DRY-RUN] Would register' : '🧭 Registered'} Tier 1 Squad Sub-Hub in .agents/domain/domain-memory.md: ${relHub}`
      );
    }
  }
}

console.log(
  `\n✅ Agentic-SOLID-QE (${command}${dryRun ? ' --dry-run' : ''}) complete! Next steps: run 'npm install && npx playwright install chromium', then 'npm run coverage:gaps' or invoke '/01-cli-explorer'.\n`
);
