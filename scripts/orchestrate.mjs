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
import { isCompactMode } from './lib/cli-output.mjs';
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
      if (['node_modules', '.git', '.agent-browser', '.playwright-cli'].includes(entry.name)) continue;
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
    if (!/^(?:0[0-5]|agent-browser|playwright-cli|agentic-solid-qe|master-orchestrator)/.test(base)) {
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
    const gateOptions = needsTargetUrlConfig
      ? [
          {
            id: 'bootstrap-live-url',
            label: '(Recommended) Bootstrap target URL and auto-discover initial feature shards via agentic-solid-qe',
            command: 'npx cortex orchestrate --bootstrap --url <https://your-app.com> --name "<App Name>" --discover-shards',
          },
          {
            id: 'bootstrap-url-only',
            label: 'Configure target URL only (skip live route discovery)',
            command: 'npx cortex orchestrate --bootstrap --url <https://your-app.com> --name "<App Name>"',
          },
        ]
      : [
          {
            id: 'auth-session-save',
            label: `(Recommended) Complete interactive login for ${missingAuthSessions.join(', ')}`,
            command: `npx cortex orchestrate --explore start --url ${coverage.targetApp?.baseUrl || 'http://localhost:3000'} --headed`,
          },
        ];
    nextAction = {
      priority: 1,
      skill: '00-env-bootstrap',
      why: needsTargetUrlConfig
        ? 'Target Base URL is still using a placeholder in .agents/domain/domain-memory.md.'
        : `Missing reusable auth session(s): ${missingAuthSessions.join(', ')}.`,
      command: needsTargetUrlConfig
        ? 'npx cortex orchestrate --bootstrap --url <url> --name "<App Name>" --discover-shards'
        : 'npm run init:app',
      autoRunnable: false,
      humanGate: needsTargetUrlConfig
        ? 'Confirm target application URL and credentials.'
        : 'Complete interactive SSO/MFA login to save .auth/<persona>.json.',
      gatePayload: {
        gateId: needsTargetUrlConfig ? 'stage0-target-url' : 'stage0-auth-session',
        question: needsTargetUrlConfig
          ? 'Provide the target application URL and name to bootstrap Stage 0 via agentic-solid-qe:'
          : `Authenticate missing persona session(s) (${missingAuthSessions.join(', ')}) to proceed:`,
        options: gateOptions,
      },
    };
  } else if (failingArtifacts.length > 0) {
    maturityStage = 'Stage 4 — Continuous Day-2 Drift Healing';
    nextAction = {
      priority: 2,
      skill: '03-drift-healer',
      why: `Detected ${failingArtifacts.length} failing test artifact(s) requiring live regression vs. drift triage.`,
      command: 'npx cortex orchestrate --heal-action dry-run',
      runArgs: [path.join(__dirname, 'heal-drift.mjs'), '--dry-run'],
      autoRunnable: true,
      humanGate: 'Review triage classification (DEFECT-*.md vs. locator drift patch).',
      gatePayload: {
        gateId: 'stage4-drift-triage',
        question: `How should agentic-solid-qe resolve the ${failingArtifacts.length} failing test artifact(s)?`,
        options: [
          {
            id: 'heal-apply',
            label: '(Recommended) Auto-heal drifted component locator(s) and run targeted fast verification',
            command: 'npx cortex orchestrate --heal-action apply',
          },
          {
            id: 'heal-dry-run',
            label: 'Inspect dry-run root-cause classification & blast-radius first',
            command: 'npx cortex orchestrate --heal-action dry-run',
          },
        ],
      },
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
          command: `npx cortex orchestrate --loop --compact`,
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
    const rawShardPath = typeof nextShard === 'string' ? nextShard : nextShard.shard || nextShard.feature || 'main';
    const shardSlug = path.basename(String(rawShardPath), '.md').replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'main';
    let shardRoute = '/';
    const shardFull = path.join(rootDir, String(rawShardPath));
    if (fs.existsSync(shardFull)) {
      const m = readTextSafe(shardFull).match(/`(\/[a-zA-Z0-9._/-]*)`/);
      if (m) shardRoute = m[1];
    }
    const baseUrlClean = String(coverage.targetApp?.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
    const targetExploreUrl = shardRoute.startsWith('/') ? `${baseUrlClean}${shardRoute}` : baseUrlClean;

    maturityStage =
      (counts.automatedSpecs || 0) === 0
        ? 'Stage 1 — P0 Golden-Path Baseline (1 Test at a Time)'
        : 'Stage 2 — Multi-Persona, Boundary & Resilience Expansion';
    nextAction = {
      priority: 5,
      skill: '01-cli-explorer',
      why: `${uncoveredShards.length} uncovered domain shard(s) remain (next: ${rawShardPath} -> ${shardRoute}).`,
      command: `npx cortex orchestrate --explore start --shard ${shardSlug} --scenario ${shardSlug}-p0`,
      autoRunnable: false,
      humanGate: 'Approve 1 scenario from the Session Debrief Matrix.',
      gatePayload: {
        gateId: 'stage1-scenario-selection',
        shard: shardSlug,
        route: shardRoute,
        targetUrl: targetExploreUrl,
        question: `Select 1 scenario to explore and automate for shard '${shardSlug}' (${shardRoute}):`,
        options: [
          {
            id: `${shardSlug}-p0`,
            label: `(Recommended) @p0 Happy-Path Baseline on ${shardRoute} (happy-path-baseline)`,
            charter: 'happy-path-baseline',
            command: `npx cortex orchestrate --explore start --shard ${shardSlug} --scenario ${shardSlug}-p0`,
          },
          {
            id: `${shardSlug}-negative`,
            label: `@p1 Boundary & Validation Error Resilience on ${shardRoute} (boundary-analysis)`,
            charter: 'boundary-analysis',
            command: `npx cortex orchestrate --explore start --shard ${shardSlug} --scenario ${shardSlug}-negative`,
          },
          {
            id: `${shardSlug}-a11y`,
            label: `@p2 Accessibility & State Interruption Check on ${shardRoute} (accessibility-audit)`,
            charter: 'accessibility-audit',
            command: `npx cortex orchestrate --explore start --shard ${shardSlug} --scenario ${shardSlug}-a11y`,
          },
        ],
      },
    };
  } else if ((counts.domainShards || 0) === 0 && (counts.automatedSpecs || 0) === 0 && (counts.recordedTapes || 0) === 0) {
    maturityStage = 'Stage 0 — Initial Route & Feature Shard Discovery';
    const baseUrlClean = coverage.targetApp?.baseUrl || 'http://localhost:3000';
    nextAction = {
      priority: 5,
      skill: '00-env-bootstrap',
      why: `Target URL (${baseUrlClean}) is configured, but 0 domain shards or specs exist yet. Discover top-level routes to seed feature shards.`,
      command: `npx cortex orchestrate --bootstrap --discover-shards`,
      autoRunnable: false,
      humanGate: 'Run live route discovery or select initial route to explore.',
      gatePayload: {
        gateId: 'stage0-discover-shards',
        question: `No feature shards exist yet for ${coverage.targetApp?.appName || 'Target App'} (${baseUrlClean}). How should agentic-solid-qe initialize coverage?`,
        options: [
          {
            id: 'discover-shards',
            label: `(Recommended) Auto-discover top-level routes from ${baseUrlClean} and scaffold feature shards`,
            command: 'npx cortex orchestrate --bootstrap --discover-shards',
          },
          {
            id: 'explore-root',
            label: `Start live exploratory session directly on ${baseUrlClean}`,
            command: `npx cortex orchestrate --explore start --url ${baseUrlClean} --scenario main-p0`,
          },
        ],
      },
    };
  } else if (staleShards.length > 0 || !ciConfigured) {
    maturityStage = 'Stage 4 — CI/CD Sharding & Freshness';
    nextAction = {
      priority: 6,
      skill: !ciConfigured ? '04-ci-pipeline' : '01-cli-explorer',
      why: !ciConfigured
        ? 'All current shards are covered, but no Playwright CI workflow was detected.'
        : `${staleShards.length} domain shard(s) are stale and due for re-verification.`,
      command: !ciConfigured ? 'npx cortex orchestrate --ci-init' : 'npx cortex orchestrate --verify',
      runArgs: null,
      npmScript: 'verify',
      autoRunnable: true,
      humanGate: !ciConfigured ? 'Review generated CI pipeline workflow.' : 'None.',
      ...(!ciConfigured
        ? {
            gatePayload: {
              gateId: 'stage4-ci-init',
              question: 'All shards are covered, but CI is not configured. Generate sharded GitHub Actions Playwright CI workflow now?',
              options: [
                {
                  id: 'ci-init-github',
                  label: '(Recommended) Scaffold .github/workflows/playwright-ci.yml and run full verification gate',
                  command: 'npx cortex orchestrate --ci-init',
                },
              ],
            },
          }
        : {}),
    };
  } else {
    const rawStage = coverage.coverageMaturityStage;
    const stageNum = typeof rawStage === 'object' && rawStage ? rawStage.stage : 4;
    const handoffs = coverage.topHandoffRecommendations || coverage.handoffRecommendations || [];
    const tapeFiles = walkFiles(path.join(rootDir, '.exploratory/tapes'), (name) => name.endsWith('.json'));
    const firstTapeSlug =
      tapeFiles.length > 0 ? path.basename(tapeFiles[0], '.json') : 'baseline-flow';

    if (stageNum === 2) {
      maturityStage = 'Stage 2 — Persona, Boundary & Resilience Expansion (@smoke / @regression)';
    } else if (stageNum === 3) {
      maturityStage = 'Stage 3 — Complex Wizards, Backend API Seeding & Cross-Portal Handoffs';
    } else {
      maturityStage = 'Stage 4 — Maintained & CI-Ready';
    }

    const stageOptions = [];
    if (stageNum === 2) {
      stageOptions.push({
        id: 'stage2-clone-negative',
        label: `(Recommended) Clone '${firstTapeSlug}' into a @p1 boundary/negative variant via cortex tape clone`,
        command: `npx cortex orchestrate --tape clone ${firstTapeSlug} ${firstTapeSlug}-negative --charter boundary-analysis --tags @p1,@regression`,
      });
    }
    if (handoffs.length > 0) {
      const topH = handoffs[0];
      stageOptions.push({
        id: 'stage3-handoff-split',
        label: `Segment ${topH.stepCount}-step tape '${topH.scenarioId}' at step ${topH.suggestedSplitStep} (${topH.recommendedHandoffStrategy})`,
        command: `npx cortex orchestrate --tape show ${topH.scenarioId}`,
      });
    }
    stageOptions.push({
      id: 'verify-suite',
      label: 'Run full verification gate (tsc + domain:graph + audit:solid + validate:tapes + smoke)',
      command: 'npx cortex orchestrate --verify',
    });

    const whyParts = ['All domain shards are covered, tapes compiled, zero drift detected, and CI is configured.'];
    if (stageNum === 2) {
      whyParts.push('Ready for Stage 2 persona/boundary variant expansion.');
    } else if (stageNum === 3) {
      whyParts.push('Ready for Stage 3 enterprise wizard/API/seeder expansion.');
    }
    if (handoffs.length > 0) {
      whyParts.push(`${handoffs.length} long tape(s) eligible for Point-to-Point handoff segmentation.`);
    }

    nextAction = {
      priority: 7,
      skill: 'agentic-solid-qe',
      why: whyParts.join(' '),
      command: 'npx cortex orchestrate --verify',
      npmScript: 'verify',
      autoRunnable: true,
      humanGate:
        stageNum < 4 || handoffs.length > 0
          ? 'None — reporting verified results (optional Stage 2/3 expansion options available in GATE_OPTIONS).'
          : 'None — reporting verified results.',
      ...(stageNum < 4 || handoffs.length > 0
        ? {
            gatePayload: {
              gateId: `stage${stageNum}-expansion-advisory`,
              question: `All ${counts.domainShards || 0} shard(s) have baseline coverage (${maturityStage}). Select next optional expansion or verify:`,
              options: stageOptions,
            },
          }
        : {}),
    };
  }

  return {
    masterOrchestratorSkill: '/agentic-solid-qe',
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
      handoffRecommendations: counts.handoffRecommendations || 0,
      ciConfigured,
    },
    queuePreview: {
      uncompiledTapes: uncompiledTapes.slice(0, 10),
      uncoveredShards: uncoveredShards.slice(0, 10),
      failingArtifacts: failingArtifacts.slice(0, 5),
      handoffRecommendations: (coverage.topHandoffRecommendations || coverage.handoffRecommendations || []).slice(0, 5),
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
  const lines = [
    `CORTEX | ${bp.targetApp.appName} (${bp.targetApp.baseUrl || 'unconfigured'}) | ${bp.maturityStage}`,
    `HEALTH | shards:${h.domainShards} (uncovered:${h.uncoveredShards}, stale:${h.staleShards}) | tapes:${h.recordedTapes} (uncompiled:${h.uncompiledTapes}) | specs:${h.automatedSpecs} | legacy:${h.legacySkillsAndPrompts}r/${h.legacyCodeTestsPending}t | fails:${h.failingTestArtifacts} | ci:${h.ciConfigured ? 'ok' : 'missing'}`,
    `NEXT   | /${bp.nextAction.skill} -> ${bp.nextAction.command} [auto:${bp.nextAction.autoRunnable ? 'yes' : 'no'}]`,
    `WHY    | ${bp.nextAction.why}`,
    `GATE   | ${bp.nextAction.humanGate}`,
  ];
  const opts = bp.nextAction?.gatePayload?.options;
  if (Array.isArray(opts) && opts.length > 0) {
    lines.push(
      `GATE_OPTIONS | ${opts.map((o, i) => `[${i + 1}] ${o.label} -> ${o.command}`).join(' | ')}`
    );
  }
  return lines.join('\n');
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
  const opts = bp.nextAction?.gatePayload?.options;
  if (Array.isArray(opts) && opts.length > 0) {
    lines.push(`#### 🗳️ Gate Decision Options (Route via \`agentic-solid-qe\`)`);
    opts.forEach((o, i) => {
      lines.push(`${i + 1}. **${o.label}** — \`${o.command}\``);
    });
    lines.push(``);
  }
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

function slugifyShardId(raw) {
  return (
    String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'feature'
  );
}

/**
 * Discovers top-level routes from `baseUrl` (via HTML anchor parsing with agent-browser fallback)
 * and scaffolds `.agents/domain/shards/<feature>.md` + registers them in `domain-memory.md`.
 */
export async function discoverAndSeedLiveShards(
  rootDir = process.cwd(),
  { baseUrl = '', maxShards = 6, filterPattern = '' } = {}
) {
  const graph = buildDomainGraph({ rootDir, writeToDisk: false });
  const targetUrl = String(baseUrl || graph.targetApp?.baseUrl || '').trim();
  if (!targetUrl || targetUrl.includes('localhost:3000') || targetUrl.includes('your-app-url')) {
    throw new Error('Cannot discover live shards without a configured target URL. Pass --url <https://...>.');
  }
  const parsedBase = new URL(targetUrl);
  if (parsedBase.protocol !== 'http:' && parsedBase.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol '${parsedBase.protocol}'.`);
  }

  const discoveredLinks = [];
  const seenRoutes = new Set();
  const skipRoutes = new Set(['/', '/#', '/about', '/contact', '/privacy', '/terms', '/cdn-cgi']);

  const addCandidate = (rawHref, rawText) => {
    try {
      const resolved = new URL(rawHref, parsedBase.origin);
      if (resolved.origin !== parsedBase.origin) return;
      const routePath = resolved.pathname.replace(/\/+$/, '') || '/';
      if (routePath === '/' || skipRoutes.has(routePath)) return;
      if (/\.(js|css|png|jpg|jpeg|svg|ico|pdf|zip|xml|json)$/i.test(routePath)) return;
      if (seenRoutes.has(routePath)) return;
      const cleanLabel = String(rawText || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
      if (!cleanLabel || /^skip to/i.test(cleanLabel)) return;
      seenRoutes.add(routePath);
      discoveredLinks.push({ routePath, title: cleanLabel });
    } catch {
      /* ignore invalid href */
    }
  };

  try {
    const res = await fetch(targetUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const html = await res.text();
      for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
        addCandidate(m[1], m[2]);
      }
    }
  } catch {
    /* fallback to existing shards or root shard */
  }

  let selected = discoveredLinks;
  if (filterPattern) {
    const re = new RegExp(filterPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const filtered = selected.filter((l) => re.test(l.routePath) || re.test(l.title));
    if (filtered.length > 0) selected = filtered;
  } else {
    // Prioritize high-value authentication, form, checkout, dynamic, table, and portal routes first
    const priorityRe = /\b(login|auth|form|checkout|cart|account|profile|dynamic|table|control|dropdown|checkbox|upload|input|portal|claim|quote)\b/i;
    selected.sort((a, b) => {
      const aPri = priorityRe.test(`${a.routePath} ${a.title}`) ? 0 : 1;
      const bPri = priorityRe.test(`${b.routePath} ${b.title}`) ? 0 : 1;
      return aPri - bPri;
    });
  }

  const safeMax = Math.max(1, Math.min(20, Number(maxShards) || 6));
  const finalRoutes =
    selected.length > 0
      ? selected.slice(0, safeMax)
      : [{ routePath: parsedBase.pathname || '/', title: `${graph.targetApp?.appName || 'Main'} Landing` }];

  const shardsDir = path.join(rootDir, '.agents/domain/shards');
  fs.mkdirSync(shardsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const createdShards = [];
  const domainMemoryPath = path.join(rootDir, '.agents/domain/domain-memory.md');
  let memText = readTextSafe(domainMemoryPath);

  for (const item of finalRoutes) {
    const slug = slugifyShardId(item.title || item.routePath);
    const shardRel = `.agents/domain/shards/${slug}.md`;
    const shardAbs = path.join(rootDir, shardRel);
    if (!fs.existsSync(shardAbs)) {
      const shardContent = `# Feature Shard: ${item.title} (${item.routePath})

- **Owner Squad:** \`@org/qe-core\`
- **Last Verified:** \`${today}\`
- **Routes:** \`${item.routePath}\`
- **Published Capabilities:** *(none yet)*

## 1. Discovered Business Rules & UI Contracts
- Top-level route \`${item.routePath}\` (${item.title}) discovered during Stage 0 bootstrap.
- Ready for 1-test-at-a-time exploration via \`npx cortex orchestrate --explore start --shard ${slug}\`.
`;
      fs.writeFileSync(shardAbs, shardContent, 'utf8');
      createdShards.push({ shardId: slug, route: item.routePath, title: item.title, path: shardRel });
    }
    if (memText && !memText.includes(shardRel)) {
      const tableHeader = '| :--- | :--- | :--- | :--- | :--- |';
      const row = `| **${item.title}** | \`@org/qe-core\` | \`${item.routePath}\` | \`${shardRel}\` | Auto-discovered feature shard |`;
      if (memText.includes(tableHeader)) {
        memText = memText.replace(tableHeader, `${tableHeader}\n${row}`);
      }
    }
  }

  if (memText && fs.existsSync(domainMemoryPath)) {
    fs.writeFileSync(domainMemoryPath, memText, 'utf8');
  }
  buildDomainGraph({ rootDir, writeToDisk: true });
  return {
    targetUrl,
    discoveredTotal: discoveredLinks.length,
    createdShards,
  };
}

/**
 * Ensures `.github/workflows/playwright-ci.yml` exists for Stage 4 CI readiness via `agentic-solid-qe`.
 */
export function ensureCiPipelineConfigured(rootDir = process.cwd()) {
  const targetRel = '.github/workflows/playwright-ci.yml';
  const targetAbs = path.join(rootDir, targetRel);
  if (fs.existsSync(targetAbs)) {
    return { status: 'already-configured', file: targetRel };
  }
  const templateAbs = path.resolve(__dirname, '..', targetRel);
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  if (fs.existsSync(templateAbs)) {
    fs.copyFileSync(templateAbs, targetAbs);
  } else {
    fs.writeFileSync(
      targetAbs,
      `name: Playwright SOLID E2E CI
on:
  push:
    branches: [main, master]
  pull_request:
    branches: [main, master]

permissions:
  contents: read

jobs:
  verify-and-test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af # v4.1.0
        with:
          node-version: 22
          cache: npm
      - run: npm ci --ignore-scripts
      - run: npx --no-install playwright install --with-deps chromium
      - run: npm run verify
`,
      'utf8'
    );
  }
  return { status: 'created', file: targetRel };
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
🧠 Master Orchestrator CLI — Unified Single Entry Point (npx cortex orchestrate)

Usage:
  npx cortex orchestrate [--squad <squad>] [--json] [--compact] [--run]
  npx cortex orchestrate --loop [--max-steps 10] [--workers 4] [--fast-only] [--skip-tests] [--verify-waves] [--compact] [--json]
  npx cortex orchestrate --bootstrap [--url <url>] [--name "<App Name>"] [--reset] [--discover-shards] [--max-shards 6] [--filter <pattern>]
  npx cortex orchestrate --explore <start|act|batch|finish|status|actor|capture|checkpoint> [--shard <id>] [explore-args...]
  npx cortex orchestrate --tape <list|show|clone|patch> [tape-args...]
  npx cortex orchestrate --heal-action <dry-run|apply> [--spec <path>] [--to <locator>] [--verify-affected]
  npx cortex orchestrate --ci-init [--verify]
  npx cortex orchestrate --context [--route <r>|--squad <s>|--tape <t>|--spec <p>]
  npx cortex orchestrate --verify [--fast]
`);
    process.exit(0);
  }

  const rootDir = process.cwd();

  // 1. Unified Sub-Workflow Routing via agentic-solid-qe
  const exploreIdx = args.indexOf('--explore');
  if (exploreIdx !== -1) {
    const rest = args.slice(exploreIdx + 1);
    const subCmd = rest[0] || 'status';
    const subArgs = rest.slice(1);
    if (subCmd === 'start') {
      const shardIdx = subArgs.indexOf('--shard');
      let targetShard = null;
      if (shardIdx !== -1 && subArgs[shardIdx + 1]) {
        targetShard = subArgs[shardIdx + 1];
        subArgs.splice(shardIdx, 2);
      }
      const hasUrl = subArgs.includes('--url') || subArgs.includes('--from-spec') || subArgs.includes('--checkpoint') || subArgs.includes('--from-seed');
      if (!hasUrl || targetShard) {
        const bp = buildOrchestrationBlueprint(rootDir);
        const baseUrl = String(bp.targetApp.baseUrl || 'http://localhost:3000').replace(/\/$/, '');
        const rawCandidate = targetShard || bp.queuePreview.uncoveredShards[0] || 'main';
        const shardSlug = path.basename(String(rawCandidate), '.md').replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'main';
        let shardRoute = '/';
        const shardFile = path.join(rootDir, '.agents/domain/shards', `${shardSlug}.md`);
        if (fs.existsSync(shardFile)) {
          const m = readTextSafe(shardFile).match(/`(\/[a-zA-Z0-9._/-]*)`/);
          if (m) shardRoute = m[1];
        }
        if (!hasUrl) {
          subArgs.push('--url', `${baseUrl}${shardRoute.startsWith('/') ? shardRoute : `/${shardRoute}`}`);
        }
        if (!subArgs.includes('--scenario')) {
          subArgs.push('--scenario', `${shardSlug}-p0`);
        }
        const ctxRes = spawnSync(process.execPath, [path.join(__dirname, 'context-pack.mjs'), '--route', shardRoute], {
          cwd: rootDir,
          encoding: 'utf8',
        });
        if (ctxRes.status === 0 && ctxRes.stdout && !subArgs.includes('--json')) {
          console.log(ctxRes.stdout.trim());
        }
      }
    }
    const res = spawnSync(process.execPath, [path.join(__dirname, 'explore-session.mjs'), subCmd, ...subArgs], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    if (res.status === 0 && subCmd === 'finish' && subArgs.includes('--compile')) {
      const updatedBp = buildOrchestrationBlueprint(rootDir);
      console.log('\n' + formatCompactBlueprint(updatedBp));
    }
    process.exit(res.status ?? 0);
  }

  const tapeIdx = args.indexOf('--tape');
  if (tapeIdx !== -1) {
    const tapeArgs = args.slice(tapeIdx + 1);
    const res = spawnSync(process.execPath, [path.join(__dirname, 'tape-cli.mjs'), ...tapeArgs], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    process.exit(res.status ?? 0);
  }

  const ctxIdx = args.indexOf('--context');
  if (ctxIdx !== -1) {
    const ctxArgs = args.slice(ctxIdx + 1);
    const res = spawnSync(process.execPath, [path.join(__dirname, 'context-pack.mjs'), ...ctxArgs], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    process.exit(res.status ?? 0);
  }

  const healIdx = args.indexOf('--heal-action');
  if (healIdx !== -1) {
    const mode = args[healIdx + 1] || 'dry-run';
    const extraHealArgs = args.slice(healIdx + 2);
    const healCliArgs = mode === 'apply' ? ['--apply', ...extraHealArgs] : ['--dry-run', ...extraHealArgs];
    const res = spawnSync(process.execPath, [path.join(__dirname, 'heal-drift.mjs'), ...healCliArgs], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    if (res.status === 0 && mode === 'apply') {
      clearResolvedFailureArtifacts(rootDir);
      const updatedBp = buildOrchestrationBlueprint(rootDir);
      console.log('\n' + formatCompactBlueprint(updatedBp));
    }
    process.exit(res.status ?? 0);
  }

  if (args.includes('--ci-init')) {
    const ciRes = ensureCiPipelineConfigured(rootDir);
    console.log(`CI     | ${ciRes.status} -> ${ciRes.file}`);
    const updatedBp = buildOrchestrationBlueprint(rootDir);
    console.log(formatCompactBlueprint(updatedBp));
    process.exit(0);
  }

  if (args.includes('--verify')) {
    const isFast = args.includes('--fast');
    const vArgs = isFast ? ['--fast'] : [];
    const res = spawnSync(process.execPath, [path.join(__dirname, 'verify-fast.mjs'), ...vArgs], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    process.exit(res.status ?? 0);
  }

  if (args.includes('--bootstrap')) {
    let url = '';
    let name = '';
    let reset = args.includes('--reset');
    let discoverShards = args.includes('--discover-shards');
    let maxShards = 6;
    let filterPattern = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--url' && args[i + 1]) url = args[++i];
      else if (args[i].startsWith('--url=')) url = args[i].slice('--url='.length);
      else if (args[i] === '--name' && args[i + 1]) name = args[++i];
      else if (args[i].startsWith('--name=')) name = args[i].slice('--name='.length);
      else if (args[i] === '--max-shards' && args[i + 1]) maxShards = Number(args[++i]);
      else if (args[i] === '--filter' && args[i + 1]) filterPattern = args[++i];
    }
    if (url || name || reset) {
      const initArgs = [path.join(__dirname, 'sync-skills.mjs'), 'init', rootDir];
      if (reset) initArgs.push('--reset');
      if (url) initArgs.push('--url', url);
      if (name) initArgs.push('--name', name);
      const initRes = spawnSync(process.execPath, initArgs, { cwd: rootDir, stdio: 'inherit' });
      if (initRes.status !== 0) process.exit(initRes.status ?? 1);
    }
    if (discoverShards) {
      discoverAndSeedLiveShards(rootDir, { baseUrl: url, maxShards, filterPattern })
        .then((disc) => {
          console.log(
            `BOOT   | discovered:${disc.discoveredTotal} route(s) from ${disc.targetUrl} | seeded:${disc.createdShards.length} shard(s) (${disc.createdShards.map((s) => s.shardId).join(', ')})`
          );
          const updatedBp = buildOrchestrationBlueprint(rootDir);
          console.log(formatCompactBlueprint(updatedBp));
          process.exit(0);
        })
        .catch((err) => {
          console.error(`❌ orchestrate --bootstrap failed: ${err.message}`);
          process.exit(1);
        });
    } else {
      const updatedBp = buildOrchestrationBlueprint(rootDir);
      console.log(formatCompactBlueprint(updatedBp));
      process.exit(0);
    }
  } else {
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
    const useCompact = !jsonOut && (compactOut || isCompactMode(args));

    if (jsonOut) {
      console.log(JSON.stringify(blueprint, null, 2));
    } else if (useCompact) {
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
}

