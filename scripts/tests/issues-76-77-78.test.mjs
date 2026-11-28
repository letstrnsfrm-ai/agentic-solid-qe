#!/usr/bin/env node
/**
 * Regression test suite for Issues #76, #77, and #78:
 *   - #76: self-test.mjs guards framework-only auth-vault.mjs & runner-daemon.mjs in adopter repos
 *   - #77: sync-skills.mjs tracks framework-owned src/shared/* helpers and upgrades unmodified legacy copies
 *   - #78: compile-tape.mjs extends app.fixture.ts with interface extends & nested generic .extend<...>({
 */
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileSessionTape } from '../compile-tape.mjs';
import {
  extendFixtureContent,
  insertIntoFixtureExtend,
  insertIntoFixtureInterface,
} from '../lib/fixture-patcher.mjs';
import { isKnownUnmodifiedLegacyFile } from '../lib/sync-legacy-hashes.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts/sync-skills.mjs');

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runNode(scriptPath, args = [], cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('#76: adopter self-test.mjs skips framework-only Phase 2 auth-vault/runner-daemon test cleanly', () => {
  const tmpDir = makeTmpDir('asqe-issue76-');
  try {
    const initRes = runNode(SYNC_SCRIPT, ['init', tmpDir, '--url', 'https://app.example.com']);
    assert.equal(initRes.status, 0, `init failed: ${initRes.stderr}\n${initRes.stdout}`);

    assert.equal(fs.existsSync(path.join(tmpDir, 'scripts/auth-vault.mjs')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'scripts/runner-daemon.mjs')), false);

    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const testRes = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', '--test-name-pattern=QE Software Factory Phase 2', 'scripts/self-test.mjs'],
      { cwd: tmpDir, encoding: 'utf8', env: childEnv }
    );
    assert.equal(
      testRes.status,
      0,
      `Expected adopter self-test Phase 2 to skip cleanly, got exit ${testRes.status}:\n${testRes.stdout}\n${testRes.stderr}`
    );
    assert.match(testRes.stdout, /# skipped 1/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('#77: sync upgrades unmodified pre-v0.48.18 auth-token.bridge.ts in place and preserves local edits as patches', () => {
  const tmpDir = makeTmpDir('asqe-issue77-');
  try {
    // Seed an adopter workspace first
    const initRes = runNode(SYNC_SCRIPT, ['init', tmpDir, '--url', 'https://app.example.com']);
    assert.equal(initRes.status, 0, `init failed: ${initRes.stderr}\n${initRes.stdout}`);

    const bridgeRel = 'src/shared/api/auth-token.bridge.ts';
    const bridgePath = path.join(tmpDir, bridgeRel);
    const manifestPath = path.join(tmpDir, '.agents/framework-manifest.json');
    const latestBridge = fs.readFileSync(path.join(REPO_ROOT, bridgeRel), 'utf8');

    // Verify src/shared/api/auth-token.bridge.ts is now tracked in framework-manifest.json
    const initManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(initManifest.files[bridgeRel], 'Expected auth-token.bridge.ts to be tracked in manifest');

    // Case 1: Simulate adopter upgrading from v0.48.17 (no manifest entry, unmodified legacy file with CRLF)
    const legacyBridge = execSync('git show 84cc2e7:src/shared/api/auth-token.bridge.ts', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    fs.writeFileSync(bridgePath, legacyBridge.replace(/\n/g, '\r\n'), 'utf8');
    assert.equal(
      isKnownUnmodifiedLegacyFile(bridgeRel, bridgePath, 'not-raw-match'),
      true,
      'CRLF legacy auth-token.bridge.ts should be recognized as unmodified'
    );
    delete initManifest.files[bridgeRel];
    fs.writeFileSync(manifestPath, JSON.stringify(initManifest, null, 2), 'utf8');

    const syncRes1 = runNode(SYNC_SCRIPT, ['sync', tmpDir]);
    assert.equal(syncRes1.status, 0, `sync failed: ${syncRes1.stderr}\n${syncRes1.stdout}`);
    assert.equal(
      fs.readFileSync(bridgePath, 'utf8'),
      latestBridge,
      'Unmodified legacy auth-token.bridge.ts must be upgraded in place with v0.48.18+ security fixes'
    );
    assert.equal(
      fs.existsSync(path.join(tmpDir, '.agents/upgrade-patches', bridgeRel)),
      false,
      'Unmodified legacy upgrade should not leave an unnecessary upgrade patch'
    );

    // Case 2: Locally customized auth-token.bridge.ts must be preserved and emit an upgrade patch
    const customBridge = `${latestBridge}\n// custom adopter override\n`;
    fs.writeFileSync(bridgePath, customBridge, 'utf8');
    const syncRes2 = runNode(SYNC_SCRIPT, ['sync', tmpDir]);
    assert.equal(syncRes2.status, 0, `sync failed: ${syncRes2.stderr}\n${syncRes2.stdout}`);
    assert.equal(
      fs.readFileSync(bridgePath, 'utf8'),
      customBridge,
      'Locally edited auth-token.bridge.ts must be preserved'
    );
    const patchPath = path.join(tmpDir, '.agents/upgrade-patches', bridgeRel);
    assert.equal(fs.existsSync(patchPath), true, 'Expected incoming security update to be saved as upgrade patch');
    assert.equal(fs.readFileSync(patchPath, 'utf8'), latestBridge);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('#78: fixture-patcher handles interface extends, nested generics, non-generic extend, and fails loudly on mismatch', () => {
  const mergeTestsFixture = `import { test as base, mergeTests } from '@playwright/test';
import { backendTest, type BackendFixtures } from './backend.fixture';

export interface AppFixtures extends BackendFixtures {
  existingPage: ExistingPage;
}

const uiTest = base.extend<Omit<AppFixtures, keyof BackendFixtures>>({
  existingPage: async ({ page }, use) => {
    await use(new ExistingPage(page));
  },
});

export const test = mergeTests(backendTest, uiTest);
export { expect } from '@playwright/test';
`;

  const patched = extendFixtureContent(mergeTestsFixture, {
    importLines: `import { BillingPage } from '@pages/billing.page';`,
    interfaceLines: `  billingPage: BillingPage;`,
    implLines: `  billingPage: async ({ page }, use) => {\n    await use(new BillingPage(page));\n  },`,
    fixtureRelPath: 'src/fixtures/app.fixture.ts',
  });

  assert.match(patched, /import \{ BillingPage \} from '@pages\/billing\.page';/);
  assert.match(patched, /export interface AppFixtures extends BackendFixtures \{\n  billingPage: BillingPage;/);
  assert.match(
    patched,
    /base\.extend<Omit<AppFixtures, keyof BackendFixtures>>\(\{\n  billingPage: async \(\{ page \}, use\) => \{/
  );

  // Deeply nested multiline generics + multiple extends
  const complexFixture = `export interface AppFixtures
  extends AuthFixtures, Omit<BackendFixtures, 'legacy'> {
}
const ui = base.extend<
  Pick<Omit<AppFixtures, keyof BackendFixtures>, 'x'>
>({
});
`;
  const patchedComplex = extendFixtureContent(complexFixture, {
    interfaceLines: `  ordersPage: OrdersPage;`,
    implLines: `  ordersPage: async ({ page }, use) => { await use(new OrdersPage(page)); },`,
  });
  assert.match(patchedComplex, /ordersPage: OrdersPage;/);
  assert.match(patchedComplex, /ordersPage: async/);

  // Non-generic .extend({ fallback
  const plainExtend = insertIntoFixtureExtend(`export const test = base.extend({\n});`, `  foo: 1,`);
  assert.equal(plainExtend.matched, true);
  assert.match(plainExtend.content, /base\.extend\(\{\n  foo: 1,/);

  // Inline-generic fixture without export interface (e.g. base.extend<Record<string, unknown>>({}))
  const inlineGeneric = extendFixtureContent(`export const test = base.extend<Record<string, unknown>>({\n});`, {
    importLines: `import { FooPage } from '@pages/foo.page';`,
    interfaceLines: `  fooPage: FooPage;`,
    implLines: `  fooPage: async ({ page }, use) => { await use(new FooPage(page)); },`,
  });
  assert.match(inlineGeneric, /base\.extend<Record<string, unknown>>\(\{\n  fooPage: async/);

  // Fail loudly if .extend is missing (never silently drop or leave dangling import)
  assert.equal(insertIntoFixtureInterface(`const x = 1;`, `  a: A;`).matched, false);
  assert.throws(
    () =>
      extendFixtureContent(`const x = 1;`, {
        importLines: `import { A } from './a';`,
        interfaceLines: `  a: A;`,
        implLines: `  a: async ({}, use) => { await use(1); },`,
      }),
    /Failed to extend fixture/
  );
  assert.throws(
    () =>
      extendFixtureContent(`export interface AppFixtures {\n}\nexport const test = somethingElse;\n`, {
        importLines: `import { A } from './a';`,
        interfaceLines: `  a: A;`,
        implLines: `  a: async ({}, use) => { await use(1); },`,
      }),
    /Failed to extend fixture/
  );
});

test('#78: compileSessionTape extends mergeTests app.fixture.ts end-to-end without dropping interface or provider', () => {
  const tmpDir = makeTmpDir('asqe-issue78-');
  try {
    fs.mkdirSync(path.join(tmpDir, '.agents/domain/shards'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.exploratory/tapes'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/fixtures'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/pages'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/components'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });

    fs.copyFileSync(
      path.join(REPO_ROOT, '.agents/domain/session-tape.schema.json'),
      path.join(tmpDir, '.agents/domain/session-tape.schema.json')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.agents/domain/domain-memory.md'),
      '# Domain Memory\n- **Base URL:** `https://app.example.com`\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'src/fixtures/app.fixture.ts'),
      `import { test as base, mergeTests } from '@playwright/test';
import { backendTest, type BackendFixtures } from './backend.fixture';

export interface AppFixtures extends BackendFixtures {
}

const uiTest = base.extend<Omit<AppFixtures, keyof BackendFixtures>>({
});

export const test = mergeTests(backendTest, uiTest);
export { expect } from '@playwright/test';
`,
      'utf8'
    );

    const tapePath = path.join(tmpDir, '.exploratory/tapes/billing-view.json');
    fs.writeFileSync(
      tapePath,
      JSON.stringify(
        {
          schemaVersion: '1.0.0',
          scenarioId: 'billing-view',
          title: 'View billing summary',
          charter: 'happy-path-baseline',
          tags: ['@p0', '@smoke'],
          recordedAt: '2026-11-28T00:00:00Z',
          baseUrl: 'https://app.example.com',
          persona: {
            role: 'standard',
            dataBuilderRef: 'UserBuilder.standardUser',
          },
          preconditions: ['User is authenticated'],
          networkContracts: [],
          semanticSteps: [
            {
              stepIndex: 1,
              intent: 'Navigate to billing page',
              action: 'goto',
              componentCandidate: 'BillingPage',
              locatorContract: { strategy: 'url', value: '/billing' },
            },
            {
              stepIndex: 2,
              intent: 'Click download invoice button',
              action: 'click',
              componentCandidate: 'BillingSummaryComponent',
              locatorContract: { strategy: 'getByTestId', value: 'download-invoice-btn' },
            },
          ],
          expectedStates: [
            {
              assertionType: 'toBeVisible',
              targetComponent: 'BillingSummaryComponent',
              targetProperty: 'downloadInvoiceBtn',
              expectedValueRef: 'visible',
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const report = compileSessionTape({ tapeInput: tapePath, rootDir: tmpDir, apply: true });
    const fixtureOp = report.operations.find((op) => op.layer === 'fixture');
    assert.ok(fixtureOp, 'Expected fixture operation');
    assert.equal(fixtureOp.action, 'extend-existing');

    const updatedFixture = fs.readFileSync(path.join(tmpDir, 'src/fixtures/app.fixture.ts'), 'utf8');
    for (const member of fixtureOp.addedMembers) {
      assert.match(
        updatedFixture,
        new RegExp(`export interface AppFixtures extends BackendFixtures \\{[\\s\\S]*?${member}:`),
        `Expected interface property '${member}' to be inserted`
      );
      assert.match(
        updatedFixture,
        new RegExp(`base\\.extend<Omit<AppFixtures, keyof BackendFixtures>>\\(\\{[\\s\\S]*?${member}:\\s*async`),
        `Expected provider implementation '${member}' to be inserted`
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
