#!/usr/bin/env node
/**
 * CLI Installer, Onboarding Initializer & Upgrader for Agentic-SOLID-QE.
 *
 * Usage:
 *   npx --yes github:letstrnsfrm-ai/agentic-solid-qe#v0.47.1 init [target-dir] [--url <url>] [--name <app-name>] [--reset] [--demo]
 *   npx --yes github:letstrnsfrm-ai/agentic-solid-qe#v0.47.1 sync [target-dir]
 *   npm run init:app -- --url https://your-app.com --name "Your App"
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  detectLegacyTestProject,
  discoverLegacyTests,
  syncDiscoveryToManifest,
} from './legacy-test-migrator.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_ROOT = path.resolve(__dirname, '..');
const SOURCE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const rawArgs = process.argv.slice(2);

const subcommandDelegateMap = {
  orchestrate: 'orchestrate.mjs',
  status: 'orchestrate.mjs',
  context: 'context-pack.mjs',
  impact: 'impact-graph.mjs',
  tape: 'tape-cli.mjs',
  verify: 'verify-fast.mjs',
  upgrade: 'upgrade-framework.mjs',
  report: 'report-cloud.mjs',
  compile: 'compile-tape.mjs',
  explore: 'explore-session.mjs',
  heal: 'heal-drift.mjs',
  migrate: 'migrate-skill.mjs',
  wave: 'migration-wave-factory.mjs',
  graph: 'build-domain-graph.mjs',
  map: 'build-system-map.mjs',
  gaps: 'analyze-coverage.mjs',
  audit: 'audit-solid.mjs',
};

if (rawArgs[0] && Object.hasOwn(subcommandDelegateMap, rawArgs[0])) {
  const scriptFile = path.join(__dirname, subcommandDelegateMap[rawArgs[0]]);
  const res = spawnSync(process.execPath, [scriptFile, ...rawArgs.slice(1)], {
    stdio: 'inherit',
  });
  if (res.error) {
    console.error(`❌ Failed to invoke cortex ${rawArgs[0]}: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

if (rawArgs.includes('--help') || rawArgs.includes('-h') || rawArgs[0] === 'help') {
  console.log(`
🧠 Cortex / ASQE — Agentic-SOLID-QE Unified CLI (cortex | asqe | agentic-solid-qe)

Usage:
  cortex orchestrate [--loop]  Run Master Orchestrator Diagnostic or Smart Auto-Drain Loop (--loop) (alias: cortex status)
  cortex verify [--fast]       Run parallel two-tier verification gate (incremental tsc + domain:graph + audit + tapes + tests)
  cortex upgrade               Resolve latest release tag and incrementally sync skills, contracts, and upgrade patches
  cortex report                Emit opt-in sanitized governance telemetry (schemaVersion: 1.0.0) to Cortex Cloud
  cortex compile [<tape>]      Compile Session Tape into SOLID Components, Pages, Builders, Fixtures & Spec (--apply)
  cortex explore <cmd>         High-speed Point-A seed/spec/checkpoint attach, batched explore & live tape recorder
  cortex heal [--spec <path>]  Diagnose failing specs & heal drifted locators (--apply)
  cortex init [target-dir] [--url <url>] [--name "<App Name>"] [--reset] [--demo] [--dry-run]
  cortex sync [target-dir] [--squad <squad-name>] [--org-brain <path>] [--dry-run] [--force]
  cortex migrate --discover
  cortex migrate <legacy-path> [--name <skill-id>] [--squad <squad>] [--apply]
  cortex wave [options]        2,000-test Squad Wave Factory, Wave-0 Seeders/Flows & HTML Parity Dashboard
  cortex graph                 Compile 3-Tier Federated Brain (.agents/domain/domain-graph.json)
  cortex map [--out <path>]    Generate interactive HTML System & Business Flow Map (reports/system-map.html)
  cortex context [options]     Build single-call <=400-token Context Pack (--route/--squad/--tape/--spec/--file)
  cortex impact [options]      Fixture-aware blast-radius & affected-spec analyzer (--file/--base/--specs-only)
  cortex tape <cmd> [args]     Compact Session Tape CLI (list | show | clone | patch) with v1 validation
  cortex gaps                  Run Coverage, Staleness & Traceability Analyzer
  cortex audit                 Run SOLID, Token Budget & Domain Shard Gate
`);
  process.exit(0);
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
let forceOverwrite = false;
let hereFlag = false;

const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === '--reset' || arg === '--clean') {
    resetDemo = true;
  } else if (arg === '--demo') {
    includeDemo = true;
  } else if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--force') {
    forceOverwrite = true;
  } else if (arg === '--here') {
    hereFlag = true;
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

const rawTargetRoot = path.resolve(process.cwd(), targetArg);
const legacyProjectCheck =
  command === 'init' && !hereFlag && !['e2e-playwright', 'qe-playwright'].includes(path.basename(rawTargetRoot))
    ? detectLegacyTestProject(rawTargetRoot)
    : { detected: false, stacks: [], buildFiles: [] };

const TARGET_ROOT = legacyProjectCheck.detected
  ? path.join(rawTargetRoot, 'e2e-playwright')
  : rawTargetRoot;

if (legacyProjectCheck.detected) {
  console.log(
    `🧭 Detected ${legacyProjectCheck.stacks.join('/')} project (${legacyProjectCheck.buildFiles.join(', ')}) at ${rawTargetRoot}.`
  );
  console.log(
    `   Installing Agentic-SOLID-QE side-by-side into ${TARGET_ROOT} (pass --here to override).`
  );
}

let resolvedUrl = appUrl || process.env.BASE_URL || 'http://localhost:3000';
const resolvedAppName = sanitizeAppName(appName);

function assertSafeTargetDirectory(resolvedTarget, label = 'target directory') {
  const normalized = path.resolve(resolvedTarget);
  const homeDir = path.resolve(os.homedir());
  const tmpBase = path.resolve(os.tmpdir());
  const isInsideTmp = normalized !== tmpBase && normalized.startsWith(tmpBase + path.sep);
  const forbiddenExact = new Set([
    '/',
    homeDir,
    tmpBase,
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
    '/System',
    '/Library',
    '/Users',
  ]);
  const forbiddenPrefixes = [
    '/etc/',
    '/usr/',
    '/var/',
    '/bin/',
    '/sbin/',
    '/lib/',
    '/proc/',
    '/sys/',
    '/dev/',
    '/System/',
    '/Library/',
  ];
  if (
    forbiddenExact.has(normalized) ||
    (!isInsideTmp && forbiddenPrefixes.some((prefix) => normalized.startsWith(prefix))) ||
    (!isInsideTmp &&
      (/^[A-Za-z]:\\?$/.test(normalized) ||
        /^[A-Za-z]:\\Users\\?$/i.test(normalized) ||
        /^[A-Za-z]:\\(?:Windows|Program Files|Program Files \(x86\)|ProgramData)(?:\\|$)/i.test(normalized)))
  ) {
    console.error(`❌ Refusing to run against protected system or home ${label}: '${normalized}'.`);
    process.exit(1);
  }
  const normalizedSegments = normalized.split(path.sep);
  if (normalizedSegments.includes('.git')) {
    console.error(`❌ Refusing to run against a .git internal ${label}: '${normalized}'.`);
    process.exit(1);
  }
  if (
    normalized !== SOURCE_ROOT &&
    SOURCE_ROOT.startsWith(normalized + path.sep)
  ) {
    console.error(`❌ Refusing to target parent directory '${normalized}' containing SOURCE_ROOT.`);
    process.exit(1);
  }
  try {
    if (fs.lstatSync(normalized).isSymbolicLink()) {
      console.error(`❌ Refusing to run against symbolic link ${label}: '${normalized}'.`);
      process.exit(1);
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.error(`❌ Unable to inspect ${label}: '${normalized}'.`);
      process.exit(1);
    }
  }
}

import { assertSafeTargetHttpUrl } from './report-cloud.mjs';

function assertSafeHttpUrl(rawUrl) {
  try {
    const validated = assertSafeTargetHttpUrl(rawUrl, { label: 'URL' });
    return validated.replace(/\/$/, '') || rawUrl;
  } catch (err) {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  }
}

function assertSafeSlug(value, flagName) {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(value) || value.includes('..')) {
    console.error(`❌ Invalid ${flagName} '${value}'. Must be a kebab-case identifier ([a-z0-9-]) with no path separators.`);
    process.exit(1);
  }
  return value.toLowerCase();
}

assertSafeTargetDirectory(TARGET_ROOT);
resolvedUrl = assertSafeHttpUrl(resolvedUrl);
if (squadName) {
  squadName = assertSafeSlug(squadName, '--squad');
}

function rel(dest) {
  return path.relative(TARGET_ROOT, dest) || '.';
}

function isUnsafeDest(dest) {
  // Refuse any destination outside TARGET_ROOT or traversing through a symlinked destination/parent
  const resolvedRoot = path.resolve(TARGET_ROOT);
  const resolvedDest = path.resolve(dest);
  const relToRoot = path.relative(resolvedRoot, resolvedDest);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    console.warn(`⚠️  Skipped path escaping target workspace: ${dest}`);
    return true;
  }
  let cur = resolvedDest;
  while (cur !== resolvedRoot) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        console.warn(`⚠️  Skipped symlinked path (refusing to write through symlink): ${rel(cur)}`);
        return true;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') return true;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (fs.existsSync(resolvedRoot)) {
    try {
      const realRoot = fs.realpathSync(resolvedRoot);
      let existing = resolvedDest;
      while (!fs.existsSync(existing) && existing !== resolvedRoot) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        existing = parent;
      }
      const realExisting = fs.realpathSync(existing);
      const realRel = path.relative(realRoot, realExisting);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        console.warn(`⚠️  Skipped path resolving outside workspace realpath: ${rel(resolvedDest)}`);
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const MANIFEST_REL_PATH = '.agents/framework-manifest.json';
const UPGRADE_PATCHES_DIR = path.join(TARGET_ROOT, '.agents/upgrade-patches');
const previousManifest = (() => {
  const manifestPath = path.join(TARGET_ROOT, MANIFEST_REL_PATH);
  if (!fs.existsSync(manifestPath)) return { version: null, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return {
      version: typeof parsed.version === 'string' ? parsed.version : null,
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {},
    };
  } catch {
    return { version: null, files: {} };
  }
})();

const nextManagedFiles = {};
const preservedLocalEdits = [];
let unchangedSyncCount = 0;

function copyRecursive(src, dest, { overwrite = true, trackManifest = false } = {}) {
  if (!fs.existsSync(src)) return;
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) return;
  if (isUnsafeDest(dest)) return;
  if (stat.isDirectory()) {
    if (!dryRun) {
      fs.mkdirSync(dest, { recursive: true });
    }
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry), { overwrite, trackManifest });
    }
  } else {
    const relPath = rel(dest).replace(/\\/g, '/');
    const normalizedDest = dest.replace(/\\/g, '/');
    if (normalizedDest.endsWith('/references/local-overrides.md') && fs.existsSync(dest)) {
      console.log(`🛡️  Preserved local override: ${rel(dest)}`);
      return;
    }

    const srcHash = sha256File(src);
    if (trackManifest) {
      nextManagedFiles[relPath] = srcHash;
    }

    if (!overwrite && fs.existsSync(dest)) {
      console.log(`⏭️  Skipped existing: ${rel(dest)}`);
      return;
    }

    if (overwrite && fs.existsSync(dest)) {
      const destHash = sha256File(dest);
      if (destHash === srcHash) {
        unchangedSyncCount++;
        return;
      }
      const prevHash = previousManifest.files[relPath];
      if (trackManifest && prevHash && destHash !== prevHash && !forceOverwrite) {
        const patchDest = path.join(UPGRADE_PATCHES_DIR, relPath);
        if (!dryRun && !isUnsafeDest(patchDest)) {
          fs.mkdirSync(path.dirname(patchDest), { recursive: true });
          fs.copyFileSync(src, patchDest);
        }
        preservedLocalEdits.push({ relPath, patchRel: rel(patchDest).replace(/\\/g, '/') });
        console.log(
          `${dryRun ? '🔍 [DRY-RUN] Would preserve' : '🛡️  Preserved'} locally edited file: ${relPath} (incoming saved to ${rel(patchDest).replace(/\\/g, '/')})`
        );
        return;
      }
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
  if (isUnsafeDest(dest)) return;
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

/**
 * Explicit allowlist of reference SauceDemo template files so `init --reset`
 * never deletes a consumer application's own `src/components/*.ts` or `src/pages/*.ts` files.
 */
const SAUCEDEMO_DEMO_ARTIFACTS = [
  '.agents/domain/shards/auth.md',
  '.agents/domain/shards/checkout.md',
  '.agents/domain/shards/inventory-cart.md',
  '.exploratory/tapes/saucedemo-e2e-checkout.json',
  '.exploratory/tapes/saucedemo-login-inventory.json',
  'defects/DEFECT-2026-10-25T12-00-00Z-problem-user-broken-images.md',
  'src/components/cart-list.component.ts',
  'src/components/checkout-form.component.ts',
  'src/components/checkout-summary.component.ts',
  'src/components/header-nav.component.ts',
  'src/components/inventory-list.component.ts',
  'src/components/login-form.component.ts',
  'src/pages/checkout.page.ts',
  'src/pages/inventory.page.ts',
  'src/pages/login.page.ts',
  'src/data/checkout.builder.ts',
  'src/data/product.builder.ts',
  'src/data/user.builder.ts',
  'tests/auth-and-inventory.spec.ts',
  'tests/e2e-checkout.spec.ts',
];

function removeSauceDemoArtifacts() {
  for (const relArtifact of SAUCEDEMO_DEMO_ARTIFACTS) {
    const fullPath = path.join(TARGET_ROOT, relArtifact);
    if (isUnsafeDest(fullPath) || !fs.existsSync(fullPath)) continue;
    if (!dryRun) {
      fs.unlinkSync(fullPath);
    }
    console.log(`${dryRun ? '🔍 [DRY-RUN] Would remove' : '🧹 Removed'} demo artifact: ${rel(fullPath)}`);
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
    'src/contracts/flow.contract.ts',
    'src/contracts/state-seeder.contract.ts',
    'src/contracts/wizard-step.contract.ts',
    'src/shared/api/auth-token.bridge.ts',
    'src/shared/data/relative-date.helper.ts',
    'src/shared/ui/explore-handshake.ts',
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
    `import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { holdForExplore } from '@shared/ui/explore-handshake';

/**
 * Segregated Fixture Contract (OCP & ISP).
 * Register Page and Component objects here as 02-solid-architect compiles Session Tapes.
 */
export interface AppFixtures {
  explorePause: void;
}

const activeExploreContexts = new Map<string, { page: Page; context: BrowserContext; held: boolean }>();

export const test = base.extend<AppFixtures>({
  explorePause: [
    async ({ page, context }, use, testInfo) => {
      const state = { page, context, held: false };
      activeExploreContexts.set(testInfo.testId, state);
      try {
        await use();
        if (process.env.PW_PAUSE_FOR_EXPLORE === '1' && !process.env.CI && !state.held) {
          state.held = true;
          await holdForExplore(page, context);
        }
      } finally {
        activeExploreContexts.delete(testInfo.testId);
      }
    },
    { auto: true },
  ],
});

if (!process.env.CI && process.env.PW_PAUSE_FOR_EXPLORE === '1' && process.env.PW_EXPLORE_UNTIL_STEP) {
  const targetStep = process.env.PW_EXPLORE_UNTIL_STEP.toLowerCase();
  const originalStep = test.step.bind(test);
  test.step = (async <T>(title: string, body: () => Promise<T>, options?: { box?: boolean }): Promise<T> => {
    const result = await originalStep(title, body, options);
    if (title.toLowerCase().includes(targetStep)) {
      let active: { page: Page; context: BrowserContext; held: boolean } | undefined;
      try {
        active = activeExploreContexts.get(test.info().testId);
      } catch {
        /* outside test context */
      }
      if (active && !active.held) {
        active.held = true;
        await holdForExplore(active.page, active.context, { pausedAtStep: title });
      }
    }
    return result;
  }) as typeof test.step;
}

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

  fs.mkdirSync(path.dirname(authFile), { recursive: true, mode: 0o700 });
  await page.goto('/');
  // TODO: Replace with your app login steps (or capture via /00-env-bootstrap), then save storageState:
  await page.context().storageState({ path: authFile });
  try {
    fs.chmodSync(authFile, 0o600);
  } catch {
    /* ignore chmod no-op on non-POSIX filesystems */
  }
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
    'test:regression': 'playwright test --project=chromium --pass-with-no-tests',
    'test:api': 'playwright test --project=chromium --grep "@api-contract" --pass-with-no-tests',
    'test:engine': 'node --test scripts/self-test.mjs',
    'test:headed': 'playwright test --headed',
    'test:ui': 'playwright test --ui',
    'test:explore': 'PW_PAUSE_FOR_EXPLORE=1 EXPLORE_CDP_PORT=9222 playwright test --project=chromium --headed --timeout=0',
    explore: 'node scripts/explore-session.mjs',
    report: 'playwright show-report',
    typecheck: 'tsc --noEmit',
    'domain:graph': 'node scripts/build-domain-graph.mjs',
    map: 'node scripts/build-system-map.mjs',
    'compile:tape': 'node scripts/compile-tape.mjs',
    context: 'node scripts/context-pack.mjs',
    tape: 'node scripts/tape-cli.mjs',
    'migrate:skill': 'node scripts/migrate-skill.mjs',
    'migrate:wave': 'node scripts/migration-wave-factory.mjs',
    'coverage:gaps': 'node scripts/analyze-coverage.mjs',
    orchestrate: 'node scripts/orchestrate.mjs',
    'audit:solid': 'node scripts/audit-solid.mjs',
    'validate:tapes': 'node scripts/validate-tapes.mjs',
    'audit:security': 'npm audit --audit-level=high',
    'verify:fast': 'node scripts/verify-fast.mjs --fast',
    verify: 'node scripts/verify-fast.mjs',
    'init:app': 'node scripts/sync-skills.mjs init --reset',
    'sync:skills': 'node scripts/sync-skills.mjs',
    'upgrade:skills': 'node scripts/upgrade-framework.mjs',
  };
  const requiredDevDeps = {
    '@playwright/test': '1.64.1',
    '@types/node': '22.20.5',
    'agent-browser': '0.43.0',
    typescript: '5.9.3',
  };

  const requiredOverrides = {
    playwright: '1.64.1',
    'playwright-core': '1.64.1',
  };

  const requiredBins = {
    cortex: './scripts/sync-skills.mjs',
    asqe: './scripts/sync-skills.mjs',
    'agentic-solid-qe': './scripts/sync-skills.mjs',
  };

  function ensureLocalBinLinks() {
    if (dryRun) return;
    const binDir = path.join(TARGET_ROOT, 'node_modules', '.bin');
    const targetScript = path.join(TARGET_ROOT, 'scripts', 'sync-skills.mjs');
    if (!fs.existsSync(targetScript)) return;
    try {
      fs.chmodSync(targetScript, 0o755);
      if (fs.existsSync(path.join(TARGET_ROOT, 'node_modules'))) {
        fs.mkdirSync(binDir, { recursive: true });
        for (const binName of Object.keys(requiredBins)) {
          const linkPath = path.join(binDir, binName);
          if (!fs.existsSync(linkPath)) {
            fs.symlinkSync(targetScript, linkPath);
          }
        }
      }
    } catch {
      /* non-fatal on read-only or non-POSIX */
    }
  }

  if (!fs.existsSync(pkgPath)) {
    const newPkg = {
      name: path.basename(TARGET_ROOT) || 'my-app-e2e',
      version: '0.1.0',
      private: true,
      type: 'module',
      bin: requiredBins,
      scripts: requiredScripts,
      engines: {
        node: '>=20.12.0',
      },
      devDependencies: requiredDevDeps,
      overrides: requiredOverrides,
    };
    if (isUnsafeDest(pkgPath)) return;
    if (!dryRun) {
      fs.writeFileSync(pkgPath, JSON.stringify(newPkg, null, 2) + '\n', 'utf8');
    }
    ensureLocalBinLinks();
    console.log(`${dryRun ? '🔍 [DRY-RUN] Would create' : '🌱 Created'}: package.json`);
    return;
  }

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.bin = pkg.bin && typeof pkg.bin === 'object' ? pkg.bin : {};
    pkg.scripts = pkg.scripts || {};
    pkg.devDependencies = pkg.devDependencies || {};
    pkg.overrides = pkg.overrides || {};
    const allDeps = { ...(pkg.dependencies || {}), ...pkg.devDependencies };

    let modified = false;
    for (const [bKey, bVal] of Object.entries(requiredBins)) {
      if (!pkg.bin[bKey]) {
        pkg.bin[bKey] = bVal;
        modified = true;
      }
    }
    for (const [k, v] of Object.entries(requiredScripts)) {
      if (
        !pkg.scripts[k] ||
        (k === 'test' && pkg.scripts[k] === 'playwright test --project=chromium') ||
        (k === 'upgrade:skills' &&
          pkg.scripts[k].startsWith('npx --yes github:letstrnsfrm-ai/agentic-solid-qe'))
      ) {
        pkg.scripts[k] = v;
        modified = true;
      }
    }
    if (!pkg.engines || !pkg.engines.node) {
      pkg.engines = { ...(pkg.engines || {}), node: '>=20.12.0' };
      modified = true;
    }
    for (const [dep, ver] of Object.entries(requiredDevDeps)) {
      if (!allDeps[dep] || (dep === 'agent-browser' && pkg.devDependencies[dep] === '^0.43.0')) {
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
      if (isUnsafeDest(pkgPath)) return;
      if (!dryRun) {
        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      }
      console.log(
        `${dryRun ? '🔍 [DRY-RUN] Would merge' : '🔧 Merged'} SOLID QE scripts & devDependencies into: package.json`
      );
    }
    ensureLocalBinLinks();
  } catch {
    console.warn(`⚠️  Could not parse existing package.json; skipping script merge.`);
  }
}

/**
 * Ensures consumer repos have supply-chain protections enabled in .npmrc (ignore-scripts=true, save-exact=true, audit-level=high)
 * without overwriting custom registry configurations.
 */
function mergeConsumerNpmrc() {
  const npmrcPath = path.join(TARGET_ROOT, '.npmrc');
  if (isUnsafeDest(npmrcPath)) return;
  const existing = fs.existsSync(npmrcPath) ? fs.readFileSync(npmrcPath, 'utf8') : '';
  const requiredSettings = [
    { key: 'ignore-scripts', line: 'ignore-scripts=true' },
    { key: 'save-exact', line: 'save-exact=true' },
    { key: 'audit-level', line: 'audit-level=high' },
  ];
  const missingLines = requiredSettings
    .filter(({ key }) => !new RegExp(`^\\s*${key}\\s*=`, 'm').test(existing))
    .map(({ line }) => line);
  if (missingLines.length === 0) return;

  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const header = existing
    ? '\n# Enterprise Supply-Chain Hardening (agentic-solid-qe)\n'
    : '# Enterprise Supply-Chain Hardening (agentic-solid-qe)\n';
  if (!dryRun) {
    fs.writeFileSync(npmrcPath, `${existing}${prefix}${header}${missingLines.join('\n')}\n`, 'utf8');
  }
  console.log(
    `${dryRun ? '🔍 [DRY-RUN] Would update' : existing ? '🔧 Updated' : '🌱 Created'}: .npmrc (+${missingLines.join(', ')})`
  );
}

/**
 * Strips single-line (//), block (/* * /), and trailing commas outside string literals
 * so real-world JSONC tsconfig.json files can be parsed and merged safely.
 */
function stripJsonCommentsAndTrailingCommas(raw) {
  let noComments = '';
  let inString = false;
  let quoteChar = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (inString) {
      noComments += ch;
      if (ch === '\\' && i + 1 < raw.length) {
        noComments += raw[++i];
      } else if (ch === quoteChar) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quoteChar = ch;
      noComments += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      if (i < raw.length) noComments += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++;
      continue;
    }
    noComments += ch;
  }
  let out = '';
  inString = false;
  quoteChar = '';
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < noComments.length) {
        out += noComments[++i];
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
    if (ch === ',') {
      let j = i + 1;
      while (j < noComments.length && /\s/.test(noComments[j])) j++;
      if (noComments[j] === '}' || noComments[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function mergeConsumerTsConfig() {
  const tsconfigPath = path.join(TARGET_ROOT, 'tsconfig.json');
  if (isUnsafeDest(tsconfigPath)) return;
  const requiredPaths = {
    '@contracts/*': ['src/contracts/*'],
    '@components/*': ['src/components/*'],
    '@pages/*': ['src/pages/*'],
    '@flows/*': ['src/flows/*'],
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
    let modified = false;
    if (!parsed.compilerOptions.baseUrl) {
      parsed.compilerOptions.baseUrl = '.';
      modified = true;
    }
    if (parsed.compilerOptions.incremental === undefined) {
      parsed.compilerOptions.incremental = true;
      modified = true;
    }
    if (!parsed.compilerOptions.tsBuildInfoFile) {
      parsed.compilerOptions.tsBuildInfoFile = '.tsbuildinfo';
      modified = true;
    }
    parsed.compilerOptions.paths = parsed.compilerOptions.paths || {};
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
        `${dryRun ? '🔍 [DRY-RUN] Would merge' : '🔧 Merged'} @contracts/@components/@pages/@fixtures/@data/@domains/@shared aliases & incremental cache into: tsconfig.json`
      );
    }
  } catch {
    console.warn(`⚠️  Could not auto-merge tsconfig.json; verify @* path aliases manually.`);
  }
}

function configurePlaywrightConfig() {
  const pwConfigPath = path.join(TARGET_ROOT, 'playwright.config.ts');
  if (isUnsafeDest(pwConfigPath)) return;
  const serializedUrl = JSON.stringify(resolvedUrl);
  if (!fs.existsSync(pwConfigPath)) {
    const templateConfig = fs.readFileSync(path.join(SOURCE_ROOT, 'playwright.config.ts'), 'utf8');
    const customized = templateConfig.replace(
      /baseURL:\s*process\.env\.BASE_URL\s*\|\|\s*['"][^'"]+['"]/,
      () => `baseURL: process.env.BASE_URL || ${serializedUrl}`
    );
    if (!dryRun) {
      fs.writeFileSync(pwConfigPath, customized, 'utf8');
    }
    console.log(`${dryRun ? '🔍 [DRY-RUN] Would create' : '🌱 Created'}: playwright.config.ts (baseURL -> ${resolvedUrl})`);
  } else if (appUrl || resetDemo) {
    const existing = fs.readFileSync(pwConfigPath, 'utf8');
    const updated = existing.replace(
      /baseURL:\s*process\.env\.BASE_URL\s*\|\|\s*['"][^'"]+['"]/,
      () => `baseURL: process.env.BASE_URL || ${serializedUrl}`
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
  '.agent-browser/',
  '.playwright/',
  '.auth/',
  '.exploratory/checkpoints/',
  '.exploratory/live-*',
  '.agents/legacy-backups/',
  '.env',
  '.env.*',
  '!.env.example',
  '*.tsbuildinfo',
];

/**
 * Ensures consumer repos never commit secrets or session tokens (.env, .auth/*.json, .playwright/, .agents/legacy-backups/).
 * Creates .gitignore if missing; otherwise appends only the missing entries (non-destructive).
 */
function mergeConsumerGitignore() {
  const ignorePath = path.join(TARGET_ROOT, '.gitignore');
  if (isUnsafeDest(ignorePath)) return;
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

/**
 * Installs or non-destructively augments a zero-dependency .git/hooks/pre-commit gate
 * so local commits run audit-solid.mjs and validate-tapes.mjs before secrets can enter git history.
 */
function installGitPreCommitHook() {
  const gitDir = path.join(TARGET_ROOT, '.git');
  if (!fs.existsSync(gitDir)) return;
  try {
    const gitStat = fs.lstatSync(gitDir);
    if (gitStat.isSymbolicLink() || !gitStat.isDirectory()) return;
  } catch {
    return;
  }
  const hooksDir = path.join(gitDir, 'hooks');
  const hookPath = path.join(hooksDir, 'pre-commit');
  if (isUnsafeDest(hooksDir) || isUnsafeDest(hookPath)) return;

  const gateSnippet = `# agentic-solid-qe pre-commit secret & SOLID hygiene gate\nif [ -f scripts/audit-solid.mjs ] && [ -f scripts/validate-tapes.mjs ]; then\n  node scripts/audit-solid.mjs && node scripts/validate-tapes.mjs || exit 1\nfi\n`;
  if (!fs.existsSync(hookPath)) {
    const hookContent = `#!/usr/bin/env sh\nset -e\n${gateSnippet}`;
    if (!dryRun) {
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(hookPath, hookContent, { encoding: 'utf8', mode: 0o755 });
      try {
        fs.chmodSync(hookPath, 0o755);
      } catch {
        /* ignore chmod no-op on non-POSIX filesystems */
      }
    }
    console.log(
      `${dryRun ? '🔍 [DRY-RUN] Would install' : '🛡️  Installed'}: .git/hooks/pre-commit (runs audit:solid + validate:tapes)`
    );
    return;
  }

  const existingHook = fs.readFileSync(hookPath, 'utf8');
  if (existingHook.includes('scripts/audit-solid.mjs')) return;
  const firstLine = existingHook.split('\n', 1)[0];
  const isShell = /^#!.*\b(sh|bash|dash|zsh)\b/.test(firstLine);
  const hasEarlyExit = /^\s*exec\s|^\s*exit\s+\d*\s*$/m.test(existingHook);
  if (!isShell || hasEarlyExit) {
    console.warn(
      '⚠️  Existing .git/hooks/pre-commit is not a plain shell hook (or exits early); not modifying it. Add `node scripts/audit-solid.mjs && node scripts/validate-tapes.mjs` manually.'
    );
    return;
  }
  const prefix = existingHook && !existingHook.endsWith('\n') ? '\n' : '';
  if (!dryRun) {
    fs.writeFileSync(hookPath, `${existingHook}${prefix}\n${gateSnippet}`, {
      encoding: 'utf8',
      mode: 0o755,
    });
    try {
      fs.chmodSync(hookPath, 0o755);
    } catch {
      /* ignore chmod no-op on non-POSIX filesystems */
    }
  }
  console.log(
    `${dryRun ? '🔍 [DRY-RUN] Would update' : '🛡️  Updated'}: .git/hooks/pre-commit (+audit:solid & validate:tapes gate)`
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
    if (isUnsafeDest(backupDest)) continue;
    if (!fs.existsSync(backupDest)) {
      if (!dryRun) {
        fs.mkdirSync(path.dirname(backupDest), { recursive: true, mode: 0o700 });
        fs.copyFileSync(existingPath, backupDest);
        try {
          fs.chmodSync(backupDest, 0o600);
        } catch {
          /* ignore chmod no-op on non-POSIX filesystems */
        }
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
  'CHANGELOG.json',
  'scripts/lib/cli-output.mjs',
  'scripts/lib/autonomous-mode.mjs',
  'scripts/context-pack.mjs',
  'scripts/impact-graph.mjs',
  'scripts/tape-cli.mjs',
  'scripts/build-domain-graph.mjs',
  'scripts/build-system-map.mjs',
  'scripts/compile-tape.mjs',
  'scripts/explore-session.mjs',
  'scripts/export-auth-state.mjs',
  'scripts/heal-drift.mjs',
  'scripts/migrate-skill.mjs',
  'scripts/legacy-test-migrator.mjs',
  'scripts/dotnet-enterprise-analyzer.mjs',
  'scripts/migration-wave-factory.mjs',
  'scripts/orchestrate.mjs',
  'scripts/verify-fast.mjs',
  'scripts/analyze-coverage.mjs',
  'scripts/audit-solid.mjs',
  'scripts/validate-tapes.mjs',
  'scripts/sync-skills.mjs',
  'scripts/upgrade-framework.mjs',
  'scripts/report-cloud.mjs',
  'scripts/self-test.mjs',
];

console.log(
  `\n🚀 Running agentic-solid-qe (${command}${resetDemo ? ' --reset' : ''}${includeDemo ? ' --demo' : ''}${dryRun ? ' --dry-run' : ''}${forceOverwrite ? ' --force' : ''}) -> ${TARGET_ROOT}\n`
);

backupPreExistingInstructionFiles();

for (const relPath of coreEnginePaths) {
  copyRecursive(path.join(SOURCE_ROOT, relPath), path.join(TARGET_ROOT, relPath), {
    overwrite: true,
    trackManifest: true,
  });
}

if (unchangedSyncCount > 0) {
  console.log(`⚡ Skipped ${unchangedSyncCount} unchanged framework file(s).`);
}

// Prune stale framework-managed files that were removed or renamed in newer releases (only if unmodified)
const ALLOWED_PRUNE_PREFIXES = [
  '.agents/skills/',
  '.github/prompts/',
  '.claude/commands/',
  'scripts/',
  '.agents/domain/session-tape.schema.json',
];
const prunedFiles = [];
for (const [oldRel, oldHash] of Object.entries(previousManifest.files)) {
  const normRel = String(oldRel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (Object.hasOwn(nextManagedFiles, normRel)) continue;
  if (
    !normRel ||
    path.isAbsolute(normRel) ||
    normRel.includes('..') ||
    !ALLOWED_PRUNE_PREFIXES.some((prefix) => normRel === prefix || normRel.startsWith(prefix))
  ) {
    console.warn(`⚠️  Skipped pruning unsafe/unmanaged manifest path: ${oldRel}`);
    continue;
  }
  const oldDest = path.resolve(TARGET_ROOT, normRel);
  if (isUnsafeDest(oldDest)) continue;
  if (!fs.existsSync(oldDest)) continue;
  const stat = fs.lstatSync(oldDest);
  if (stat.isSymbolicLink() || !stat.isFile()) continue;
  const currentHash = sha256File(oldDest);
  if (currentHash === oldHash || forceOverwrite) {
    if (!dryRun) {
      fs.unlinkSync(oldDest);
    }
    prunedFiles.push(normRel);
    console.log(`${dryRun ? '🔍 [DRY-RUN] Would prune' : '🧹 Pruned'} stale framework file: ${normRel}`);
  } else {
    console.log(`⚠️  Skipped pruning locally modified stale file: ${normRel}`);
  }
}

if (!dryRun && !isUnsafeDest(path.join(TARGET_ROOT, MANIFEST_REL_PATH))) {
  const manifestDest = path.join(TARGET_ROOT, MANIFEST_REL_PATH);
  fs.mkdirSync(path.dirname(manifestDest), { recursive: true });
  fs.writeFileSync(
    manifestDest,
    JSON.stringify(
      {
        schemaVersion: '1.0.0',
        version: SOURCE_VERSION,
        syncedAt: new Date().toISOString(),
        files: nextManagedFiles,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
}

const targetDomainMemory = path.join(TARGET_ROOT, '.agents/domain/domain-memory.md');
const targetShardsDir = path.join(TARGET_ROOT, '.agents/domain/shards');

if (command === 'init') {
  if (resetDemo) {
    // Wipe only known SauceDemo reference artifacts so consumer source files are never deleted
    removeSauceDemoArtifacts();

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
      if (!isUnsafeDest(targetDomainMemory)) {
        let existingMem = fs.readFileSync(targetDomainMemory, 'utf8');
        if (appName) {
          existingMem = existingMem.replace(
            /- \*\*Application Name:\*\* .+/,
            () => `- **Application Name:** ${resolvedAppName}`
          );
        }
        if (appUrl) {
          existingMem = existingMem.replace(
            /- \*\*Base URL:\*\* `.+`/,
            () => `- **Base URL:** \`${resolvedUrl}\``
          );
        }
        if (!dryRun) {
          fs.writeFileSync(targetDomainMemory, existingMem, 'utf8');
        }
        console.log(`${dryRun ? '🔍 [DRY-RUN] Would update' : '🔧 Updated'} Application Name / Base URL in .agents/domain/domain-memory.md`);
      }
    } else {
      console.log(`🛡️  Preserved existing: .agents/domain/domain-memory.md`);
    }
    scaffoldCleanSolidSkeleton({ overwrite: false });
  }

  mergeConsumerPackageJson();
  mergeConsumerNpmrc();
  mergeConsumerTsConfig();
  configurePlaywrightConfig();
  mergeConsumerGitignore();
  installGitPreCommitHook();
  copyRecursive(
    path.join(SOURCE_ROOT, '.github/workflows/playwright-ci.yml'),
    path.join(TARGET_ROOT, '.github/workflows/playwright-ci.yml'),
    { overwrite: false }
  );
  if (legacyProjectCheck.detected && !dryRun) {
    const legacyScan = discoverLegacyTests(rawTargetRoot);
    const relLegacyRoot = path.relative(TARGET_ROOT, rawTargetRoot).replace(/\\/g, '/') || '..';
    syncDiscoveryToManifest(TARGET_ROOT, legacyScan, relLegacyRoot);
    console.log(
      `📋 Seeded .agents/domain/migration-manifest.json (${legacyScan.summary.totalTests} legacy test(s): Wave 1=${legacyScan.summary.wave1Count}, Wave 2=${legacyScan.summary.wave2Count}, Wave 3=${legacyScan.summary.wave3Count}).`
    );
  }
} else {
  // sync mode: preserve consumer domain-memory.md and existing src/, while seeding new foundational contracts/shared helpers if missing
  if (!fs.existsSync(targetDomainMemory)) {
    writeFileSafe(targetDomainMemory, buildCleanDomainMemory(resolvedAppName, resolvedUrl), {
      overwrite: false,
    });
  } else {
    console.log(`🛡️  Preserved existing: .agents/domain/domain-memory.md`);
    if (!dryRun && !isUnsafeDest(targetShardsDir)) {
      fs.mkdirSync(targetShardsDir, { recursive: true });
    }

    if (!isUnsafeDest(targetDomainMemory)) {
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
  }

  for (const foundationalPath of [
    'src/contracts/identifiable-component.contract.ts',
    'src/contracts/error-banner.contract.ts',
    'src/contracts/api-client.contract.ts',
    'src/contracts/flow.contract.ts',
    'src/contracts/state-seeder.contract.ts',
    'src/contracts/catalog-list.contract.ts',
    'src/contracts/wizard-step.contract.ts',
    'src/shared/api/auth-token.bridge.ts',
    'src/shared/data/relative-date.helper.ts',
    'src/shared/ui/explore-handshake.ts',
    'src/shared/ui/overlay-handler.ts',
  ]) {
    copyRecursive(path.join(SOURCE_ROOT, foundationalPath), path.join(TARGET_ROOT, foundationalPath), {
      overwrite: false,
    });
  }

  mergeConsumerPackageJson();
  mergeConsumerNpmrc();
  mergeConsumerTsConfig();
  mergeConsumerGitignore();
  installGitPreCommitHook();
}

// Optional: Federated Org Brain sync (--org-brain <path>)
if (orgBrainSource) {
  const resolvedBrainRoot = path.resolve(process.cwd(), orgBrainSource);
  assertSafeTargetDirectory(resolvedBrainRoot, '--org-brain source directory');
  if (fs.existsSync(resolvedBrainRoot) && !fs.lstatSync(resolvedBrainRoot).isSymbolicLink()) {
    for (const sharedRel of [
      '.agents/domain/domain-memory.md',
      '.agents/domain/domain-graph.json',
      'src/contracts',
      'src/shared',
    ]) {
      const srcPath = path.join(resolvedBrainRoot, sharedRel);
      if (fs.existsSync(srcPath) && !fs.lstatSync(srcPath).isSymbolicLink()) {
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

  if (!isUnsafeDest(targetDomainMemory) && fs.existsSync(targetDomainMemory)) {
    const mem = fs.readFileSync(targetDomainMemory, 'utf8');
    const relHub = `.agents/domain/domains/${cleanSquad}/index.md`;
    if (!mem.includes(relHub)) {
      const row = `| **${cleanSquad} Domain** | \`@org/${cleanSquad}-squad\` | \`/${cleanSquad}\` | \`${relHub}\` | Tier 1 Squad Sub-Hub |`;
      if (!dryRun) {
        const tableMarker = '| :--- | :--- | :--- | :--- | :--- |';
        if (mem.includes(tableMarker)) {
          const updated = mem.replace(tableMarker, () => `${tableMarker}\n${row}`);
          fs.writeFileSync(targetDomainMemory, updated, 'utf8');
        } else {
          fs.appendFileSync(targetDomainMemory, (mem.endsWith('\n') ? '' : '\n') + row + '\n', 'utf8');
        }
      }
      console.log(
        `${dryRun ? '🔍 [DRY-RUN] Would register' : '🧭 Registered'} Tier 1 Squad Sub-Hub in .agents/domain/domain-memory.md: ${relHub}`
      );
    }
  }
}

function detectCustomizableConfigDrift() {
  if (path.resolve(SOURCE_ROOT) === path.resolve(TARGET_ROOT)) return [];
  const candidates = [
    {
      relPath: 'playwright.config.ts',
      patchName: 'playwright.config.ts.new',
      checks: [
        { marker: "['blob']", label: 'Sharded CI blob reporter support' },
      ],
    },
    {
      relPath: '.github/workflows/playwright-ci.yml',
      patchName: 'playwright-ci.yml.new',
      checks: [
        { marker: 'merge-reports', label: 'Sharded blob merge-reports job' },
        { marker: '--only-changed', label: 'PR --only-changed fast smoke gate' },
      ],
    },
  ];

  const detected = [];
  for (const item of candidates) {
    const targetFile = path.join(TARGET_ROOT, item.relPath);
    const sourceFile = path.join(SOURCE_ROOT, item.relPath);
    const patchFile = path.join(UPGRADE_PATCHES_DIR, item.patchName);
    if (!fs.existsSync(targetFile) || !fs.existsSync(sourceFile)) continue;
    if (fs.lstatSync(targetFile).isSymbolicLink()) continue;

    const targetContent = fs.readFileSync(targetFile, 'utf8');
    const missingFeatures = item.checks
      .filter((c) => !targetContent.includes(c.marker))
      .map((c) => c.label);

    if (missingFeatures.length > 0) {
      if (!dryRun && !isUnsafeDest(patchFile)) {
        fs.mkdirSync(path.dirname(patchFile), { recursive: true });
        fs.copyFileSync(sourceFile, patchFile);
      }
      detected.push({
        relPath: item.relPath,
        patchRel: rel(patchFile).replace(/\\/g, '/'),
        missingFeatures,
      });
    } else if (fs.existsSync(patchFile) && !dryRun) {
      fs.unlinkSync(patchFile);
    }
  }
  return detected;
}

function printUpgradeSummary(configDrift) {
  const prevVer = previousManifest.version;
  const changelogPath = path.join(SOURCE_ROOT, 'CHANGELOG.json');
  if (fs.existsSync(changelogPath)) {
    try {
      const changelog = JSON.parse(fs.readFileSync(changelogPath, 'utf8'));
      const releases = Array.isArray(changelog.releases) ? changelog.releases : [];
      const relevant = prevVer
        ? releases.filter((r) => r.version !== prevVer)
        : releases.slice(0, 1);

      if (relevant.length > 0 && prevVer !== SOURCE_VERSION) {
        console.log(
          `\n📣 What's New (${prevVer ? `${prevVer} -> ${SOURCE_VERSION}` : `v${SOURCE_VERSION}`}):`
        );
        for (const relInfo of relevant.slice(0, 2)) {
          console.log(`   • v${relInfo.version} (${relInfo.date || ''})`);
          for (const h of (relInfo.highlights || []).slice(0, 4)) {
            console.log(`     - ${h}`);
          }
        }
        const actions = relevant[0]?.nextActions || [];
        if (actions.length > 0) {
          console.log(`\n🧭 Recommended Next Actions:`);
          for (const act of actions) {
            console.log(`   → ${act}`);
          }
        }
      }
    } catch {
      /* ignore malformed changelog */
    }
  }

  if (preservedLocalEdits.length > 0) {
    console.log(`\n🛡️  Locally Edited Framework Files Preserved (${preservedLocalEdits.length}):`);
    for (const item of preservedLocalEdits) {
      console.log(`   • ${item.relPath} (incoming template saved at ${item.patchRel})`);
    }
    console.log(`   Tip: Review diffs or re-run with '--force' to overwrite.`);
  }

  if (configDrift.length > 0) {
    console.log(`\n🧩 Optional Config & CI Upgrades Available (.agents/upgrade-patches/):`);
    for (const d of configDrift) {
      console.log(`   • ${d.relPath} -> ${d.patchRel}`);
      console.log(`     Missing capabilities: ${d.missingFeatures.join('; ')}`);
    }
  }
}

const configDrift = command === 'sync' ? detectCustomizableConfigDrift() : [];
printUpgradeSummary(configDrift);

console.log(
  `\n✅ Agentic-SOLID-QE (${command}${dryRun ? ' --dry-run' : ''}) complete! Next steps: run 'npm install && npx playwright install chromium', then invoke '/agentic-solid-qe' (or 'npx cortex orchestrate').\n`
);
