#!/usr/bin/env node
/**
 * Modular engine tests for:
 * 1. Sharded team overrides (`.agents/overrides/<topic>.md`) + Context Pack retrieval
 * 2. `auditOverrides()` token budget, scope validation, and staleness warnings
 * 3. `auditScriptsRatchet()` framework-only script line-count ratchet
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  collectOverrides,
  formatOverridesForContextPack,
  isValidScopeToken,
  parseOverrideFile,
} from '../lib/overrides-store.mjs';
import { auditOverrides } from '../lib/audit-overrides.mjs';
import { auditScriptsRatchet } from '../lib/audit-scripts-ratchet.mjs';
import { buildContextPack, formatContextPack } from '../context-pack.mjs';

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'asqe-overrides-ratchet-'));
}

function writeFile(root, relPath, content) {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

test('parseOverrideFile supports bold metadata and YAML frontmatter scopes', () => {
  const md = [
    '# Checkout Tagging Policy',
    '',
    '**Scope:** global, route:/checkout, skill:02-solid-architect',
    '**Last Verified:** 2026-10-01',
    '',
    '- Always tag checkout specs with `@pci`.',
    '- Never auto-heal payment form selectors without human approval.',
  ].join('\n');

  const parsed = parseOverrideFile(md, '.agents/overrides/checkout-policy.md');
  assert.equal(parsed.title, 'Checkout Tagging Policy');
  assert.deepEqual(parsed.scopes, ['global', 'route:/checkout', 'skill:02-solid-architect']);
  assert.equal(parsed.lastVerified, '2026-10-01');
  assert.equal(parsed.bullets.length, 2);

  const yamlMd = [
    '---',
    'scope: [squad:billing, skill:03-drift-healer]',
    'last_verified: 2026-11-01',
    '---',
    '# Billing Healing Rules',
    '- Escalate invoice total mismatches as product defects.',
  ].join('\n');
  const parsedYaml = parseOverrideFile(yamlMd, '.agents/overrides/billing.md');
  assert.deepEqual(parsedYaml.scopes, ['squad:billing', 'skill:03-drift-healer']);
  assert.equal(parsedYaml.lastVerified, '2026-11-01');
  assert.equal(isValidScopeToken('global'), true);
  assert.equal(isValidScopeToken('skill:03-drift-healer'), true);
  assert.equal(isValidScopeToken('invalid:foo'), false);
});

test('collectOverrides & buildContextPack surface only matching scope overrides', () => {
  const root = makeTempRepo();
  try {
    writeFile(root, '.agents/domain/domain-memory.md', '# Domain\n- **Base URL:** `https://app.example.com`\n');
    writeFile(
      root,
      '.agents/overrides/global-tags.md',
      '# Global Tagging\n**Scope:** global\n- Every P0 spec must include `@p0`.\n'
    );
    writeFile(
      root,
      '.agents/overrides/checkout-pci.md',
      '# Checkout PCI\n**Scope:** route:/checkout\n- Never log card CVV in traces.\n'
    );
    writeFile(
      root,
      '.agents/overrides/billing-squad.md',
      '# Billing Rules\n**Scope:** squad:billing\n- Use BillingSeeder for invoice setup.\n'
    );

    const checkoutOverrides = collectOverrides(root, { route: '/checkout-step-one' });
    assert.deepEqual(
      checkoutOverrides.map((o) => o.rel),
      ['.agents/overrides/checkout-pci.md', '.agents/overrides/global-tags.md']
    );

    const pack = buildContextPack(root, { route: '/checkout-step-one' });
    assert.equal(pack.overrides.length, 2);
    const formatted = formatContextPack(pack, { maxTokens: 400 });
    assert.match(formatted, /OVERRIDES \(2\):/);
    assert.match(formatted, /checkout-pci\.md \[route:\/checkout\]/);
    assert.doesNotMatch(formatted, /billing-squad\.md/);

    const formattedLines = formatOverridesForContextPack(checkoutOverrides);
    assert.ok(formattedLines.some((l) => l.includes('Never log card CVV')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auditOverrides enforces <=800 token budget, required valid scope, and 90-day staleness warning', () => {
  const root = makeTempRepo();
  try {
    // 1. Valid override
    writeFile(
      root,
      '.agents/overrides/valid.md',
      '# Valid Override\n**Scope:** global\n**Last Verified:** 2026-11-20\n- Keep locators semantic.\n'
    );
    // 2. Missing scope
    writeFile(root, '.agents/overrides/no-scope.md', '# No Scope\n- Missing scope header.\n');
    // 3. Invalid scope token
    writeFile(root, '.agents/overrides/bad-scope.md', '# Bad Scope\n**Scope:** env:prod\n- Bad scope.\n');
    // 4. Oversized (> 800 tokens)
    const bigBody = Array.from({ length: 700 }, (_, i) => `rule${i}`).join(' ');
    writeFile(root, '.agents/overrides/too-big.md', `# Too Big\n**Scope:** global\n- ${bigBody}\n`);
    // 5. Stale (> 90 days)
    writeFile(
      root,
      '.agents/overrides/stale.md',
      '# Stale Rule\n**Scope:** global\n**Last Verified:** 2025-01-01\n- Old rule.\n'
    );

    const res = auditOverrides(root);
    assert.equal(res.overrideCount, 5);
    assert.ok(res.violations.some((v) => v.includes('[Override Scope Missing]') && v.includes('no-scope.md')));
    assert.ok(res.violations.some((v) => v.includes('[Override Scope Invalid]') && v.includes('bad-scope.md')));
    assert.ok(
      res.violations.some(
        (v) => v.includes('[Override Token Budget]') && v.includes('too-big.md') && v.includes('instead of summarizing')
      )
    );
    assert.ok(res.warnings.some((w) => w.includes('[Override Staleness Advisory]') && w.includes('stale.md')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auditScriptsRatchet skips consumer repos and enforces baseline + new-file cap in framework repo', () => {
  const consumerRoot = makeTempRepo();
  const fwRoot = makeTempRepo();
  try {
    // Consumer repo: should be inactive (no violations even with a 700-line script)
    writeFile(consumerRoot, 'package.json', JSON.stringify({ name: 'acme-consumer-app' }));
    writeFile(consumerRoot, 'scripts/custom.mjs', 'export const x = 1;\n'.repeat(700));
    const consumerRes = auditScriptsRatchet(consumerRoot);
    assert.equal(consumerRes.active, false);
    assert.equal(consumerRes.violations.length, 0);

    // Framework repo: active ratchet
    writeFile(fwRoot, 'package.json', JSON.stringify({ name: 'agentic-solid-qe' }));
    writeFile(
      fwRoot,
      'scripts/script-size-baseline.json',
      JSON.stringify({
        schemaVersion: '1.0.0',
        maxNewScriptLines: 500,
        legacyBaselines: {
          'scripts/monolith.mjs': 600,
          'scripts/self-test.mjs': 800,
        },
      })
    );
    writeFile(fwRoot, 'scripts/monolith.mjs', 'const a = 1;\n'.repeat(605)); // grew past 600 -> fail
    writeFile(fwRoot, 'scripts/self-test.mjs', 'const b = 1;\n'.repeat(799)); // <= 800 -> ok
    writeFile(fwRoot, 'scripts/lib/new-big.mjs', 'const c = 1;\n'.repeat(520)); // new > 500 -> fail
    writeFile(fwRoot, 'scripts/lib/new-ok.mjs', 'const d = 1;\n'.repeat(120)); // new <= 500 -> ok

    const fwRes = auditScriptsRatchet(fwRoot);
    assert.equal(fwRes.active, true);
    assert.ok(fwRes.violations.some((v) => v.includes('[Script Size Ratchet]') && v.includes('scripts/monolith.mjs')));
    assert.ok(fwRes.violations.some((v) => v.includes('[Script Size Budget]') && v.includes('scripts/lib/new-big.mjs')));
    assert.equal(fwRes.violations.length, 2);
  } finally {
    fs.rmSync(consumerRoot, { recursive: true, force: true });
    fs.rmSync(fwRoot, { recursive: true, force: true });
  }
});
