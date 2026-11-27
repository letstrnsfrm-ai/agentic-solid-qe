#!/usr/bin/env node
/**
 * Modular test suite for the Operational QE Ontology (v1 -> v1.3).
 * Runs automatically via `npm run test:engine` (`scripts/tests/*.test.mjs`).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  compileOntologyIndex,
  inferStarterOntology,
  loadOntology,
  querySemanticImpact,
  seedOntologyFile,
  validateOntology,
} from '../lib/ontology.mjs';
import { buildDomainGraph } from '../build-domain-graph.mjs';
import { validateTapeObject } from '../validate-tapes.mjs';
import { analyzeCoverage, formatCompactCoverage } from '../analyze-coverage.mjs';
import { analyzeImpact, formatCompactImpact } from '../impact-graph.mjs';
import { buildContextPack, formatContextPack } from '../context-pack.mjs';
import { analyzeAndHealDrift, formatCompactHealResult } from '../heal-drift.mjs';
import { buildSystemMap } from '../build-system-map.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '../..');
const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts/sync-skills.mjs');

function runNode(scriptPath, args = [], cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: 'utf8' });
}

test('Operational QE Ontology: schema, malformed-input guards, progressive strictness, domain-graph v3 & tape bindings', () => {
  // 1. Reference SauceDemo ontology validates cleanly against src/
  const loaded = loadOntology(REPO_ROOT);
  assert.equal(loaded.exists, true);
  assert.equal(loaded.parseError, null);
  const valRes = validateOntology(loaded.ontology, { rootDir: REPO_ROOT, checkSrcSymbols: true });
  assert.equal(valRes.valid, true, `Reference ontology invalid: ${valRes.errors.join('; ')}`);

  // 2. Referential integrity errors caught cleanly
  const badOntology = structuredClone(loaded.ontology);
  badOntology.links.push({ id: 'bad-link', from: 'GhostEntity', relation: 'owns', to: 'Order' });
  badOntology.invariants.push({
    id: 'bad-inv',
    description: 'References unknown action',
    severity: 'p0',
    entity: 'Order',
    action: 'nonExistentAction',
  });
  badOntology.entities[0].components.push('MissingPhantomComponent');
  const badRes = validateOntology(badOntology, { rootDir: REPO_ROOT, checkSrcSymbols: true });
  assert.equal(badRes.valid, false);
  assert.ok(badRes.errors.some((e) => e.includes('GhostEntity')));
  assert.ok(badRes.errors.some((e) => e.includes('nonExistentAction')));
  assert.ok(badRes.errors.some((e) => e.includes('MissingPhantomComponent')));

  // 3. Malformed non-array fields return clean validation errors (never TypeError)
  for (const badVal of [123, { not: 'an-array' }, 'oops']) {
    const malformed = {
      schemaVersion: '1.0.0',
      domain: 'bad-domain',
      entities: badVal,
      links: badVal,
      actions: badVal,
      invariants: badVal,
    };
    const mRes = validateOntology(malformed, { rootDir: REPO_ROOT, checkSrcSymbols: true });
    assert.equal(mRes.valid, false);
    assert.ok(mRes.errors.length >= 4);
    assert.ok(compileOntologyIndex(REPO_ROOT, malformed));
  }

  // 4. domain-graph v3 embeds compiled ontology coverage & semanticIndex
  const graph = buildDomainGraph({ rootDir: REPO_ROOT, writeToDisk: false });
  assert.equal(graph.schemaVersion, '3.0.0');
  assert.ok(graph.ontology);
  assert.equal(graph.ontology.summary.entities, 4);
  assert.equal(graph.ontology.summary.coveredEntities, 4);
  assert.equal(graph.ontology.summary.transitions, 10);
  assert.equal(graph.ontology.summary.coveredTransitions, 7);
  assert.equal(graph.ontology.summary.invariants, 5);
  assert.equal(graph.ontology.summary.coveredInvariants, 4);
  assert.ok(graph.ontology.coverage.gaps.some((g) => g.target === 'inv-checkout-requires-customer-info'));

  // 5. validateTapeObject validates tape.ontology against ontology.json
  const checkoutTape = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, '.exploratory/tapes/saucedemo-e2e-checkout.json'), 'utf8')
  );
  assert.deepEqual(validateTapeObject(checkoutTape, 'saucedemo-e2e-checkout.json', { ontology: loaded.ontology }), []);
  const badTape = structuredClone(checkoutTape);
  badTape.ontology.entities.push('PhantomEntity');
  badTape.ontology.transitions.push('Order:draft->nonexistent');
  badTape.ontology.invariants.push('inv-does-not-exist');
  const badTapeErrors = validateTapeObject(badTape, 'saucedemo-e2e-checkout.json', { ontology: loaded.ontology });
  assert.ok(badTapeErrors.some((e) => e.includes('PhantomEntity')));
  assert.ok(badTapeErrors.some((e) => e.includes('Order:draft->nonexistent')));
  assert.ok(badTapeErrors.some((e) => e.includes('inv-does-not-exist')));
});

test('Operational QE Ontology: semantic coverage, impact, context packs, heal triage, --seed safety, System Map & Cloud KPIs', () => {
  // 1. analyzeCoverage surfaces ontologyCoverage + compact ONTOL line
  const cov = analyzeCoverage(REPO_ROOT, { writeGraph: false, summary: true });
  assert.ok(cov.ontologyCoverage);
  assert.equal(cov.ontologyCoverage.summary.coveredInvariants, 4);
  assert.equal(cov.ontologyCoverage.uncoveredTransitions.length, 3);
  assert.match(formatCompactCoverage(cov), /ONTOL\s+\|\s+entities=4\/4 transitions=7\/10 invariants=4\/5/);

  // 2. Semantic impact: --entity, --action, --api, and --file
  const orderImpact = analyzeImpact(REPO_ROOT, { entity: 'Order' });
  assert.ok(orderImpact.affectedSpecs.includes('tests/e2e-checkout.spec.ts'));
  assert.ok(orderImpact.semanticImpact.invariants.includes('inv-order-confirmation-shown'));
  assert.match(formatCompactImpact(orderImpact), /ONTOL\s+\|\s+entities=\[Order\]/);

  const apiImpact = querySemanticImpact(REPO_ROOT, { api: 'GET https://www.saucedemo.com/**' });
  assert.ok(apiImpact.actions.includes('authenticateUser'));
  assert.ok(apiImpact.entities.includes('User'));

  const fileImpact = analyzeImpact(REPO_ROOT, { files: ['src/components/checkout-form.component.ts'] });
  assert.ok(fileImpact.semanticImpact.entities.includes('Order'));
  assert.ok(fileImpact.semanticImpact.actions.includes('submitShippingInfo'));
  assert.ok(fileImpact.semanticImpact.invariants.includes('inv-checkout-requires-customer-info'));

  // 3. Entity- & Action-Centric Context Packs (<= 400 tokens)
  const orderCtx = buildContextPack(REPO_ROOT, { entity: 'Order' });
  assert.equal(orderCtx.ontologySlice?.entity?.id, 'Order');
  assert.ok(orderCtx.ontologySlice.invariants.some((i) => i.id === 'inv-checkout-requires-customer-info' && !i.covered));
  const orderCtxText = formatContextPack(orderCtx, { maxTokens: 400 });
  assert.match(orderCtxText, /ENTITY\s+\|\s+Order/);
  assert.match(orderCtxText, /INVAR\s+\|.*inv-checkout-requires-customer-info/);

  const actionCtx = buildContextPack(REPO_ROOT, { action: 'authenticateUser' });
  assert.equal(actionCtx.ontologySlice?.action?.id, 'authenticateUser');
  assert.equal(actionCtx.ontologySlice?.entity?.id, 'User');
  assert.match(formatContextPack(actionCtx, { maxTokens: 400 }), /ACTION\s+\|\s+authenticateUser -> User/);

  // 4. Ontology-Aware Drift Healing triage context
  const healDiag = analyzeAndHealDrift(REPO_ROOT, {
    spec: 'tests/e2e-checkout.spec.ts',
    error: "expect(locator).toHaveText('Thank you for your order!') failed\nExpected: 'Thank you for your order!'\nReceived: 'Order Failed'",
    apply: false,
  });
  assert.equal(healDiag.rootCause.category, 'app-regression');
  assert.ok(healDiag.ontologyContext);
  assert.ok(healDiag.ontologyContext.entities.includes('Order'));
  assert.ok(healDiag.ontologyContext.p0Invariants.includes('inv-order-confirmation-shown'));
  assert.match(formatCompactHealResult(healDiag), /ONTOL\s+\|\s+entities=\[.*Order.*\].*inv-order-confirmation-shown\(P0\)/);

  // 5. Progressive strictness & --seed safety (never writes invalid ontology)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asqe-ont-optin-'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.agents/domain/shards'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.agents/domain/domain-memory.md'),
      '# Domain Memory\n- **Application Name:** OptInApp\n- **Base URL:** `https://example.com`\n',
      'utf8'
    );
    const optGraph = buildDomainGraph({ rootDir: tmpDir, writeToDisk: false });
    assert.equal(optGraph.schemaVersion, '3.0.0');
    assert.equal(optGraph.ontology, null);
    assert.equal(compileOntologyIndex(tmpDir), null);
    assert.equal(querySemanticImpact(tmpDir, { entity: 'Order' }).hasOntology, false);

    // Invalid ontology must NOT be written to disk by seedOntologyFile
    const invalidSeed = seedOntologyFile(tmpDir, {
      dryRun: false,
      ontologyOverride: { schemaVersion: '1.0.0', domain: 'BAD DOMAIN', entities: [], links: [], actions: [], invariants: [] },
    });
    assert.equal(invalidSeed.valid, false);
    assert.equal(invalidSeed.written, false);
    assert.equal(fs.existsSync(path.join(tmpDir, '.agents/domain/ontology.json')), false);

    // Valid starter inference & seeding
    const inferred = inferStarterOntology(REPO_ROOT);
    assert.equal(validateOntology(inferred, { rootDir: REPO_ROOT, checkSrcSymbols: true }).valid, true);
    const seedRes = seedOntologyFile(tmpDir, { dryRun: false });
    assert.equal(seedRes.written, true);
    assert.equal(seedRes.valid, true);
    assert.equal(fs.existsSync(path.join(tmpDir, '.agents/domain/ontology.json')), true);
    const secondSeed = seedOntologyFile(tmpDir, { dryRun: false, force: false });
    assert.equal(secondSeed.written, false);
    assert.equal(secondSeed.alreadyExists, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 6. CLI (--gaps, --validate), orchestrate GATE_OPTIONS, System Map HTML & Cloud KPIs
  const gapsCli = runNode(SYNC_SCRIPT, ['ontology', '--gaps'], REPO_ROOT);
  assert.equal(gapsCli.status, 0, `cortex ontology --gaps failed: ${gapsCli.stderr}`);
  assert.match(gapsCli.stdout, /ONTOL\s+\|\s+domain=swag-labs-ecommerce/);

  const valCli = runNode(SYNC_SCRIPT, ['ontology', '--validate'], REPO_ROOT);
  assert.equal(valCli.status, 0, `cortex ontology --validate failed: ${valCli.stderr}`);

  const orchCli = runNode(path.join(REPO_ROOT, 'scripts/orchestrate.mjs'), ['--compact'], REPO_ROOT);
  assert.equal(orchCli.status, 0, `orchestrate --compact failed: ${orchCli.stderr}`);
  assert.match(orchCli.stdout, /GATE_OPTIONS\s+\|.*inv-checkout-requires-customer-info/);

  const mapOut = path.join(REPO_ROOT, 'reports/system-map.html');
  const { model } = buildSystemMap({ rootDir: REPO_ROOT, outPath: mapOut, quiet: true, persistWaveSnapshot: false });
  assert.ok(model.ontology);
  assert.equal(model.ontology.summary.entities, 4);
  const html = fs.readFileSync(mapOut, 'utf8');
  assert.match(html, /Operational QE Ontology/);
  assert.match(html, /renderOntologyView\(\)/);

  const cloudRes = runNode(path.join(REPO_ROOT, 'scripts/report-cloud.mjs'), ['--dry-run'], REPO_ROOT);
  assert.equal(cloudRes.status, 0, `report-cloud --dry-run failed: ${cloudRes.stderr}`);
  const cloudPayload = JSON.parse(cloudRes.stdout.match(/\{[\s\S]*\}/)[0]);
  assert.equal(cloudPayload.ontologyCoverage?.domain, 'swag-labs-ecommerce');
  assert.equal(cloudPayload.ontologyCoverage?.coveredInvariants, 4);
  assert.equal(cloudPayload.ontologyCoverage?.uncoveredP0Invariants, 0);
});
