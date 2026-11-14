#!/usr/bin/env node
/**
 * Zero-dependency Engine & Backward-Compatibility Self-Test Suite (node --test).
 * Verifies:
 *   1. --dry-run preview safety (zero disk mutations)
 *   2. Non-destructive upgrade (sync) of a legacy v0.2.0 consumer repo with JSONC tsconfig comments
 *   3. Multi-portal, conditional wizard & backend API Session Tape validation + --seed-from-tapes auto-indexing + audit-solid roundtrip
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts/sync-skills.mjs');

function runNode(scriptPath, args = [], cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('1. sync --dry-run previews changes without mutating the target directory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asqe-dryrun-'));
  try {
    const res = runNode(SYNC_SCRIPT, ['init', tmpDir, '--url', 'https://quote.example.com', '--dry-run']);
    assert.equal(res.status, 0, `Expected exit 0, got: ${res.stderr}\n${res.stdout}`);
    assert.match(res.stdout, /\[DRY-RUN\]/);
    const entries = fs.readdirSync(tmpDir);
    assert.deepEqual(entries, [], 'Expected target directory to remain completely empty after --dry-run');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('2. sync upgrades a legacy v0.2.0 consumer repo non-destructively (JSONC tsconfig, legacy backup, contracts seeded)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asqe-legacy-consumer-'));
  try {
    // Seed a simulated pre-existing consumer repository
    fs.mkdirSync(path.join(tmpDir, '.agents/domain/shards'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.exploratory/tapes'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/components'), { recursive: true });

    const customAgentsMd = '# Custom Team Instructions\nAlways use our internal conventions.\n';
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), customAgentsMd, 'utf8');

    const customDomainMemory = `# Domain Memory Index (Global Context & Shard Router)

## 1. Global Environment & Target Application

- **Application Name:** Legacy Motor Portal
- **Base URL:** \`https://motor.example.com\`

## 3. Federated Domain & Feature Shard Index (Progressive Disclosure)

| Bounded Context / Feature | Owner Squad | Routes | Shard / Sub-Hub Path | Published Capabilities & Summary |
| :--- | :--- | :--- | :--- | :--- |
`;
    fs.writeFileSync(path.join(tmpDir, '.agents/domain/domain-memory.md'), customDomainMemory, 'utf8');

    const customComponent = `import type { Locator, Page } from '@playwright/test';
import type { IdentifiableComponent } from '@contracts/identifiable-component.contract';

export class CustomQuoteWidgetComponent implements IdentifiableComponent {
  readonly root: Locator;
  constructor(page: Page) {
    this.root = page.getByTestId('quote-widget');
  }
}
`;
    fs.writeFileSync(
      path.join(tmpDir, 'src/components/custom-quote-widget.component.ts'),
      customComponent,
      'utf8'
    );

    // JSONC tsconfig with single-line comments, block comments, and trailing commas
    const jsoncTsconfig = `{
  // Consumer TypeScript Configuration
  "compilerOptions": {
    "target": "ES2022",
    "baseUrl": ".",
    /* Legacy v0.1 paths without @domains or @shared */
    "paths": {
      "@contracts/*": ["src/contracts/*"],
      "@components/*": ["src/components/*"],
    },
  },
}
`;
    fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), jsoncTsconfig, 'utf8');

    const legacyPackageJson = {
      name: 'legacy-consumer-e2e',
      version: '1.0.0',
      private: true,
      type: 'module',
      scripts: {
        'custom:lint': 'echo custom-lint',
        'upgrade:skills': 'npx --yes github:letstrnsfrm-ai/agentic-solid-qe#v0.2.0 sync',
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify(legacyPackageJson, null, 2), 'utf8');

    // Legacy v1.0.0 Session Tape (without any new optional multi-portal or API fields)
    const legacyTape = {
      schemaVersion: '1.0.0',
      scenarioId: 'legacy-login-smoke',
      title: 'Legacy Login Smoke Flow',
      charter: 'happy-path-baseline',
      recordedAt: '2026-10-01T00:00:00.000Z',
      baseUrl: 'https://motor.example.com',
      persona: {
        role: 'standard',
        dataBuilderRef: 'UserBuilder.standardUser',
      },
      preconditions: ['Application is reachable'],
      semanticSteps: [
        {
          stepIndex: 1,
          intent: 'Open landing page',
          action: 'goto',
          componentCandidate: 'CustomQuoteWidgetComponent',
          locatorContract: {
            strategy: 'url',
            value: '/login',
          },
        },
      ],
      networkContracts: [],
      expectedStates: [
        {
          description: 'Widget is visible',
          assertionType: 'toBeVisible',
          targetComponent: 'quotePage.widget',
          targetProperty: 'root',
          expectedValueRef: 'UserBuilder.standardUser',
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, '.exploratory/tapes/legacy-login-smoke.json'),
      JSON.stringify(legacyTape, null, 2),
      'utf8'
    );

    // Run sync on the legacy consumer repository
    const syncRes = runNode(SYNC_SCRIPT, ['sync', tmpDir]);
    assert.equal(syncRes.status, 0, `sync failed: ${syncRes.stderr}\n${syncRes.stdout}`);

    // Verify custom AGENTS.md was backed up before upgrading
    assert.equal(
      fs.readFileSync(path.join(tmpDir, '.agents/legacy-backups/AGENTS.legacy.md'), 'utf8'),
      customAgentsMd
    );

    // Verify existing consumer domain-memory.md and custom component were 100% preserved
    assert.match(
      fs.readFileSync(path.join(tmpDir, '.agents/domain/domain-memory.md'), 'utf8'),
      /Legacy Motor Portal/
    );
    assert.equal(
      fs.readFileSync(path.join(tmpDir, 'src/components/custom-quote-widget.component.ts'), 'utf8'),
      customComponent
    );

    // Verify new foundational contracts & shared utilities were seeded
    for (const seededRel of [
      'src/contracts/api-client.contract.ts',
      'src/contracts/wizard-step.contract.ts',
      'src/shared/api/auth-token.bridge.ts',
      'src/shared/data/relative-date.helper.ts',
      '.agents/skills/02-solid-architect/references/complex-orchestration-guide.md',
    ]) {
      assert.equal(fs.existsSync(path.join(tmpDir, seededRel)), true, `Missing seeded file: ${seededRel}`);
    }

    // Verify JSONC tsconfig.json was parsed and merged with @domains/* and @shared/*
    const mergedTsConfig = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tsconfig.json'), 'utf8'));
    assert.deepEqual(mergedTsConfig.compilerOptions.paths['@domains/*'], ['src/domains/*']);
    assert.deepEqual(mergedTsConfig.compilerOptions.paths['@shared/*'], ['src/shared/*']);

    // Verify package.json preserved custom script and unpinned upgrade:skills
    const mergedPkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8'));
    assert.equal(mergedPkg.scripts['custom:lint'], 'echo custom-lint');
    assert.equal(mergedPkg.scripts['upgrade:skills'], 'npx --yes github:letstrnsfrm-ai/agentic-solid-qe sync');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('3. Multi-portal + Backend API + Conditional Wizard tape validates, auto-indexes shard, and passes audit:solid', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asqe-multiportal-'));
  try {
    // Initialize clean repo and scaffold motor-b2c squad
    const initRes = runNode(SYNC_SCRIPT, [
      'init',
      tmpDir,
      '--url',
      'https://quote.insurer.example.com',
      '--name',
      'Enterprise Insurance Suite',
    ]);
    assert.equal(initRes.status, 0, initRes.stderr);

    const squadRes = runNode(SYNC_SCRIPT, ['sync', tmpDir, '--squad', 'motor-b2c']);
    assert.equal(squadRes.status, 0, squadRes.stderr);

    // Export motor-b2cFixture so Published Capabilities in motor-b2c/index.md pass capability check
    fs.writeFileSync(
      path.join(tmpDir, 'src/domains/motor-b2c/fixtures/motor.fixture.ts'),
      `export const motorB2cFixture = {};\n`,
      'utf8'
    );

    // Emit a complex cross-portal + API seeder + conditional wizard Session Tape
    const complexTape = {
      schemaVersion: '1.0.0',
      scenarioId: 'motor-b2c-referral-handoff',
      title: 'Customer Motor Referral Quote Seeded via API and Approved in Back-Office Agent Portal',
      charter: 'cross-portal-handoff',
      tags: ['@p0', '@smoke', '@motor'],
      recordedAt: '2026-11-14T00:00:00.000Z',
      baseUrl: 'https://quote.insurer.example.com',
      apiBaseUrl: 'https://api.insurer.example.com',
      persona: {
        role: 'customer_anonymous',
        dataBuilderRef: 'UserBuilder.standardUser',
      },
      actors: [
        {
          actorId: 'customer',
          role: 'customer_anonymous',
          portalBaseUrl: 'https://quote.insurer.example.com',
          dataBuilderRef: 'UserBuilder.standardUser',
        },
        {
          actorId: 'underwriter_agent',
          role: 'senior_underwriter',
          portalBaseUrl: 'https://agent.insurer.example.com',
          dataBuilderRef: 'UserBuilder.standardUser',
          storageStatePath: '.auth/senior_underwriter.json',
        },
      ],
      preconditions: ['Underwriter storageState captured'],
      capturedVariables: [
        {
          name: 'referralQuoteId',
          capturedAtStep: 1,
          source: 'apiResponseJson',
          jsonPath: 'data.quoteId',
          description: 'Referred Quote ID returned by Quote API',
        },
      ],
      semanticSteps: [
        {
          stepIndex: 1,
          actor: 'customer',
          intent: 'Seed a referred motor quote via Backend API',
          pageRoute: '/motor-b2c/quote',
          conditionRef: 'UserBuilder.standardUser().role',
          action: 'apiCall',
          inputDataRef: 'UserBuilder.standardUser',
          capturesVariable: 'referralQuoteId',
          componentCandidate: 'MotorQuoteApiClient',
          locatorContract: {
            strategy: 'apiEndpoint',
            value: '/api/v1/motor/quotes',
          },
        },
        {
          stepIndex: 2,
          actor: 'underwriter_agent',
          portalUrl: 'https://agent.insurer.example.com',
          intent: 'Approve referred quote in Back-Office Agent Portal',
          pageRoute: '/agent/referrals',
          action: 'click',
          componentCandidate: 'AgentReferralQueueComponent',
          locatorContract: {
            strategy: 'getByRole',
            role: 'button',
            value: 'Approve Referral',
          },
        },
      ],
      networkContracts: [
        {
          urlPattern: '/api/v1/motor/quotes',
          method: 'POST',
          expectedStatus: 201,
          clientCandidate: 'MotorQuoteApiClient',
          requestBuilderRef: 'UserBuilder.standardUser',
          responseSchemaSummary: '{ quoteId: string, referralRequired: boolean }',
        },
      ],
      expectedStates: [
        {
          description: 'Approved quote badge matches seeded Quote ID',
          actor: 'underwriter_agent',
          assertionType: 'toContainText',
          targetComponent: 'agentReferralPage.queue',
          targetProperty: 'approvedBadge',
          expectedValueRef: 'capturedVariable:referralQuoteId',
        },
      ],
    };

    fs.writeFileSync(
      path.join(tmpDir, '.exploratory/tapes/motor-b2c-referral-handoff.json'),
      JSON.stringify(complexTape, null, 2),
      'utf8'
    );

    // 1. Validate tape
    const valRes = runNode(path.join(tmpDir, 'scripts/validate-tapes.mjs'), [], tmpDir);
    assert.equal(valRes.status, 0, `validate-tapes failed: ${valRes.stderr}\n${valRes.stdout}`);

    // 2. Seed shard from tape and compile domain graph
    const graphRes = runNode(
      path.join(tmpDir, 'scripts/build-domain-graph.mjs'),
      ['--seed-from-tapes'],
      tmpDir
    );
    assert.equal(graphRes.status, 0, `build-domain-graph failed: ${graphRes.stderr}\n${graphRes.stdout}`);

    const seededShardPath = path.join(
      tmpDir,
      '.agents/domain/domains/motor-b2c/shards/motor-b2c-referral-handoff.md'
    );
    assert.equal(fs.existsSync(seededShardPath), true, 'Expected squad shard to be seeded');
    const shardText = fs.readFileSync(seededShardPath, 'utf8');
    assert.match(shardText, /Multi-Portal Actors/);
    assert.match(shardText, /Observed Backend API Contracts/);
    assert.match(shardText, /MotorQuoteApiClient/);

    // 3. Run audit:solid to ensure auto-indexed shard and skills pass with zero violations
    const auditRes = runNode(path.join(tmpDir, 'scripts/audit-solid.mjs'), [], tmpDir);
    assert.equal(auditRes.status, 0, `audit-solid failed: ${auditRes.stderr}\n${auditRes.stdout}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
