#!/usr/bin/env node
/**
 * Master Orchestrator CLI (`npx cortex orchestrate` / `npx cortex status`).
 *
 * Unifies:
 *   1. Coverage & Federated Brain analysis (`analyze-coverage.mjs --json`)
 *   2. Legacy skill/prompt/rule discovery (`.cursorrules`, `CLAUDE.md`, `.agents/legacy-backups/`, etc.)
 *   3. Legacy Java/C# test discovery (`legacy-test-migrator.mjs`)
 *   4. Failing test / drift artifact detection (`playwright-report/results.json`, `test-results/` error-context)
 *   5. CI pipeline readiness check
 *
 * Classifies the repository into Track 1–4 and Stage 0–4 using Safety-First Precedence,
 * prints the Master Orchestrator Blueprint (or `--json`), and optionally runs the top safe
 * deterministic action with `--run`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { analyzeCoverage } from './analyze-coverage.mjs';
import { buildDomainGraph } from './build-domain-graph.mjs';
import { compileSessionTape, finalizeBatchDomainRefresh } from './compile-tape.mjs';
import { analyzeAndHealDrift } from './heal-drift.mjs';
import { discoverLegacyTests, MIGRATION_MANIFEST_REL_PATH } from './legacy-test-migrator.mjs';
import {
  selectNextWaveBatch,
  executeWaveBatch,
  generateMigrationDashboard,
} from './migration-wave-factory.mjs';
import { runFastVerify } from './verify-fast.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_FILE_BYTES = 1024 * 1024;

function readTextSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function walkFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', '.playwright-cli'].includes(entry.name)) continue;
      out.push(...walkFiles(full, predicate));
    } else if (predicate(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

function detectLegacySkillArtifacts(rootDir) {
  const artifacts = [];
  const rootCandidates = [
    '.cursorrules',
    '.windsurfrules',
    'CLAUDE.md',
    '.github/copilot-instructions.md.bak',
  ];
  for (const rel of rootCandidates) {
    const full = path.join(rootDir, rel);
    if (fs.existsSync(full) && !fs.lstatSync(full).isSymbolicLink()) {
      artifacts.push(rel);
    }
  }

  for (const dirRel of ['.agents/legacy-backups', '.cursor/rules', '.windsurf/rules']) {
    const dir = path.join(rootDir, dirRel);
    for (const f of walkFiles(dir, (name) => !name.startsWith('.'))) {
      artifacts.push(path.relative(rootDir, f).replace(/\\/g, '/'));
    }
  }

  const promptDir = path.join(rootDir, '.github/prompts');
  for (const f of walkFiles(promptDir, (name) => name.endsWith('.prompt.md'))) {
    const base = path.basename(f);
    if (!/^(?:0[0-5]|agent-browser|playwright-cli|master-orchestrator)/.test(base)) {
      artifacts.push(path.relative(rootDir, f).replace(/\\/g, '/'));
    }
  }

  return artifacts;
}

function detectFailingTestArtifacts(rootDir) {
  const failures = [];
  const resultsJson = path.join(rootDir, 'playwright-report/results.json');
  const rawResults = readTextSafe(resultsJson);
  if (rawResults) {
    try {
      const parsed = JSON.parse(rawResults);
      const visitSuite = (suite) => {
        for (const spec of suite.specs || []) {
          const failedTest = (spec.tests || []).some((t) =>
            (t.results || []).some((r) => r.status === 'failed' || r.status === 'timedOut')
          );
          if (failedTest) {
            failures.push({
              source: 'playwright-report/results.json',
              title: spec.title || 'Unnamed spec',
              file: spec.file || '',
            });
          }
        }
        for (const child of suite.suites || []) visitSuite(child);
      };
      for (const s of parsed.suites || []) visitSuite(s);
    } catch {
      /* ignore malformed results.json */
    }
  }

  const errorContexts = walkFiles(
    path.join(rootDir, 'test-results'),
    (name) => name === 'error-context.md'
  );
  for (const ec of errorContexts) {
    failures.push({
      source: path.relative(rootDir, ec).replace(/\\/g, '/'),
      title: path.basename(path.dirname(ec)),
      file: '',
    });
  }

  return failures;
}

function detectCiConfigured(rootDir) {
  const candidates = [
    '.github/workflows/playwright-ci.yml',
    '.github/workflows/playwright.yml',
    '.azure-pipelines/playwright-ci.yml',
    'azure-pipelines.yml',
  ];
  return candidates.some((rel) => fs.existsSync(path.join(rootDir, rel)));
}

function runCoverageAnalyzer(rootDir, squad) {
  return analyzeCoverage(rootDir, { squad, summary: true, writeGraph: false });
}

export function assertSafeSquadName(rawSquad) {
  const s = String(rawSquad ?? '').trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(s)) {
    throw new Error(`Invalid --squad value '${rawSquad}'. Must match ^[a-z0-9-]+$.`);
  }
  return s;
}

/**
 * Compute the full Stage 0–4 Master Orchestration Blueprint for `rootDir`.
 */
export function buildOrchestrationBlueprint(rootDir = process.cwd(), options = {}) {
  const squad = options.squad ? assertSafeSquadName(options.squad) : null;
  const coverage = runCoverageAnalyzer(rootDir, squad);

  const legacyRulesAndPrompts = detectLegacySkillArtifacts(rootDir);

  // Check legacy Java/C# tests in rootDir and immediate parent if initialized inside e2e-playwright/
  let legacyCodeTests = [];
  const manifestPath = path.join(rootDir, '.agents/domain/legacy-migration-manifest.json');
  const manifestRaw = readTextSafe(manifestPath);
  if (manifestRaw) {
    try {
      const mm = JSON.parse(manifestRaw);
      legacyCodeTests = (mm.items || []).filter((i) => i.status !== 'compiled');
    } catch {
      /* ignore malformed manifest */
    }
  } else {
    const legacyScan = discoverLegacyTests(rootDir);
    if (legacyScan.detected) {
      legacyCodeTests = legacyScan.tests || [];
    }
  }

  const failingArtifacts = detectFailingTestArtifacts(rootDir);
  const ciConfigured = detectCiConfigured(rootDir);

  const counts = coverage.counts || {};
  const needsTargetUrlConfig = Boolean(coverage.targetApp?.needsTargetUrlConfig);
  const missingAuthSessions = coverage.targetApp?.missingAuthSessions || [];
  const uncompiledTapes = coverage.topUncompiledTapes || [];
  const uncoveredShards = coverage.topUncoveredShards || [];
  const staleShards = coverage.topStaleShards || [];
  const openDefects = coverage.topOpenDefects || [];

  const totalLegacyCount = legacyRulesAndPrompts.length + legacyCodeTests.length;

  // Track 1–4 classification
  let recommendedTrack = 'Track 1 — New App / Greenfield Bootstrap';
  if (counts.wizardSteps > 0 || counts.apiClients > 0 || squad) {
    recommendedTrack = 'Track 4 — Enterprise Multi-Squad / Complex Flows';
  } else if (totalLegacyCount > 0) {
    recommendedTrack = 'Track 3 — Legacy Rules, Scripts & Java/C# Migration';
  } else if ((counts.automatedSpecs || 0) > 0) {
    recommendedTrack = 'Track 2 — Existing Playwright Suite Expansion';
  }

  // Safety-First Precedence for nextAction & Maturity Stage
  let maturityStage = coverage.coverageMaturityStage || 'Stage 0 — Foundation & Bootstrap';
  let nextAction;

  if (needsTargetUrlConfig || missingAuthSessions.length > 0) {
    maturityStage = 'Stage 0 — Foundation, Auth & Legacy Onboarding';
    nextAction = {
      priority: 1,
      skill: '00-env-bootstrap',
      why: needsTargetUrlConfig
        ? 'Target Base URL is still using a placeholder in .agents/domain/domain-memory.md.'
        : `Missing reusable auth session(s): ${missingAuthSessions.join(', ')}.`,
      command: 'npm run init:app',
      autoRunnable: false,
      humanGate: needsTargetUrlConfig
        ? 'Confirm target application URL and credentials.'
        : 'Complete interactive SSO/MFA login to save .auth/<persona>.json.',
    };
  } else if (failingArtifacts.length > 0) {
    maturityStage = 'Stage 4 — Continuous Day-2 Drift Healing';
    nextAction = {
      priority: 2,
      skill: '03-drift-healer',
      why: `Detected ${failingArtifacts.length} failing test artifact(s) requiring live regression vs. drift triage.`,
      command: 'npx cortex heal --dry-run',
      runArgs: [path.join(__dirname, 'heal-drift.mjs'), '--dry-run'],
      autoRunnable: true,
      humanGate: 'Review triage classification (DEFECT-*.md vs. locator drift patch).',
    };
  } else if (uncompiledTapes.length > 0) {
    const firstTape = uncompiledTapes[0];
    const rawScenarioId = typeof firstTape === 'string' ? firstTape : firstTape.scenarioId;
    const scenarioId = /^[a-z0-9][a-z0-9-]*$/.test(String(rawScenarioId || ''))
      ? String(rawScenarioId)
      : null;
    maturityStage =
      counts.wizardSteps > 0 || counts.apiClients > 0
        ? 'Stage 3 — Enterprise Wizards, APIs & Handoffs'
        : 'Stage 1 — P0 Golden-Path Baseline (1 Test at a Time)';
    nextAction = scenarioId
      ? {
          priority: 3,
          skill: '02-solid-architect',
          why: `${uncompiledTapes.length} recorded Session Tape(s) ready for deterministic SOLID compilation (next: ${scenarioId}).`,
          command: `npx cortex compile ${scenarioId} --apply`,
          runArgs: [path.join(__dirname, 'compile-tape.mjs'), scenarioId, '--apply'],
          autoRunnable: true,
          humanGate: 'None — agent compiles & runs npm run verify autonomously.',
        }
      : {
          priority: 3,
          skill: '01-cli-explorer',
          why: `Found uncompiled Session Tape with invalid scenarioId '${rawScenarioId}'. Fix the tape schema before compilation.`,
          command: 'npm run validate:tapes',
          autoRunnable: false,
          humanGate: 'Fix invalid scenarioId in .exploratory/tapes/*.json.',
        };
  } else if (totalLegacyCount > 0) {
    maturityStage = 'Stage 0 — Legacy Rules & Test Migration';
    const hasLegacyTests = legacyCodeTests.length > 0;
    const waveManifestPath = path.join(rootDir, '.agents/domain/migration-manifest.json');
    let waveManifest = null;
    if (fs.existsSync(waveManifestPath)) {
      try {
        waveManifest = JSON.parse(fs.readFileSync(waveManifestPath, 'utf8'));
      } catch {
        waveManifest = null;
      }
    }
    const pendingWave0 = (waveManifest?.wave0Prereqs || []).filter((w) => w.status === 'pending');
    const pendingLedger = (waveManifest?.ledger || []).filter((e) => e.status === 'pending');
    const useWaveFactory = pendingWave0.length > 0 || pendingLedger.length > 0 || legacyCodeTests.length >= 10;

    if (useWaveFactory) {
      const targetWave = pendingWave0.length > 0 ? 0 : (pendingLedger[0]?.wave ?? 1);
      const waveCmd =
        targetWave === 0
          ? 'npx cortex wave --wave 0 --run --dashboard'
          : `npx cortex wave --wave ${targetWave} --batch-size 5 --run --dashboard`;
      nextAction = {
        priority: 4,
        skill: '05-skill-migrator',
        why:
          pendingWave0.length > 0
            ? `${pendingWave0.length} shared Wave-0 StateSeeder/Flow prerequisite(s) ready to scaffold before migrating ${pendingLedger.length} downstream legacy test(s).`
            : `Large legacy suite (${legacyCodeTests.length} test(s), ${pendingLedger.length || legacyCodeTests.length} pending) ready for token-bounded Wave ${targetWave} micro-batch migration.`,
        command: waveCmd,
        runArgs:
          targetWave === 0
            ? [path.join(__dirname, 'migration-wave-factory.mjs'), '--wave', '0', '--run', '--dashboard']
            : [path.join(__dirname, 'migration-wave-factory.mjs'), '--wave', String(targetWave), '--batch-size', '5', '--run', '--dashboard'],
        autoRunnable: true,
        humanGate: 'Review micro-batch compilation & reports/migration-dashboard.html parity burn-down.',
      };
    } else {
      nextAction = {
        priority: 4,
        skill: '05-skill-migrator',
        why: `Discovered ${legacyRulesAndPrompts.length} legacy skill/prompt file(s) and ${legacyCodeTests.length} pending Java/C# test(s).`,
        command: hasLegacyTests
          ? 'node scripts/legacy-test-migrator.mjs --discover'
          : 'npm run migrate:skill -- --discover',
        autoRunnable: false,
        humanGate: 'Approve the 1-test-at-a-time migration wave / slice selection.',
      };
    }
  } else if (uncoveredShards.length > 0) {
    const nextShard = uncoveredShards[0];
    const shardName = typeof nextShard === 'string' ? nextShard : nextShard.shard || nextShard.feature;
    maturityStage =
      (counts.automatedSpecs || 0) === 0
        ? 'Stage 1 — P0 Golden-Path Baseline (1 Test at a Time)'
        : 'Stage 2 — Multi-Persona, Boundary & Resilience Expansion';
    nextAction = {
      priority: 5,
      skill: '01-cli-explorer',
      why: `${uncoveredShards.length} uncovered domain shard(s) remain (next: ${shardName}).`,
      command: `npx agent-browser --session ${shardName} --headed open ${coverage.targetApp?.baseUrl || ''}`.trim(),
      autoRunnable: false,
      humanGate: 'Approve 1 scenario from the Session Debrief Matrix.',
    };
  } else if (staleShards.length > 0 || !ciConfigured) {
    maturityStage = 'Stage 4 — CI/CD Sharding & Freshness';
    nextAction = {
      priority: 6,
      skill: !ciConfigured ? '04-ci-pipeline' : '01-cli-explorer',
      why: !ciConfigured
        ? 'All current shards are covered, but no Playwright CI workflow was detected.'
        : `${staleShards.length} domain shard(s) are stale and due for re-verification.`,
      command: 'npm run verify',
      runArgs: null,
      npmScript: 'verify',
      autoRunnable: true,
      humanGate: !ciConfigured ? 'Review generated CI pipeline workflow.' : 'None.',
    };
  } else {
    maturityStage = 'Stage 4 — Maintained & CI-Ready';
    nextAction = {
      priority: 7,
      skill: '00-master-orchestrator',
      why: 'All domain shards are covered, tapes compiled, zero drift detected, and CI is configured.',
      command: 'npm run verify',
      npmScript: 'verify',
      autoRunnable: true,
      humanGate: 'None — reporting verified results.',
    };
  }

  return {
    masterOrchestratorSkill: '/00-master-orchestrator',
    targetApp: {
      appName: coverage.targetApp?.appName || 'Target App',
      baseUrl: coverage.targetApp?.baseUrl || '',
      needsTargetUrlConfig,
      savedAuthSessionsCount: coverage.targetApp?.savedAuthSessionsCount ?? (coverage.targetApp?.savedAuthSessions?.length || 0),
      missingAuthSessions,
    },
    recommendedTrack,
    maturityStage,
    coverageMaturityStage: maturityStage,
    ...(coverage.upgradeStatus ? { upgradeStatus: coverage.upgradeStatus } : {}),
    healthSnapshot: {
      domainShards: counts.domainShards || 0,
      uncoveredShards: counts.uncoveredShards || 0,
      staleShards: counts.staleShards || 0,
      recordedTapes: counts.recordedTapes || 0,
      uncompiledTapes: counts.uncompiledTapes || 0,
      automatedSpecs: counts.automatedSpecs || 0,
      components: counts.components || 0,
      wizardSteps: counts.wizardSteps || 0,
      pages: counts.pages || 0,
      apiClients: counts.apiClients || 0,
      legacySkillsAndPrompts: legacyRulesAndPrompts.length,
      legacyCodeTestsPending: legacyCodeTests.length,
      failingTestArtifacts: failingArtifacts.length,
      openDefects: openDefects.length,
      ciConfigured,
    },
    queuePreview: {
      uncompiledTapes: uncompiledTapes.slice(0, 10),
      uncoveredShards: uncoveredShards.slice(0, 10),
      failingArtifacts: failingArtifacts.slice(0, 5),
    },
    nextAction,
  };
}

export function computeBlueprintFingerprint(bp) {
  const h = bp?.healthSnapshot || {};
  return [
    bp?.nextAction?.skill || '',
    bp?.nextAction?.command || '',
    h.uncompiledTapes || 0,
    h.failingTestArtifacts || 0,
    h.legacyCodeTestsPending || 0,
    h.uncoveredShards || 0,
    h.automatedSpecs || 0,
  ].join('|');
}

export function formatCompactBlueprint(bp) {
  const h = bp.healthSnapshot;
  return [
    `CORTEX | ${bp.targetApp.appName} (${bp.targetApp.baseUrl || 'unconfigured'}) | ${bp.maturityStage}`,
    `HEALTH | shards:${h.domainShards} (uncovered:${h.uncoveredShards}, stale:${h.staleShards}) | tapes:${h.recordedTapes} (uncompiled:${h.uncompiledTapes}) | specs:${h.automatedSpecs} | legacy:${h.legacySkillsAndPrompts}r/${h.legacyCodeTestsPending}t | fails:${h.failingTestArtifacts} | ci:${h.ciConfigured ? 'ok' : 'missing'}`,
    `NEXT   | /${bp.nextAction.skill} -> ${bp.nextAction.command} [auto:${bp.nextAction.autoRunnable ? 'yes' : 'no'}]`,
    `WHY    | ${bp.nextAction.why}`,
    `GATE   | ${bp.nextAction.humanGate}`,
  ].join('\n');
}

function formatBlueprintMarkdown(bp) {
  const h = bp.healthSnapshot;
  const lines = [
    `### 🧠 Agentic-SOLID-QE — Master Orchestrator Blueprint`,
    ``,
    `- **Target Application:** ${bp.targetApp.appName} (${bp.targetApp.baseUrl || 'unconfigured'})`,
    `- **Recommended Onboarding Track:** ${bp.recommendedTrack}`,
    `- **Current Coverage Maturity Stage:** ${bp.maturityStage}`,
    `- **Repository Health Snapshot:**`,
    `  - **Domain Brain:** ${h.domainShards} Feature Shard(s) (${h.uncoveredShards} uncovered, ${h.staleShards} stale)`,
    `  - **Session Tapes:** ${h.recordedTapes} recorded (${h.uncompiledTapes} uncompiled)`,
    `  - **SOLID Suite:** ${h.components} Components, ${h.wizardSteps} Wizard Steps, ${h.pages} Pages, ${h.apiClients} API Clients, ${h.automatedSpecs} Specs`,
    `  - **Legacy & Triage Signals:** ${h.legacySkillsAndPrompts} legacy rules/prompts, ${h.legacyCodeTestsPending} pending Java/C# tests, ${h.failingTestArtifacts} failing test artifact(s), ${h.openDefects} open defect(s), CI ${h.ciConfigured ? 'configured' : 'missing'}`,
    ``,
    `#### 🎯 Autonomous Agent Action & Human Review Gate (1 Test at a Time)`,
    `1. **Recommended Skill / Action:** \`/${bp.nextAction.skill}\` (\`${bp.nextAction.command}\`)`,
    `2. **Why Now:** ${bp.nextAction.why}`,
    `3. **Human Review Gate:** ${bp.nextAction.humanGate}`,
    ``,
  ];
  return lines.join('\n');
}

function clearResolvedFailureArtifacts(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const errorContexts = walkFiles(
    path.join(resolvedRoot, 'test-results'),
    (name) => name === 'error-context.md'
  );
  for (const ec of errorContexts) {
    const rel = path.relative(resolvedRoot, ec);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      try {
        if (!fs.lstatSync(ec).isSymbolicLink()) fs.unlinkSync(ec);
      } catch {
        /* ignore cleanup failure */
      }
    }
  }
  const resultsJson = path.join(resolvedRoot, 'playwright-report/results.json');
  if (fs.existsSync(resultsJson)) {
    try {
      if (!fs.lstatSync(resultsJson).isSymbolicLink()) fs.unlinkSync(resultsJson);
    } catch {
      /* ignore cleanup failure */
    }
  }
}

/**
 * Smart Auto-Drain Orchestrator Loop (`npx cortex orchestrate --loop`).
 *
 * Autonomously chains consecutive safe deterministic actions (high-confidence locator heals,
 * batch Session Tape compilation, Wave-0/Wave-N migration micro-batches) with two-tier
 * verification, halting immediately at any true human gate, genuine regression/ambiguous drift,
 * state-fingerprint cycle, or `--max-steps` cap.
 */
export async function runOrchestratorLoop(
  rootDir = process.cwd(),
  {
    squad = null,
    maxSteps = 10,
    workers = 4,
    fastOnly = false,
    skipTests = false,
    verifyWaves = false,
    quiet = false,
  } = {}
) {
  const tStart = performance.now();
  const safeMaxSteps = Math.max(1, Math.min(50, Number.isFinite(Number(maxSteps)) ? Math.floor(Number(maxSteps)) : 10));
  const safeWorkers = Math.max(1, Math.min(32, Number.isFinite(Number(workers)) ? Math.floor(Number(workers)) : 4));

  const stepsExecuted = [];
  const mutatedSpecs = new Set();
  const seenFingerprints = new Set();
  let didMutate = false;
  let stoppedReason = 'max-steps-reached';
  let humanGate = null;
  let triageReport = null;
  let bp = null;

  for (let stepIdx = 0; stepIdx < safeMaxSteps; stepIdx++) {
    bp = buildOrchestrationBlueprint(rootDir, { squad });
    const fp = computeBlueprintFingerprint(bp);

    if (seenFingerprints.has(fp)) {
      stoppedReason = 'cycle-detected';
      humanGate = 'Orchestrator state did not advance after previous step; manual review required.';
      break;
    }
    seenFingerprints.add(fp);

    if (!bp.nextAction.autoRunnable) {
      stoppedReason = 'human-gate';
      humanGate = bp.nextAction.humanGate;
      break;
    }

    // Priority 2: Failing test artifacts -> dry-run triage first; auto-apply ONLY high-confidence locator drift
    if (bp.nextAction.skill === '03-drift-healer') {
      const triage = analyzeAndHealDrift(rootDir, { apply: false });
      const isSafeHighConfidenceDrift =
        triage?.rootCause?.category === 'locator-drift' && triage?.autoHealReady === true;

      if (!isSafeHighConfidenceDrift) {
        triageReport = triage;
        stoppedReason = 'human-triage-required';
        humanGate =
          triage?.rootCause?.category === 'app-regression'
            ? 'Detected potential genuine application regression — review triage before logging defect.'
            : triage?.rootCause?.category === 'auth-drift'
              ? 'Authentication session drift detected — refresh .auth/<persona>.json.'
              : bp.nextAction.humanGate;
        stepsExecuted.push({
          step: stepIdx + 1,
          skill: '03-drift-healer',
          status: 'paused-for-triage',
          category: triage?.rootCause?.category || 'unknown',
          autoHealReady: Boolean(triage?.autoHealReady),
        });
        break;
      }

      const applied = analyzeAndHealDrift(rootDir, { apply: true });
      const affectedSpecs = [];
      if (applied?.spec && /^tests\/[a-zA-Z0-9_./-]+\.spec\.ts$/.test(applied.spec)) {
        affectedSpecs.push(applied.spec);
        mutatedSpecs.add(applied.spec);
      }
      didMutate = true;

      const vRes = await runFastVerify({
        rootDir,
        fast: true,
        specs: affectedSpecs,
        skipTests,
        skipMap: true,
        workers: safeWorkers,
        quiet: true,
      });

      stepsExecuted.push({
        step: stepIdx + 1,
        skill: '03-drift-healer',
        status: vRes.ok ? 'healed-and-verified' : 'heal-verify-failed',
        appliedChanges: applied.appliedChanges || [],
        verifyMs: vRes.totalMs,
      });

      if (!vRes.ok) {
        stoppedReason = 'heal-verify-failed';
        humanGate = `Auto-healed locator failed targeted verify (${vRes.failedStage?.stage || 'unknown'}); manual review required.`;
        break;
      }

      clearResolvedFailureArtifacts(rootDir);
      continue;
    }

    // Priority 3: Batch-compile all queued valid uncompiled Session Tapes in-process + Tier-1 fast verify
    if (bp.nextAction.skill === '02-solid-architect') {
      const queuedTapes = (bp.queuePreview?.uncompiledTapes || [])
        .map((t) => (typeof t === 'string' ? t : t?.scenarioId))
        .filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(String(id || '')));

      if (queuedTapes.length === 0) {
        stoppedReason = 'human-gate';
        humanGate = 'Fix invalid scenarioId in uncompiled Session Tape(s).';
        break;
      }

      const sharedGraph = buildDomainGraph({ rootDir, writeToDisk: false });
      const compiledIds = [];
      const batchSpecs = [];
      let compileError = null;

      for (const sid of queuedTapes) {
        try {
          const rep = compileSessionTape({
            tapeInput: sid,
            squadOverride: squad || '',
            apply: true,
            rootDir,
            domainGraph: sharedGraph,
            deferGraphRefresh: true,
            skipMap: true,
          });
          compiledIds.push(sid);
          const specOp = (rep.operations || []).find((op) => op.file && op.file.endsWith('.spec.ts'));
          if (specOp?.file) {
            batchSpecs.push(specOp.file);
            mutatedSpecs.add(specOp.file);
          }
        } catch (err) {
          compileError = { scenarioId: sid, message: String(err.message || err).slice(0, 240) };
          break;
        }
      }

      if (compiledIds.length > 0) {
        finalizeBatchDomainRefresh(rootDir, { skipMap: true });
        didMutate = true;
      }

      if (compileError) {
        stepsExecuted.push({
          step: stepIdx + 1,
          skill: '02-solid-architect',
          status: 'compile-failed',
          compiledTapes: compiledIds,
          error: compileError,
        });
        stoppedReason = 'compile-failed';
        humanGate = `Tape compilation failed for '${compileError.scenarioId}': ${compileError.message}`;
        break;
      }

      const vRes = await runFastVerify({
        rootDir,
        fast: true,
        specs: batchSpecs,
        skipTests,
        skipMap: true,
        workers: safeWorkers,
        quiet: true,
      });

      stepsExecuted.push({
        step: stepIdx + 1,
        skill: '02-solid-architect',
        status: vRes.ok ? 'compiled-and-verified' : 'verify-failed',
        compiledTapes: compiledIds,
        specs: batchSpecs,
        verifyMs: vRes.totalMs,
      });

      if (!vRes.ok) {
        stoppedReason = 'verify-failed';
        humanGate = `Fast verify failed at '${vRes.failedStage?.stage || 'unknown'}' after compiling ${compiledIds.join(', ')}.`;
        break;
      }
      continue;
    }

    // Priority 4: Wave Factory autonomous micro-batch execution in-process
    if (bp.nextAction.skill === '05-skill-migrator') {
      const manifestPath = path.join(rootDir, MIGRATION_MANIFEST_REL_PATH);
      if (!fs.existsSync(manifestPath)) {
        stoppedReason = 'human-gate';
        humanGate = 'Run cortex wave --scan <legacy-dir> to initialize the migration ledger.';
        break;
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const pendingWave0 = (manifest.wave0Prereqs || []).filter((w) => w.status === 'pending');
      const targetWave = pendingWave0.length > 0 ? 0 : null;
      const selection = selectNextWaveBatch(manifest, {
        squad: squad || '',
        wave: targetWave,
        batchSize: 5,
      });
      if (!selection.batch || selection.batch.length === 0) {
        stoppedReason = 'wave-queue-empty';
        humanGate = 'No pending wave items remain; review quarantined or needs-triage ledger items.';
        break;
      }

      const execution = executeWaveBatch(manifest, selection, {
        projectRoot: rootDir,
        verify: verifyWaves && !skipTests,
        workers: safeWorkers,
      });
      didMutate = true;
      for (const r of execution.results || []) {
        if (r.targetSpec && /^tests\/[a-zA-Z0-9_./-]+\.spec\.ts$/.test(r.targetSpec)) {
          mutatedSpecs.add(r.targetSpec);
        }
      }
      try {
        generateMigrationDashboard(rootDir);
      } catch {
        /* non-fatal */
      }

      stepsExecuted.push({
        step: stepIdx + 1,
        skill: '05-skill-migrator',
        wave: execution.wave,
        processed: execution.processed,
        results: execution.results,
      });
      continue;
    }

    // Priority 6/7: No further mutating auto-actions; exit drain loop cleanly to run Tier-2 final verify once
    stoppedReason = 'drained-clean';
    humanGate = bp.nextAction.humanGate;
    break;
  }

  // Tier-2 Final Verification Gate (run ONCE at end of drain loop if files mutated or repo was ready to verify)
  let finalVerify = null;
  const shouldRunFinalVerify =
    !fastOnly &&
    !['cycle-detected', 'compile-failed', 'verify-failed', 'heal-verify-failed', 'human-triage-required'].includes(
      stoppedReason
    ) &&
    (didMutate || stoppedReason === 'drained-clean');

  if (shouldRunFinalVerify) {
    finalVerify = await runFastVerify({
      rootDir,
      fast: false,
      skipTests,
      withEngine: false,
      skipMap: false,
      workers: safeWorkers,
      quiet: true,
    });
    if (!finalVerify.ok) {
      stoppedReason = 'final-verify-failed';
      humanGate = `Final verify failed at '${finalVerify.failedStage?.stage || 'unknown'}'.`;
    }
  }

  const finalBlueprint = buildOrchestrationBlueprint(rootDir, { squad });
  const summary = {
    mode: 'auto-drain-loop',
    stepsExecuted,
    stoppedReason,
    humanGate,
    ...(triageReport ? { triageReport } : {}),
    mutatedSpecs: [...mutatedSpecs],
    finalVerify,
    totalMs: Math.round(performance.now() - tStart),
    finalBlueprint,
  };

  if (!quiet) {
    console.log(formatCompactBlueprint(finalBlueprint));
    console.log(
      `LOOP   | steps:${stepsExecuted.length} | stopped:${stoppedReason} | mutatedSpecs:${mutatedSpecs.size} | finalVerify:${finalVerify ? (finalVerify.ok ? 'pass' : 'fail') : 'skipped'} | total:${summary.totalMs}ms`
    );
  }

  return summary;
}

// CLI Entrypoint
const isMain =
  Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🧠 Master Orchestrator CLI (npx cortex orchestrate)

Usage:
  npx cortex orchestrate [--squad <squad>] [--json] [--compact] [--run]
  npx cortex orchestrate --loop [--max-steps 10] [--workers 4] [--fast-only] [--skip-tests] [--verify-waves] [--compact] [--json]
`);
    process.exit(0);
  }

  let squad = null;
  let jsonOut = false;
  let compactOut = false;
  let runNext = false;
  let loopMode = false;
  let maxSteps = 10;
  let workers = 4;
  let fastOnly = false;
  let skipTests = false;
  let verifyWaves = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--squad' && args[i + 1]) squad = args[++i];
    else if (args[i].startsWith('--squad=')) squad = args[i].slice('--squad='.length);
    else if (args[i] === '--max-steps' && args[i + 1]) maxSteps = Number(args[++i]);
    else if (args[i].startsWith('--max-steps=')) maxSteps = Number(args[i].slice('--max-steps='.length));
    else if (args[i] === '--workers' && args[i + 1]) workers = Number(args[++i]);
    else if (args[i].startsWith('--workers=')) workers = Number(args[i].slice('--workers='.length));
    else if (args[i] === '--json') jsonOut = true;
    else if (args[i] === '--compact') compactOut = true;
    else if (args[i] === '--run') runNext = true;
    else if (args[i] === '--loop') loopMode = true;
    else if (args[i] === '--fast-only') fastOnly = true;
    else if (args[i] === '--skip-tests') skipTests = true;
    else if (args[i] === '--verify-waves') verifyWaves = true;
  }

  if (squad !== null) {
    try {
      squad = assertSafeSquadName(squad);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  }

  const rootDir = process.cwd();

  if (loopMode) {
    runOrchestratorLoop(rootDir, {
      squad,
      maxSteps,
      workers,
      fastOnly,
      skipTests,
      verifyWaves,
      quiet: jsonOut,
    })
      .then((res) => {
        if (jsonOut) {
          console.log(JSON.stringify(res, null, 2));
        }
        const failed = ['compile-failed', 'verify-failed', 'heal-verify-failed', 'final-verify-failed'].includes(
          res.stoppedReason
        );
        process.exit(failed ? 1 : 0);
      })
      .catch((err) => {
        console.error(`❌ orchestrate --loop failed: ${err.message}`);
        process.exit(1);
      });
  } else {
    const blueprint = buildOrchestrationBlueprint(rootDir, { squad });

    if (jsonOut) {
      console.log(JSON.stringify(blueprint, null, 2));
    } else if (compactOut) {
      console.log(formatCompactBlueprint(blueprint));
    } else {
      console.log(formatBlueprintMarkdown(blueprint));
    }

    if (runNext) {
      if (!blueprint.nextAction.autoRunnable) {
        if (!jsonOut) {
          console.log(
            `⏸️  Next action (/${blueprint.nextAction.skill}) requires interactive browser exploration or human input: ${blueprint.nextAction.humanGate}`
          );
        }
        process.exit(0);
      }

      if (!jsonOut) {
        console.log(`🚀 Executing: ${blueprint.nextAction.command}\n`);
      }
      if (blueprint.nextAction.runArgs) {
        const res = spawnSync(process.execPath, blueprint.nextAction.runArgs, {
          cwd: rootDir,
          stdio: jsonOut ? 'pipe' : 'inherit',
        });
        process.exit(res.status ?? 0);
      } else if (blueprint.nextAction.npmScript) {
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const res = spawnSync(npmCmd, ['run', blueprint.nextAction.npmScript], {
          cwd: rootDir,
          stdio: jsonOut ? 'pipe' : 'inherit',
        });
        process.exit(res.status ?? 0);
      }
    }
  }
}
