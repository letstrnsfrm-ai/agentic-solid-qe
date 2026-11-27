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
import { appendOntologyGateOptions } from './lib/ontology.mjs';
import { buildDomainGraph } from './build-domain-graph.mjs';
import { compileSessionTape, finalizeBatchDomainRefresh } from './compile-tape.mjs';
import { analyzeAndHealDrift, healDriftWithGuardrail } from './heal-drift.mjs';
import { isCompactMode } from './lib/cli-output.mjs';
import { discoverLegacyTests, MIGRATION_MANIFEST_REL_PATH } from './legacy-test-migrator.mjs';
import {
  selectNextWaveBatch,
  executeWaveBatch,
  generateMigrationDashboard,
} from './migration-wave-factory.mjs';
import { runFastVerify } from './verify-fast.mjs';
import {
  AUTONOMOUS_LEDGER_REL_PATH,
  loadAutonomousSession,
  saveAutonomousSession,
  startAutonomousSession,
  resumeAutonomousSession,
  stopAutonomousSession,
  recordAutonomousDecision,
  quarantineAutonomousItem,
  isItemQuarantined,
  detectHardBlocker,
  checkAutonomousLimits,
  rankAndSelectGateOption,
  isObjectiveComplete,
  formatLiveDecisionUpdate,
  formatCheckinDigest,
} from './lib/autonomous-mode.mjs';

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
          const failedTest = (spec.tests || []).some((t) => {
            const results = Array.isArray(t.results) ? t.results : [];
            if (results.length === 0) return false;
            const last = results[results.length - 1];
            return last && (last.status === 'failed' || last.status === 'timedOut');
          });
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
  const manifestPath = path.join(rootDir, MIGRATION_MANIFEST_REL_PATH);
  const manifestRaw = readTextSafe(manifestPath);
  if (manifestRaw) {
    try {
      const mm = JSON.parse(manifestRaw);
      if (Array.isArray(mm.ledger) || Array.isArray(mm.wave0Prereqs)) {
        const pendingLedger = (mm.ledger || []).filter((i) => i.status === 'pending');
        const pendingWave0 = (mm.wave0Prereqs || []).filter((w) => w.status === 'pending');
        legacyCodeTests = [...pendingWave0, ...pendingLedger];
      } else if (Array.isArray(mm.items)) {
        legacyCodeTests = mm.items.filter((i) => i.status !== 'compiled');
      } else if (mm.items && typeof mm.items === 'object') {
        legacyCodeTests = Object.values(mm.items).filter((i) => i.status !== 'compiled');
      }
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
            command: `npx cortex orchestrate --explore start --url ${
              /^https?:\/\/[^\s"'`;|&$<>\\]+$/i.test(String(coverage.targetApp?.baseUrl || '').trim())
                ? String(coverage.targetApp.baseUrl).trim()
                : 'http://localhost:3000'
            } --headed`,
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
    try {
      assertNoSymlinkEscape(rootDir, waveManifestPath, 'migration-manifest.json');
      const rawWave = readTextSafe(waveManifestPath);
      if (rawWave) waveManifest = JSON.parse(rawWave);
    } catch {
      waveManifest = null;
    }
    const pendingWave0 = (waveManifest?.wave0Prereqs || []).filter((w) => w.status === 'pending');
    const pendingLedger = (waveManifest?.ledger || []).filter((e) => e.status === 'pending');
    const useWaveFactory = pendingWave0.length > 0 || pendingLedger.length > 0 || legacyCodeTests.length >= 10;

    if (useWaveFactory) {
      const rawWaveNum = pendingWave0.length > 0 ? 0 : (pendingLedger[0]?.wave ?? 1);
      const targetWave = Number.isInteger(Number(rawWaveNum)) && Number(rawWaveNum) >= 0 ? Number(rawWaveNum) : 1;
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
    try {
      const shardFull = assertNoSymlinkEscape(rootDir, path.resolve(rootDir, String(rawShardPath)), 'shard path');
      if (fs.existsSync(shardFull)) {
        const m = readTextSafe(shardFull).match(/`(\/[a-zA-Z0-9._/-]*)`/);
        if (m) shardRoute = m[1];
      }
    } catch {
      shardRoute = '/';
    }
    const rawBase = String(coverage.targetApp?.baseUrl || '').trim().replace(/\/$/, '');
    const baseUrlClean = /^https?:\/\/[^\s"'`;|&$<>\\]+$/i.test(rawBase) ? rawBase : 'http://localhost:3000';
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
    const rawBase = String(coverage.targetApp?.baseUrl || '').trim();
    const baseUrlClean = /^https?:\/\/[^\s"'`;|&$<>\\]+$/i.test(rawBase) ? rawBase : 'http://localhost:3000';
    const appNameClean = String(coverage.targetApp?.appName || 'Target App').replace(/[\r\n\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, ' ').trim() || 'Target App';
    nextAction = {
      priority: 5,
      skill: '00-env-bootstrap',
      why: `Target URL (${baseUrlClean}) is configured, but 0 domain shards or specs exist yet. Discover top-level routes to seed feature shards.`,
      command: `npx cortex orchestrate --bootstrap --discover-shards`,
      autoRunnable: false,
      humanGate: 'Run live route discovery or select initial route to explore.',
      gatePayload: {
        gateId: 'stage0-discover-shards',
        question: `No feature shards exist yet for ${appNameClean} (${baseUrlClean}). How should agentic-solid-qe initialize coverage?`,
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
      runArgs: !ciConfigured ? [path.join(__dirname, 'orchestrate.mjs'), '--ci-init'] : null,
      npmScript: !ciConfigured ? null : 'verify',
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
    const rawFirstSlug = tapeFiles.length > 0 ? path.basename(tapeFiles[0], '.json') : 'baseline-flow';
    const firstTapeSlug = /^[a-z0-9][a-z0-9-]*$/.test(rawFirstSlug) ? rawFirstSlug : 'baseline-flow';

    if (stageNum === 2) {
      maturityStage = 'Stage 2 — Persona, Boundary & Resilience Expansion (@smoke / @regression)';
    } else if (stageNum === 3) {
      maturityStage = 'Stage 3 — Complex Wizards, Backend API Seeding & Cross-Portal Handoffs';
    } else {
      maturityStage = 'Stage 4 — Maintained & CI-Ready';
    }

    const stageOptions = [];
    const whyParts = ['All domain shards are covered, tapes compiled, zero drift detected, and CI is configured.'];
    const hasOntologyGaps = appendOntologyGateOptions(coverage, stageOptions, whyParts);
    if (stageNum === 2) {
      stageOptions.push({
        id: 'stage2-clone-negative',
        label: `${hasOntologyGaps ? '' : '(Recommended) '}Clone '${firstTapeSlug}' into a @p1 boundary/negative variant via cortex tape clone`,
        command: `npx cortex orchestrate --tape clone ${firstTapeSlug} ${firstTapeSlug}-negative --charter boundary-analysis --tags @p1,@regression`,
      });
    }
    if (handoffs.length > 0) {
      const topH = handoffs[0];
      const safeScenarioId = /^[a-z0-9][a-z0-9-]*$/.test(String(topH?.scenarioId || '')) ? String(topH.scenarioId) : firstTapeSlug;
      stageOptions.push({
        id: 'stage3-handoff-split',
        label: `Segment ${Number(topH.stepCount) || 0}-step tape '${safeScenarioId}' at step ${Number(topH.suggestedSplitStep) || 1} (${String(topH.recommendedHandoffStrategy || 'api-seed').replace(/[^a-z0-9_-]/gi, '')})`,
        command: `npx cortex orchestrate --tape show ${safeScenarioId}`,
      });
    }
    stageOptions.push({
      id: 'verify-suite',
      label: 'Run full verification gate (tsc + domain:graph + audit:solid + validate:tapes + smoke)',
      command: 'npx cortex orchestrate --verify',
    });
    if (stageNum === 2) whyParts.push('Ready for Stage 2 persona/boundary variant expansion.');
    else if (stageNum === 3) whyParts.push('Ready for Stage 3 enterprise wizard/API/seeder expansion.');
    if (handoffs.length > 0) whyParts.push(`${handoffs.length} long tape(s) eligible for Point-to-Point handoff segmentation.`);

    const hasExpansionOptions = stageNum < 4 || handoffs.length > 0 || hasOntologyGaps;
    nextAction = {
      priority: 7,
      skill: 'agentic-solid-qe',
      why: whyParts.join(' '),
      command: 'npx cortex orchestrate --verify',
      npmScript: 'verify',
      autoRunnable: true,
      humanGate: hasExpansionOptions
        ? 'None — reporting verified results (optional Stage 2/3 & Ontology expansion options available in GATE_OPTIONS).'
        : 'None — reporting verified results.',
      ...(hasExpansionOptions
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

const MAX_DISCOVERY_HTML_BYTES = 2 * 1024 * 1024; // 2 MB cap

function sanitizeMarkdownInline(raw, maxLen = 120) {
  return String(raw ?? '')
    .replace(/[\r\n\t\x00-\x1f\x7f\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/[`|<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function assertNoSymlinkEscape(rootDir, targetPath, label = 'path') {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Security Error: Path traversal detected for ${label}: '${targetPath}'.`);
  }
  let cur = resolvedTarget;
  while (cur !== resolvedRoot) {
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        throw new Error(
          `Security Error: Refusing symlinked path for ${label}: '${path.relative(resolvedRoot, cur)}'.`
        );
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (fs.existsSync(resolvedRoot)) {
    const realRoot = fs.realpathSync(resolvedRoot);
    let existing = resolvedTarget;
    while (!fs.existsSync(existing) && existing !== resolvedRoot) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const realExisting = fs.realpathSync(existing);
    const realRel = path.relative(realRoot, realExisting);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`Security Error: Realpath escapes workspace root for ${label}.`);
    }
  }
  return resolvedTarget;
}

async function readBoundedResponseText(res, maxBytes = MAX_DISCOVERY_HTML_BYTES) {
  const contentLength = Number(res.headers?.get?.('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`Security Error: Discovery HTML response exceeds ${maxBytes}-byte safety cap.`);
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    return text.slice(0, maxBytes);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

/**
 * Discovers top-level routes from `baseUrl` (via HTML anchor parsing with agent-browser fallback)
 * and scaffolds `.agents/domain/shards/<feature>.md` + registers them in `domain-memory.md`.
 */
export async function discoverAndSeedLiveShards(
  rootDir = process.cwd(),
  { baseUrl = '', maxShards = 6, filterPattern = '' } = {}
) {
  const { assertSafeTargetHttpUrl, assertSafeResolvedCloudTarget, safePinnedHttpRequest } = await import('./report-cloud.mjs');
  const graph = buildDomainGraph({ rootDir, writeToDisk: false });
  const rawTargetUrl = String(baseUrl || graph.targetApp?.baseUrl || '').trim();
  if (!rawTargetUrl || rawTargetUrl.includes('localhost:3000') || rawTargetUrl.includes('your-app-url')) {
    throw new Error('Cannot discover live shards without a configured target URL. Pass --url <https://...>.');
  }
  const targetUrl = assertSafeTargetHttpUrl(rawTargetUrl, { label: 'live shard discovery URL' });
  const allowPrivateNet =
    process.env.CORTEX_ALLOW_PRIVATE_NET === '1' || process.env.CORTEX_ALLOW_PRIVATE_NET === 'true';
  let pinnedTarget = await assertSafeResolvedCloudTarget(targetUrl, { allowPrivateNet });
  const parsedBase = new URL(targetUrl);
  const discoveredLinks = [];
  const seenRoutes = new Set();
  const skipRoutes = new Set(['/', '/#', '/about', '/contact', '/privacy', '/terms', '/cdn-cgi']);

  const addCandidate = (rawHref, rawText, baseHref) => {
    try {
      const activeBase = new URL(baseHref);
      const resolved = new URL(rawHref, activeBase);
      if (resolved.origin !== activeBase.origin) return;
      const routePath = sanitizeMarkdownInline(resolved.pathname.replace(/\/+$/, '') || '/', 160);
      if (!routePath.startsWith('/') || routePath === '/' || skipRoutes.has(routePath)) return;
      if (/\.(js|css|png|jpg|jpeg|svg|ico|pdf|zip|xml|json)$/i.test(routePath)) return;
      if (seenRoutes.has(routePath)) return;
      const cleanLabel = sanitizeMarkdownInline(
        String(rawText || '')
          .replace(/<[^>]+>/g, '')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&'),
        80
      );
      if (!cleanLabel || /^skip to/i.test(cleanLabel)) return;
      seenRoutes.add(routePath);
      discoveredLinks.push({ routePath, title: cleanLabel });
    } catch {
      /* ignore invalid href */
    }
  };

  const addSpaCandidate = (rawId, rawLabel) => {
    const cleanLabel = sanitizeMarkdownInline(
      String(rawLabel || '')
        .replace(/<[^>]+>/g, '')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&'),
      60
    );
    if (!cleanLabel || cleanLabel.length < 2 || cleanLabel.length > 60 || /^skip to/i.test(cleanLabel)) return;
    const slug = slugifyShardId(rawId || cleanLabel);
    if (!slug || slug === 'home' || slug === 'root') return;
    const routePath = `/#${slug}`;
    if (seenRoutes.has(routePath)) return;
    seenRoutes.add(routePath);
    discoveredLinks.push({ routePath, title: cleanLabel });
  };

  try {
    let fetchUrl = targetUrl;
    for (let hop = 0; hop < 3; hop++) {
      const res = await safePinnedHttpRequest(fetchUrl, {
        method: 'GET',
        timeoutMs: 10_000,
        pinnedTarget,
        maxBytes: MAX_DISCOVERY_HTML_BYTES,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = typeof res.headers?.location === 'string' ? res.headers.location : '';
        if (!loc) break;
        const nextUrl = assertSafeTargetHttpUrl(new URL(loc, fetchUrl).toString(), {
          label: 'redirected discovery URL',
        });
        pinnedTarget = await assertSafeResolvedCloudTarget(nextUrl, { allowPrivateNet });
        fetchUrl = nextUrl;
        continue;
      }
      if (res.ok) {
        const html = res.bodyBuffer.toString('utf8').slice(0, MAX_DISCOVERY_HTML_BYTES);
        for (const m of html.matchAll(/<a\b[^>]{0,400}?\bhref\s*=\s*["']([^"'#]{1,300})["'][^>]{0,400}?>((?:(?!<\/a>)[\s\S]){0,400}?)<\/a>/gi)) {
          addCandidate(m[1], m[2], fetchUrl);
        }
        // SPA fallback / supplement: hash routes, ARIA tabs, modal triggers, and top-level radio view toggles (#29)
        if (discoveredLinks.length === 0) {
          for (const m of html.matchAll(/<a\b[^>]{0,400}?\bhref\s*=\s*["']#\/?([^"']{1,200})["'][^>]{0,400}?>((?:(?!<\/a>)[\s\S]){0,400}?)<\/a>/gi)) {
            addSpaCandidate(m[1], m[2]);
          }
          for (const m of html.matchAll(/<(?:button|a|div|li)\b[^>]{0,400}?\brole\s*=\s*["']tab["'][^>]{0,400}?>((?:(?!<\/(?:button|a|div|li)>)[\s\S]){0,400}?)<\/(?:button|a|div|li)>/gi)) {
            addSpaCandidate('', m[1]);
          }
          for (const m of html.matchAll(/<button\b[^>]{0,400}?\b(?:data-tab|data-modal|data-target|aria-controls)\s*=\s*["']#?([^"']{1,200})["'][^>]{0,400}?>((?:(?!<\/button>)[\s\S]){0,400}?)<\/button>/gi)) {
            addSpaCandidate(m[1], m[2]);
          }
          for (const m of html.matchAll(/<label\b[^>]{0,400}?>(?:(?!(?:<\/label>))[\s\S]){0,1000}?<input\b[^>]{0,400}?\btype\s*=\s*["']radio["'][^>]{0,400}?>((?:(?!(?:<\/label>))[\s\S]){0,500}?)<\/label>/gi)) {
            addSpaCandidate('', m[1]);
          }
        }
      }
      break;
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
      : [
          {
            routePath: sanitizeMarkdownInline(parsedBase.pathname || '/', 160) || '/',
            title: sanitizeMarkdownInline(`${graph.targetApp?.appName || 'Main'} Landing`, 80),
          },
        ];

  const shardsDir = assertNoSymlinkEscape(rootDir, path.join(rootDir, '.agents/domain/shards'), 'domain shards directory');
  fs.mkdirSync(shardsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const createdShards = [];
  const domainMemoryPath = assertNoSymlinkEscape(
    rootDir,
    path.join(rootDir, '.agents/domain/domain-memory.md'),
    'domain-memory.md'
  );
  let memText = readTextSafe(domainMemoryPath);

  for (const item of finalRoutes) {
    const safeTitle = sanitizeMarkdownInline(item.title, 80) || 'Feature';
    const safeRoute = sanitizeMarkdownInline(item.routePath, 160) || '/';
    const slug = slugifyShardId(safeTitle || safeRoute);
    const shardRel = `.agents/domain/shards/${slug}.md`;
    const shardAbs = assertNoSymlinkEscape(rootDir, path.join(rootDir, shardRel), shardRel);
    if (!fs.existsSync(shardAbs)) {
      const shardContent = `# Feature Shard: ${safeTitle} (${safeRoute})

- **Owner Squad:** \`@org/qe-core\`
- **Last Verified:** \`${today}\`
- **Routes:** \`${safeRoute}\`
- **Published Capabilities:** *(none yet)*

## 1. Discovered Business Rules & UI Contracts
- Top-level route \`${safeRoute}\` (${safeTitle}) discovered during Stage 0 bootstrap.
- Ready for 1-test-at-a-time exploration via \`npx cortex orchestrate --explore start --shard ${slug}\`.
`;
      fs.writeFileSync(shardAbs, shardContent, 'utf8');
      createdShards.push({ shardId: slug, route: safeRoute, title: safeTitle, path: shardRel });
    }
    if (memText && !memText.includes(shardRel)) {
      const tableHeader = '| :--- | :--- | :--- | :--- | :--- |';
      const row = `| **${safeTitle}** | \`@org/qe-core\` | \`${safeRoute}\` | \`${shardRel}\` | Auto-discovered feature shard |`;
      if (memText.includes(tableHeader)) {
        memText = memText.replace(tableHeader, () => `${tableHeader}\n${row}`);
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
  const targetAbs = assertNoSymlinkEscape(rootDir, path.join(rootDir, targetRel), targetRel);
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
        with:
          persist-credentials: false
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

      const isSharedTarget = Boolean(triage?.blastRadius?.isShared);
      const applied = isSharedTarget
        ? await healDriftWithGuardrail(rootDir, {
            apply: true,
            verifyAffected: !skipTests,
            forceShared: true,
          })
        : analyzeAndHealDrift(rootDir, { apply: true });
      const affectedSpecs = [];
      if (applied?.specPath && /^tests\/[a-zA-Z0-9_./-]+\.spec\.ts$/.test(applied.specPath)) {
        affectedSpecs.push(applied.specPath);
        mutatedSpecs.add(applied.specPath);
      }
      didMutate = true;

      const vRes =
        isSharedTarget && !skipTests
          ? { ok: applied.status === 'healed', failedStage: applied.status === 'healed' ? null : { stage: applied.status }, totalMs: 0 }
          : applied.status !== 'healed'
            ? { ok: false, failedStage: { stage: applied.status }, totalMs: 0 }
            : await runFastVerify({
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
      let rawManifest = '';
      try {
        assertNoSymlinkEscape(rootDir, manifestPath, 'migration-manifest.json');
        rawManifest = readTextSafe(manifestPath);
      } catch {
        rawManifest = '';
      }
      if (!rawManifest) {
        stoppedReason = 'human-gate';
        humanGate = 'Run cortex wave --scan <legacy-dir> to initialize the migration ledger.';
        break;
      }
      const manifest = JSON.parse(rawManifest);
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

    if (bp.nextAction.skill === '04-ci-pipeline') {
      const ciRes = ensureCiPipelineConfigured(rootDir);
      didMutate = didMutate || ciRes.status === 'created';
      stepsExecuted.push({
        step: stepIdx + 1,
        skill: '04-ci-pipeline',
        action: ciRes.status,
        file: ciRes.file,
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

/**
 * Execute a single Fully Autonomous decision & execution cycle (`npx cortex orchestrate --autonomous step`).
 *
 * - Enforces check-in interval soft-pauses (`30m`/`1h`/`2h`) and runtime/cycle caps.
 * - Auto-decides routine gates aligned with user objectives (`focus`, `routes`, `goal`).
 * - Executes safe deterministic steps in-process (heal, compile, discover-shards, ci-init, waves).
 * - Logs/quarantines app regressions or ambiguous drift and continues on remaining unblocked shards.
 * - Hard-pauses immediately ONLY on MFA/CAPTCHA/auth expiry or unconfigured target URL.
 * - Delegates live browser exploration (`01-cli-explorer`) to the host LLM with exact command & rationale.
 */
export async function runAutonomousStep(
  rootDir = process.cwd(),
  {
    apply = true,
    workers = 4,
    skipTests = false,
    quiet = false,
    nowMs = Date.now(),
  } = {}
) {
  const session = loadAutonomousSession(rootDir);
  if (!session) {
    throw new Error(
      'No active autonomous session. Start one with: npx cortex orchestrate --autonomous start --goal "<objective>" --interval 1h'
    );
  }

  const squad = session.objectives?.squad || null;
  const safeWorkers = Math.max(1, Math.min(32, Number.isFinite(Number(workers)) ? Math.floor(Number(workers)) : 4));

  if (session.status === 'paused-checkin') {
    const bp = buildOrchestrationBlueprint(rootDir, { squad });
    const digest = formatCheckinDigest(session, bp, { trigger: 'checkin-interval', nowMs });
    if (!quiet) console.log(digest);
    return { status: 'paused-checkin', action: 'checkin-pause', digest, session, blueprint: bp };
  }
  if (session.status === 'stopped' || session.status === 'completed') {
    const bp = buildOrchestrationBlueprint(rootDir, { squad });
    const digest = formatCheckinDigest(session, bp, { trigger: session.status, nowMs });
    if (!quiet) console.log(digest);
    return { status: session.status, action: session.status, digest, session, blueprint: bp };
  }

  // 1. Check schedule & guardrail limits (soft-pause at check-in interval, max runtime, max cycles)
  const limits = checkAutonomousLimits(session, nowMs);
  if (limits.limitHit) {
    const bp = buildOrchestrationBlueprint(rootDir, { squad });
    session.lastSnapshot = bp.healthSnapshot;
    if (limits.type === 'checkin-interval') {
      session.checkinCount = (session.checkinCount || 0) + 1;
    }
    session.status = 'paused-checkin';
    recordAutonomousDecision(
      rootDir,
      session,
      {
        cycle: session.cycleCount,
        gateId: limits.type,
        skill: 'agentic-solid-qe',
        action: 'checkin-pause',
        chosenOptionId: limits.type,
        chosenLabel: limits.message,
        rationale: `Soft-pause triggered (${limits.type}) for user progress inspection and optional objective steering.`,
        outcome: 'paused-checkin',
      },
      { nowMs }
    );
    const digest = formatCheckinDigest(session, bp, { trigger: limits.type, message: limits.message, nowMs });
    if (!quiet) console.log(digest);
    return { status: 'paused-checkin', action: limits.type, digest, session, blueprint: bp };
  }

  const bp = buildOrchestrationBlueprint(rootDir, { squad });
  session.lastSnapshot = bp.healthSnapshot;

  // 2. Check if stated objectives are already achieved
  const completion = isObjectiveComplete(bp, session);
  if (completion.complete) {
    let finalVerify = null;
    if (apply && !skipTests) {
      finalVerify = await runFastVerify({
        rootDir,
        fast: false,
        skipTests: false,
        withEngine: false,
        skipMap: false,
        workers: safeWorkers,
        quiet: true,
      });
    }
    if (finalVerify && !finalVerify.ok) {
      // Verification failed -> record decision and return so next cycle triages/heals with fresh blueprint instead of double-verifying
      session.cycleCount = (session.cycleCount || 0) + 1;
      const failedStageName =
        typeof finalVerify.failedStage === 'string'
          ? finalVerify.failedStage
          : finalVerify.failedStage?.stage || 'tests';
      const isStaticGate = ['typecheck', 'auditSolid', 'validateTapes', 'domainGraph'].includes(failedStageName);
      const updatedBp = buildOrchestrationBlueprint(rootDir, { squad });
      const decision = recordAutonomousDecision(
        rootDir,
        session,
        {
          cycle: session.cycleCount,
          gateId: 'final-verify',
          skill: isStaticGate ? 'agentic-solid-qe' : '03-drift-healer',
          action: 'final-verify-failed',
          chosenOptionId: isStaticGate ? 'pause-static-gate' : 'triage-next-cycle',
          chosenLabel: `Final verification failed at ${failedStageName}`,
          rationale: isStaticGate
            ? `Static gate '${failedStageName}' failed; pausing for human review rather than spinning.`
            : 'Deferring completion so next autonomous cycle can triage/heal with fresh failure artifacts.',
          outcome: `failed:${failedStageName}`,
        },
        { nowMs }
      );
      if (isStaticGate) {
        session.status = 'paused-checkin';
        saveAutonomousSession(rootDir, session);
        const digest = formatCheckinDigest(session, updatedBp, {
          trigger: 'checkin-interval',
          message: `Final verification failed at static gate '${failedStageName}'.`,
          nowMs,
        });
        if (!quiet) console.log(digest);
        return { status: 'paused-checkin', action: 'final-verify-failed', decision, verify: finalVerify, digest, session, blueprint: updatedBp };
      }
      return { status: 'active', action: 'final-verify-failed', decision, verify: finalVerify, session, blueprint: updatedBp };
    } else {
      session.status = 'completed';
      recordAutonomousDecision(
        rootDir,
        session,
        {
          cycle: session.cycleCount,
          gateId: 'objective-complete',
          skill: 'agentic-solid-qe',
          action: 'completed',
          chosenOptionId: 'complete',
          chosenLabel: completion.reason,
          rationale: 'All unblocked objectives met and verified.',
          outcome: 'completed',
        },
        { nowMs }
      );
      const digest = formatCheckinDigest(session, bp, { trigger: 'completed', message: completion.reason, nowMs });
      if (!quiet) console.log(digest);
      return { status: 'completed', action: 'completed', digest, finalVerify, session, blueprint: bp };
    }
  }

  // 3. Hard-blocker check (ONLY MFA/CAPTCHA/auth expiry or unconfigured target URL)
  const blocker = detectHardBlocker(bp);
  if (blocker.blocked) {
    session.status = 'paused-blocker';
    recordAutonomousDecision(
      rootDir,
      session,
      {
        cycle: session.cycleCount,
        gateId: blocker.gateId,
        skill: bp.nextAction.skill,
        action: 'blocker-pause',
        chosenOptionId: blocker.gateId,
        chosenLabel: blocker.reason,
        command: bp.nextAction.command,
        rationale: 'Hard blocker requires human credentials/MFA/URL before autonomous execution can continue.',
        outcome: 'paused-blocker',
      },
      { nowMs }
    );
    const digest = formatCheckinDigest(session, bp, { trigger: 'blocker', message: blocker.reason, nowMs });
    if (!quiet) console.log(digest);
    return { status: 'paused-blocker', action: 'blocker-pause', blocker, digest, session, blueprint: bp };
  }

  // 4. Advance cycle & rank options against user objectives
  const fp = computeBlueprintFingerprint(bp);
  const repeatedFp = Array.isArray(session.seenFingerprints) && session.seenFingerprints.includes(fp);
  session.cycleCount = (session.cycleCount || 0) + 1;
  session.lastFingerprint = fp;
  session.seenFingerprints = [...(session.seenFingerprints || []).slice(-24), fp];

  const ranked = rankAndSelectGateOption(bp, session);
  if (ranked.allQuarantined || !ranked.chosen) {
    session.status = 'paused-checkin';
    const msg = ranked.rationale || 'All remaining candidate items are quarantined; user review requested.';
    recordAutonomousDecision(
      rootDir,
      session,
      {
        cycle: session.cycleCount,
        gateId: bp.nextAction?.gatePayload?.gateId || 'all-quarantined',
        skill: bp.nextAction.skill,
        action: 'checkin-pause',
        chosenOptionId: 'all-quarantined',
        chosenLabel: msg,
        rationale: msg,
        outcome: 'paused-checkin',
      },
      { nowMs }
    );
    const digest = formatCheckinDigest(session, bp, { trigger: 'checkin-interval', message: msg, nowMs });
    if (!quiet) console.log(digest);
    return { status: 'paused-checkin', action: 'all-quarantined', digest, session, blueprint: bp };
  }

  if (repeatedFp && bp.nextAction.skill !== '01-cli-explorer') {
    const key = `${bp.nextAction.skill}:${ranked.chosen.id || 'action'}`;
    quarantineAutonomousItem(rootDir, session, {
      key,
      reason: `State fingerprint did not advance after previous cycle (${fp}).`,
      category: 'repeated-failure',
      nowMs,
    });
    const decision = recordAutonomousDecision(
      rootDir,
      session,
      {
        cycle: session.cycleCount,
        gateId: 'cycle-guard',
        skill: bp.nextAction.skill,
        action: 'quarantined',
        chosenOptionId: key,
        chosenLabel: `Quarantined non-advancing action '${key}'`,
        rationale: 'Circuit breaker prevented infinite loop; continuing with remaining work.',
        alternatives: ranked.alternatives,
        outcome: 'quarantined',
      },
      { nowMs }
    );
    const liveUpdate = formatLiveDecisionUpdate(decision, session, bp, nowMs);
    if (!quiet) console.log(liveUpdate);
    return { status: 'active', action: 'quarantined', decision, liveUpdate, session, blueprint: bp };
  }

  const maxFail = session.guardrails?.maxConsecutiveShardFailures || 3;
  const gateId = bp.nextAction?.gatePayload?.gateId || bp.nextAction.skill;

  // 5A. Deterministic: 03-drift-healer (auto-heal high-confidence drift; quarantine regressions/ambiguous drift & continue)
  if (apply && bp.nextAction.skill === '03-drift-healer') {
    const triage = analyzeAndHealDrift(rootDir, { apply: false });
    const triageBlocker = detectHardBlocker(bp, triage);
    if (triageBlocker.blocked) {
      session.status = 'paused-blocker';
      recordAutonomousDecision(
        rootDir,
        session,
        {
          cycle: session.cycleCount,
          gateId: triageBlocker.gateId,
          skill: '03-drift-healer',
          action: 'blocker-pause',
          chosenOptionId: 'auth-drift',
          chosenLabel: triageBlocker.reason,
          rationale: 'Authentication session expired; interactive re-login required.',
          outcome: 'paused-blocker',
        },
        { nowMs }
      );
      const digest = formatCheckinDigest(session, bp, { trigger: 'blocker', message: triageBlocker.reason, nowMs });
      if (!quiet) console.log(digest);
      return { status: 'paused-blocker', action: 'blocker-pause', blocker: triageBlocker, digest, session, blueprint: bp };
    }

    const isHighConfDrift = triage?.rootCause?.category === 'locator-drift' && triage?.autoHealReady === true;
    if (!isHighConfDrift) {
      const targetKey = `spec:${triage?.specPath || bp.queuePreview?.failingArtifacts?.[0]?.title || 'failing-spec'}`;
      const category = triage?.rootCause?.category === 'app-regression' ? 'app-regression' : 'ambiguous-drift';
      quarantineAutonomousItem(rootDir, session, {
        key: targetKey,
        reason: `${category} detected (confidence ${triage?.rootCause?.confidence ?? 'low'}) — logged & quarantined so autonomous run continues on unblocked shards.`,
        category,
        nowMs,
      });
      clearResolvedFailureArtifacts(rootDir);
      const updatedBp = buildOrchestrationBlueprint(rootDir, { squad });
      const decision = recordAutonomousDecision(
        rootDir,
        session,
        {
          cycle: session.cycleCount,
          gateId,
          skill: '03-drift-healer',
          action: 'quarantined',
          chosenOptionId: targetKey,
          chosenLabel: `Quarantined ${category} (${targetKey}) and continued`,
          rationale: `Policy: log & quarantine ${category} instead of blocking remaining shards until check-in.`,
          alternatives: ranked.alternatives,
          outcome: 'quarantined',
        },
        { nowMs }
      );
      const liveUpdate = formatLiveDecisionUpdate(decision, session, updatedBp, nowMs);
      if (!quiet) console.log(liveUpdate);
      return { status: 'active', action: 'quarantined', decision, liveUpdate, triage, session, blueprint: updatedBp };
    }

    const isSharedTarget = Boolean(triage?.blastRadius?.isShared);
    const applied = isSharedTarget
      ? await healDriftWithGuardrail(rootDir, {
          apply: true,
          verifyAffected: !skipTests,
          forceShared: true,
        })
      : analyzeAndHealDrift(rootDir, { apply: true });

    let vRes;
    if (isSharedTarget && !skipTests) {
      vRes = {
        ok: applied.status === 'healed',
        rolledBack: applied.status === 'rolled-back-regression' || applied.status === 'rolled-back',
      };
    } else if (applied.status !== 'healed') {
      vRes = { ok: false, reason: applied.status };
    } else {
      const affectedSpecs =
        applied?.specPath && /^tests\/[a-zA-Z0-9_./-]+\.spec\.ts$/.test(applied.specPath) ? [applied.specPath] : [];
      vRes = await runFastVerify({
        rootDir,
        fast: true,
        specs: affectedSpecs,
        skipTests,
        skipMap: true,
        workers: safeWorkers,
        quiet: true,
      });
    }

    let didQuarantine = false;
    if (!vRes.ok) {
      const fKey = `spec:${applied?.specPath || applied?.componentMatch?.file || 'healed-spec'}`;
      session.failureCounts[fKey] = (session.failureCounts[fKey] || 0) + 1;
      if (session.failureCounts[fKey] >= maxFail || vRes.rolledBack) {
        didQuarantine = true;
        quarantineAutonomousItem(rootDir, session, {
          key: fKey,
          reason: vRes.rolledBack
            ? `Shared-component heal rolled back due to knock-on regression in affected specs.`
            : `Auto-heal verification failed ${session.failureCounts[fKey]} consecutive time(s).`,
          category: vRes.rolledBack ? 'ambiguous-drift' : 'repeated-failure',
          nowMs,
        });
        clearResolvedFailureArtifacts(rootDir);
      }
    } else {
      clearResolvedFailureArtifacts(rootDir);
    }
    const updatedBp = buildOrchestrationBlueprint(rootDir, { squad });
    const healActionLabel = vRes.ok ? 'executed' : didQuarantine ? 'quarantined' : 'retry-failed';
    const decision = recordAutonomousDecision(
      rootDir,
      session,
      {
        cycle: session.cycleCount,
        gateId,
        skill: '03-drift-healer',
        action: healActionLabel,
        chosenOptionId: isSharedTarget ? 'heal-apply-transactional' : 'heal-apply',
        chosenLabel: vRes.ok
          ? `Auto-healed ${isSharedTarget ? 'shared ' : ''}locator drift (${applied?.componentMatch?.file || 'component'})`
          : `Heal ${vRes.rolledBack ? 'rolled back' : 'failed'} (${applied?.componentMatch?.file || 'component'})`,
        command: isSharedTarget ? 'npx cortex orchestrate --heal-action apply --verify-affected' : 'npx cortex orchestrate --heal-action apply',
        rationale: ranked.rationale,
        alternatives: ranked.alternatives,
        outcome: vRes.ok ? 'success' : 'failed',
      },
      { nowMs }
    );
    const liveUpdate = formatLiveDecisionUpdate(decision, session, updatedBp, nowMs);
    if (!quiet) console.log(liveUpdate);
    return { status: 'active', action: healActionLabel, decision, liveUpdate, verify: vRes, session, blueprint: updatedBp };
  }

  // 5B. Deterministic: 02-solid-architect (batch-compile unquarantined Session Tapes + fast verify)
  if (apply && bp.nextAction.skill === '02-solid-architect') {
    const queuedTapes = (bp.queuePreview?.uncompiledTapes || [])
      .map((t) => (typeof t === 'string' ? t : t?.scenarioId))
      .filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(String(id || '')) && !isItemQuarantined(session, `tape:${id}`));

    if (queuedTapes.length > 0) {
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
          if (specOp?.file) batchSpecs.push(specOp.file);
        } catch (err) {
          compileError = { scenarioId: sid, message: String(err.message || err).slice(0, 200) };
          const fKey = `tape:${sid}`;
          session.failureCounts[fKey] = (session.failureCounts[fKey] || 0) + 1;
          if (session.failureCounts[fKey] >= maxFail) {
            quarantineAutonomousItem(rootDir, session, {
              key: fKey,
              reason: `Tape compilation failed ${session.failureCounts[fKey]} times: ${compileError.message}`,
              category: 'repeated-failure',
              nowMs,
            });
          }
          break;
        }
      }
      if (compiledIds.length > 0) {
        finalizeBatchDomainRefresh(rootDir, { skipMap: true });
      }
      const vRes =
        !compileError && compiledIds.length > 0
          ? await runFastVerify({
              rootDir,
              fast: true,
              specs: batchSpecs,
              skipTests,
              skipMap: true,
              workers: safeWorkers,
              quiet: true,
            })
          : { ok: false };
      const updatedBp = buildOrchestrationBlueprint(rootDir, { squad });
      const decision = recordAutonomousDecision(
        rootDir,
        session,
        {
          cycle: session.cycleCount,
          gateId,
          skill: '02-solid-architect',
          action: 'executed',
          chosenOptionId: 'compile-batch',
          chosenLabel: `Compiled ${compiledIds.length} tape(s): ${compiledIds.join(', ') || 'none'}`,
          command: 'npx cortex orchestrate --loop --compact',
          rationale: ranked.rationale,
          alternatives: ranked.alternatives,
          outcome: !compileError && vRes.ok ? 'success' : 'failed',
        },
        { nowMs }
      );
      const liveUpdate = formatLiveDecisionUpdate(decision, session, updatedBp, nowMs);
      if (!quiet) console.log(liveUpdate);
      return { status: 'active', action: 'executed', decision, liveUpdate, compiledIds, verify: vRes, session, blueprint: updatedBp };
    }
  }

  // 5C. Deterministic: 00-env-bootstrap (auto-discover live shards)
  if (apply && gateId === 'stage0-discover-shards' && ranked.chosen.id === 'discover-shards') {
    const disc = await discoverAndSeedLiveShards(rootDir, {
      baseUrl: bp.targetApp.baseUrl,
      filterPattern: session.objectives.routes[0] || '',
    });
    const updatedBp = buildOrchestrationBlueprint(rootDir, { squad });
    const decision = recordAutonomousDecision(
      rootDir,
      session,
      {
        cycle: session.cycleCount,
        gateId,
        skill: '00-env-bootstrap',
        action: 'executed',
        chosenOptionId: ranked.chosen.id,
        chosenLabel: `Discovered ${disc.discoveredTotal} route(s), seeded ${disc.createdShards.length} feature shard(s)`,
        command: ranked.chosen.command,
        rationale: ranked.rationale,
        alternatives: ranked.alternatives,
        outcome: 'success',
      },
      { nowMs }
    );
    const liveUpdate = formatLiveDecisionUpdate(decision, session, updatedBp, nowMs);
    if (!quiet) console.log(liveUpdate);
    return { status: 'active', action: 'executed', decision, liveUpdate, discovery: disc, session, blueprint: updatedBp };
  }

  // 5D. Deterministic: 04-ci-pipeline (scaffold CI workflow)
  if (apply && gateId === 'stage4-ci-init') {
    const ciRes = ensureCiPipelineConfigured(rootDir);
    const updatedBp = buildOrchestrationBlueprint(rootDir, { squad });
    const decision = recordAutonomousDecision(
      rootDir,
      session,
      {
        cycle: session.cycleCount,
        gateId,
        skill: '04-ci-pipeline',
        action: 'executed',
        chosenOptionId: ranked.chosen.id,
        chosenLabel: `CI workflow ${ciRes.status}: ${ciRes.file}`,
        command: 'npx cortex orchestrate --ci-init',
        rationale: ranked.rationale,
        alternatives: ranked.alternatives,
        outcome: 'success',
      },
      { nowMs }
    );
    const liveUpdate = formatLiveDecisionUpdate(decision, session, updatedBp, nowMs);
    if (!quiet) console.log(liveUpdate);
    return { status: 'active', action: 'executed', decision, liveUpdate, ciRes, session, blueprint: updatedBp };
  }

  // 5E. Deterministic: 05-skill-migrator wave micro-batch
  if (apply && bp.nextAction.skill === '05-skill-migrator' && bp.nextAction.autoRunnable) {
    const manifestPath = path.join(rootDir, MIGRATION_MANIFEST_REL_PATH);
    let rawManifest = '';
    try {
      assertNoSymlinkEscape(rootDir, manifestPath, 'migration-manifest.json');
      rawManifest = readTextSafe(manifestPath);
    } catch {
      rawManifest = '';
    }
    if (rawManifest) {
      const manifest = JSON.parse(rawManifest);
      const pendingWave0 = (manifest.wave0Prereqs || []).filter((w) => w.status === 'pending');
      const selection = selectNextWaveBatch(manifest, {
        squad: squad || '',
        wave: pendingWave0.length > 0 ? 0 : null,
        batchSize: 5,
      });
      if (selection.batch && selection.batch.length > 0) {
        const execution = executeWaveBatch(manifest, selection, {
          projectRoot: rootDir,
          verify: !skipTests,
          workers: safeWorkers,
        });
        try {
          generateMigrationDashboard(rootDir);
        } catch {
          /* non-fatal */
        }
        const updatedBp = buildOrchestrationBlueprint(rootDir, { squad });
        const decision = recordAutonomousDecision(
          rootDir,
          session,
          {
            cycle: session.cycleCount,
            gateId,
            skill: '05-skill-migrator',
            action: 'executed',
            chosenOptionId: `wave-${execution.wave}`,
            chosenLabel: `Executed Wave ${execution.wave} micro-batch (${execution.processed} item(s))`,
            command: bp.nextAction.command,
            rationale: ranked.rationale,
            alternatives: ranked.alternatives,
            outcome: 'success',
          },
          { nowMs }
        );
        const liveUpdate = formatLiveDecisionUpdate(decision, session, updatedBp, nowMs);
        if (!quiet) console.log(liveUpdate);
        return { status: 'active', action: 'executed', decision, liveUpdate, execution, session, blueprint: updatedBp };
      }
    }
  }

  // 5F. Deterministic: Stage 2/3 verify-suite
  if (apply && ranked.chosen.id === 'verify-suite') {
    const vRes = await runFastVerify({
      rootDir,
      fast: false,
      skipTests,
      withEngine: false,
      skipMap: false,
      workers: safeWorkers,
      quiet: true,
    });
    const updatedBp = buildOrchestrationBlueprint(rootDir, { squad });
    const decision = recordAutonomousDecision(
      rootDir,
      session,
      {
        cycle: session.cycleCount,
        gateId,
        skill: 'agentic-solid-qe',
        action: 'executed',
        chosenOptionId: 'verify-suite',
        chosenLabel: `Full verification gate (${vRes.ok ? 'PASS' : 'FAIL'})`,
        command: 'npx cortex orchestrate --verify',
        rationale: ranked.rationale,
        alternatives: ranked.alternatives,
        outcome: vRes.ok ? 'success' : 'failed',
      },
      { nowMs }
    );
    const liveUpdate = formatLiveDecisionUpdate(decision, session, updatedBp, nowMs);
    if (!quiet) console.log(liveUpdate);
    return { status: 'active', action: 'executed', decision, liveUpdate, verify: vRes, session, blueprint: updatedBp };
  }

  // 6. Delegate interactive browser / LLM skill execution (e.g., 01-cli-explorer) with auto-selected decision
  const decision = recordAutonomousDecision(
    rootDir,
    session,
    {
      cycle: session.cycleCount,
      gateId,
      skill: bp.nextAction.skill,
      action: 'auto-decided',
      chosenOptionId: ranked.chosen.id || bp.nextAction.skill,
      chosenLabel: ranked.chosen.label || bp.nextAction.why,
      command: ranked.chosen.command || bp.nextAction.command,
      rationale: ranked.rationale,
      alternatives: ranked.alternatives,
      outcome: 'delegate-to-agent',
    },
    { nowMs }
  );
  const liveUpdate = formatLiveDecisionUpdate(decision, session, bp, nowMs);
  if (!quiet) {
    console.log(liveUpdate);
    console.log(`NEXT_COMMAND  | ${decision.command}`);
  }
  return {
    status: 'active',
    action: 'delegate-to-agent',
    decision,
    nextCommand: decision.command,
    liveUpdate,
    session,
    blueprint: bp,
  };
}

/**
 * Continuously chain deterministic autonomous steps until an interactive agent exploration step,
 * check-in interval soft-pause, hard blocker, completion, or `--max-steps` cap.
 */
export async function runAutonomousLoop(
  rootDir = process.cwd(),
  { maxSteps = 10, workers = 4, skipTests = false, quiet = false, nowMsFn = () => Date.now() } = {}
) {
  const safeMax = Math.max(1, Math.min(50, Math.floor(Number(maxSteps) || 10)));
  const results = [];
  let last = null;
  for (let i = 0; i < safeMax; i++) {
    last = await runAutonomousStep(rootDir, {
      apply: true,
      workers,
      skipTests,
      quiet,
      nowMs: nowMsFn(),
    });
    results.push({ action: last.action, status: last.status, decision: last.decision || null });
    if (
      last.status !== 'active' ||
      ['checkin-pause', 'checkin-interval', 'max-runtime', 'max-cycles', 'blocker-pause', 'completed', 'stopped', 'delegate-to-agent', 'all-quarantined'].includes(
        last.action
      )
    ) {
      break;
    }
  }
  return {
    mode: 'autonomous-loop',
    stepsRun: results.length,
    finalStatus: last?.status || 'unknown',
    finalAction: last?.action || 'none',
    nextCommand: last?.nextCommand || null,
    digest: last?.digest || null,
    results,
    session: last?.session || loadAutonomousSession(rootDir),
  };
}

export function resolveGateChoice(blueprint, gateId, choiceIndex) {
  const gp = blueprint?.nextAction?.gatePayload;
  if (!gp || !Array.isArray(gp.options) || gp.options.length === 0) {
    return { ok: false, error: 'No active gatePayload options available on current blueprint.' };
  }
  const activeGateId = String(gp.gateId || blueprint?.nextAction?.skill || '');
  if (gateId && activeGateId && gateId !== activeGateId) {
    return {
      ok: false,
      error: `Gate mismatch: requested '${gateId}', but active gate is '${activeGateId}'.`,
    };
  }
  const idx = Number(choiceIndex);
  if (!Number.isInteger(idx) || idx < 1 || idx > gp.options.length) {
    return {
      ok: false,
      error: `Invalid choice '${choiceIndex}'. Must be an integer between 1 and ${gp.options.length}.`,
    };
  }
  return {
    ok: true,
    gateId: activeGateId || gateId,
    choice: idx,
    option: gp.options[idx - 1],
  };
}

const DETERMINISTIC_GATE_SCRIPTS = {
  compile: 'compile-tape.mjs',
  verify: 'verify-fast.mjs',
  heal: 'heal-drift.mjs',
  graph: 'build-domain-graph.mjs',
  audit: 'audit-solid.mjs',
  gaps: 'analyze-coverage.mjs',
  tape: 'tape-cli.mjs',
  wave: 'migration-wave-factory.mjs',
};

function splitSimpleCommand(cmd) {
  const str = String(cmd || '').trim();
  if (!str) return [];
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * Executes an allowlisted deterministic `cortex` command from a resolved GATE_OPTIONS entry
 * directly via Node.js (`shell: false`). Returns `requiresAgentSeat: true` for interactive
 * browser/LLM options so deterministic runners fail cleanly instead of ping-ponging gates.
 */
export function executeSafeGateOption(rootDir, option) {
  const rawCmd = String(option?.command || '').trim();
  if (!rawCmd) {
    return { executed: false, requiresAgentSeat: true, reason: 'Gate option has no executable command.' };
  }
  if (rawCmd.toLowerCase() === 'cancel') {
    return { executed: true, canceled: true, exitCode: 0 };
  }

  const tokens = splitSimpleCommand(rawCmd);
  // Normalize optional `npx cortex <subcmd> ...` or `cortex <subcmd> ...`
  let idx = 0;
  if (tokens[idx] === 'npx') idx++;
  if (tokens[idx] === 'cortex' || tokens[idx] === 'asqe') idx++;
  const subcmd = tokens[idx];
  const restArgs = tokens.slice(idx + 1);

  if (!subcmd || !Object.hasOwn(DETERMINISTIC_GATE_SCRIPTS, subcmd)) {
    return {
      executed: false,
      requiresAgentSeat: true,
      reason: `Selected gate option '${rawCmd}' requires an agent-seat runner (not in deterministic allowlist).`,
    };
  }

  const scriptPath = path.join(__dirname, DETERMINISTIC_GATE_SCRIPTS[subcmd]);
  const res = spawnSync(process.execPath, [scriptPath, ...restArgs], {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    executed: true,
    command: rawCmd,
    exitCode: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: res.status === 0 ? null : (res.stderr || res.stdout || `Command '${rawCmd}' failed`).slice(0, 1000),
  };
}

// CLI Entrypoint
const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);
  } catch {
    return path.resolve(process.argv[1]) === path.resolve(__filename);
  }
})();
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🧠 Master Orchestrator CLI — Unified Single Entry Point (npx cortex orchestrate)

Usage:
  npx cortex orchestrate [--squad <squad>] [--json] [--compact] [--run]
  npx cortex orchestrate --loop [--max-steps 10] [--workers 4] [--fast-only] [--skip-tests] [--verify-waves] [--compact] [--json]
  npx cortex orchestrate --autonomous <start|step|loop|resume|status|stop|quarantine> [--goal "<objective>"] [--focus full|baseline|regression|migrate|heal] [--interval 30m|1h|2h] [--routes <csv>] [--max-runtime <dur>] [--max-cycles <n>] [--target-specs <n>] [--json]
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

  // 0. Fully Autonomous Mode (`npx cortex orchestrate --autonomous <subcommand>`)
  const autoIdx = args.indexOf('--autonomous');
  if (autoIdx !== -1) {
    const rest = args.slice(autoIdx + 1);
    const subCmd = rest[0] && !rest[0].startsWith('--') ? rest[0] : 'status';
    const subArgs = rest[0] && !rest[0].startsWith('--') ? rest.slice(1) : rest;
    const jsonOut = subArgs.includes('--json');

    const getFlag = (name) => {
      for (let i = 0; i < subArgs.length; i++) {
        if (subArgs[i] === name && subArgs[i + 1] !== undefined) return subArgs[i + 1];
        if (subArgs[i].startsWith(`${name}=`)) return subArgs[i].slice(name.length + 1);
      }
      return null;
    };

    try {
      if (subCmd === 'start') {
        const squadRaw = getFlag('--squad');
        const squad = squadRaw ? assertSafeSquadName(squadRaw) : null;
        const baseBp = buildOrchestrationBlueprint(rootDir, { squad });
        const started = startAutonomousSession(rootDir, {
          goal: getFlag('--goal') || undefined,
          focus: getFlag('--focus') || 'full',
          interval: getFlag('--interval') || '1h',
          routes: getFlag('--routes') || '',
          squad,
          targetStage: getFlag('--target-stage') || 4,
          targetSpecs: getFlag('--target-specs'),
          maxRuntime: getFlag('--max-runtime'),
          maxCycles: getFlag('--max-cycles') || 100,
          baselineSnapshot: baseBp.healthSnapshot,
        });
        if (jsonOut) {
          console.log(JSON.stringify({ ...started, blueprint: baseBp }, null, 2));
        } else {
          console.log(
            `AUTONOMOUS | started session ${started.session.sessionId} | focus:${started.session.objectives.focus} | check-in:${started.session.schedule.intervalLabel} (soft-pause)`
          );
          console.log(`OBJECTIVE  | ${started.session.objectives.goal}`);
          console.log(`LEDGER     | ${AUTONOMOUS_LEDGER_REL_PATH}`);
          console.log(`NEXT       | npx cortex orchestrate --autonomous loop`);
        }
        process.exit(0);
      } else if (subCmd === 'resume') {
        const updated = resumeAutonomousSession(rootDir, {
          goal: getFlag('--goal'),
          focus: getFlag('--focus'),
          interval: getFlag('--interval'),
          routes: getFlag('--routes'),
          maxRuntime: getFlag('--max-runtime'),
          maxCycles: getFlag('--max-cycles'),
          targetSpecs: getFlag('--target-specs'),
        });
        if (jsonOut) {
          console.log(JSON.stringify(updated, null, 2));
        } else {
          console.log(
            `AUTONOMOUS | resumed session ${updated.sessionId} | focus:${updated.objectives.focus} | next check-in in ${updated.schedule.intervalLabel}`
          );
          console.log(`NEXT       | npx cortex orchestrate --autonomous loop`);
        }
        process.exit(0);
      } else if (subCmd === 'stop') {
        const stopped = stopAutonomousSession(rootDir, { reason: getFlag('--reason') || 'user-stopped' });
        const bp = buildOrchestrationBlueprint(rootDir, { squad: stopped.objectives?.squad || null });
        const digest = formatCheckinDigest(stopped, bp, { trigger: 'stopped' });
        if (jsonOut) console.log(JSON.stringify({ session: stopped, digest }, null, 2));
        else console.log(digest);
        process.exit(0);
      } else if (subCmd === 'status') {
        const session = loadAutonomousSession(rootDir);
        if (!session) {
          const msg = 'No autonomous session active. Start one with: npx cortex orchestrate --autonomous start --goal "<objective>" --interval 1h';
          if (jsonOut) console.log(JSON.stringify({ active: false, message: msg }, null, 2));
          else console.log(msg);
          process.exit(0);
        }
        const bp = buildOrchestrationBlueprint(rootDir, { squad: session.objectives?.squad || null });
        const digest = formatCheckinDigest(session, bp, { trigger: 'status' });
        if (jsonOut) console.log(JSON.stringify({ active: session.status === 'active', session, digest }, null, 2));
        else console.log(digest);
        process.exit(0);
      } else if (subCmd === 'quarantine') {
        const session = loadAutonomousSession(rootDir);
        if (!session) throw new Error('No autonomous session active.');
        const key = getFlag('--key');
        const reason = getFlag('--reason') || 'Quarantined by autonomous agent';
        const category = getFlag('--category') || 'app-regression';
        const defectFile = getFlag('--defect');
        quarantineAutonomousItem(rootDir, session, { key, reason, category, defectFile });
        if (jsonOut) console.log(JSON.stringify({ quarantined: session.quarantined }, null, 2));
        else console.log(`QUARANTINE | added '${key}' (${category}) -> continuing on remaining unblocked shards.`);
        process.exit(0);
      } else if (subCmd === 'step') {
        runAutonomousStep(rootDir, {
          apply: !subArgs.includes('--dry-run'),
          workers: Number(getFlag('--workers') || 4),
          skipTests: subArgs.includes('--skip-tests'),
          quiet: jsonOut,
        })
          .then((res) => {
            if (jsonOut) console.log(JSON.stringify(res, null, 2));
            process.exit(0);
          })
          .catch((err) => {
            console.error(`❌ orchestrate --autonomous step failed: ${err.message}`);
            process.exit(1);
          });
      } else if (subCmd === 'loop') {
        runAutonomousLoop(rootDir, {
          maxSteps: Number(getFlag('--max-steps') || 10),
          workers: Number(getFlag('--workers') || 4),
          skipTests: subArgs.includes('--skip-tests'),
          quiet: jsonOut,
        })
          .then((res) => {
            if (jsonOut) console.log(JSON.stringify(res, null, 2));
            process.exit(0);
          })
          .catch((err) => {
            console.error(`❌ orchestrate --autonomous loop failed: ${err.message}`);
            process.exit(1);
          });
      } else {
        throw new Error(`Unknown --autonomous subcommand '${subCmd}'. Expected: start, step, loop, resume, status, stop, quarantine.`);
      }
    } catch (err) {
      console.error(`❌ orchestrate --autonomous ${subCmd} failed: ${err.message}`);
      process.exit(1);
    }
  } else {

  // 1. Unified Sub-Workflow Routing via agentic-solid-qe
  // Flags that change state destructively. They are stripped from args
  // forwarded to a subcommand unless that subcommand documents them as its
  // own flag — otherwise a flag meant for one command (or smuggled in as a
  // value) can be reinterpreted by another subcommand as --apply/--force.
  // (Twin of the same helper in sync-skills.mjs, which guards the CLI
  // delegate boundary.) Flags the orchestrator adds itself intentionally
  // (e.g. --apply for --heal-action apply) are added after filtering.
  const DESTRUCTIVE_FLAGS = new Set([
    '--apply',
    '--force',
    '--reset',
    '--delete',
    '--remove',
    '--overwrite',
    '--yes',
    '--purge',
    '--destroy',
    '--wipe',
    '--force-shared',
    '--force-spec',
    '--apply-patches',
    '--clean',
  ]);
  const DESTRUCTIVE_FLAG_ALLOWLIST = {
    compile: new Set(['--apply', '--force-spec']),
    // NOTE: '--apply' is deliberately NOT allowed for heal — the
    // --heal-action apply branch adds it itself, and a user-supplied
    // '--apply' forwarded here would override '--dry-run' in heal-drift
    // (args.includes('--apply')) and mutate during a dry run.
    heal: new Set(['--force-shared']),
    migrate: new Set(['--apply']),
    upgrade: new Set(['--force', '--apply-patches']),
    orchestrate: new Set(['--reset']),
  };
  const filterDelegatedArgs = (subcommand, forwardedArgs) => {
    const allowed = DESTRUCTIVE_FLAG_ALLOWLIST[subcommand] || new Set();
    const kept = [];
    for (const arg of forwardedArgs) {
      if (typeof arg === 'string' && arg.startsWith('--')) {
        const flag = arg.split('=')[0];
        if (DESTRUCTIVE_FLAGS.has(flag) && !allowed.has(flag)) {
          console.warn(
            `⚠️  Stripped '${flag}' at the '${subcommand}' boundary: it is not a documented flag of that subcommand.`
          );
          continue;
        }
      }
      kept.push(arg);
    }
    return kept;
  };

  const exploreIdx = args.indexOf('--explore');
  if (exploreIdx !== -1) {
    const rest = args.slice(exploreIdx + 1);
    const subCmd = rest[0] || 'status';
    const subArgs = rest.slice(1);
    if (subCmd === 'start') {
      const hasFlag = (name) => subArgs.some((a) => a === name || a.startsWith(`${name}=`));
      let targetShard = null;
      const shardEqIdx = subArgs.findIndex((a) => a.startsWith('--shard='));
      if (shardEqIdx !== -1) {
        targetShard = subArgs[shardEqIdx].slice('--shard='.length) || null;
        subArgs.splice(shardEqIdx, 1);
      } else {
        const shardIdx = subArgs.indexOf('--shard');
        if (shardIdx !== -1 && subArgs[shardIdx + 1]) {
          targetShard = subArgs[shardIdx + 1];
          subArgs.splice(shardIdx, 2);
        }
      }
      const hasUrl = hasFlag('--url') || hasFlag('--from-spec') || hasFlag('--checkpoint') || hasFlag('--from-seed');
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
        if (!hasFlag('--scenario')) {
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
    const res = spawnSync(process.execPath, [path.join(__dirname, 'explore-session.mjs'), subCmd, ...filterDelegatedArgs('explore', subArgs)], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    if (res.status === 0 && subCmd === 'finish' && subArgs.includes('--compile') && !subArgs.includes('--json')) {
      const updatedBp = buildOrchestrationBlueprint(rootDir);
      console.log('\n' + formatCompactBlueprint(updatedBp));
    }
    process.exit(res.status ?? 1);
  }

  const tapeIdx = args.indexOf('--tape');
  if (tapeIdx !== -1) {
    const tapeArgs = filterDelegatedArgs('tape', args.slice(tapeIdx + 1));
    const res = spawnSync(process.execPath, [path.join(__dirname, 'tape-cli.mjs'), ...tapeArgs], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    process.exit(res.status ?? 1);
  }

  const ctxIdx = args.indexOf('--context');
  if (ctxIdx !== -1) {
    const ctxArgs = filterDelegatedArgs('context', args.slice(ctxIdx + 1));
    const res = spawnSync(process.execPath, [path.join(__dirname, 'context-pack.mjs'), ...ctxArgs], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    process.exit(res.status ?? 1);
  }

  const healIdx = args.indexOf('--heal-action');
  if (healIdx !== -1) {
    const rawNext = args[healIdx + 1];
    const hasExplicitMode = Boolean(rawNext && !rawNext.startsWith('--'));
    const mode = hasExplicitMode ? rawNext : 'dry-run';
    if (mode !== 'dry-run' && mode !== 'apply') {
      console.error(`❌ Invalid --heal-action mode '${mode}'. Expected 'dry-run' or 'apply'.`);
      process.exit(1);
    }
    const extraHealArgs = filterDelegatedArgs('heal', args.slice(healIdx + (hasExplicitMode ? 2 : 1)));
    const healCliArgs = mode === 'apply' ? ['--apply', ...extraHealArgs] : ['--dry-run', ...extraHealArgs];
    const res = spawnSync(process.execPath, [path.join(__dirname, 'heal-drift.mjs'), ...healCliArgs], {
      cwd: rootDir,
      stdio: mode === 'apply' ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      encoding: mode === 'apply' ? 'utf8' : undefined,
    });
    if (mode === 'apply' && res.stdout) {
      process.stdout.write(res.stdout);
    }
    const didHeal =
      mode === 'apply' &&
      res.status === 0 &&
      /"status"\s*:\s*"healed"|^HEAL\s+\|\s+healed\b|Cortex Drift-Healer \(healed\)/m.test(res.stdout || '');
    if (didHeal) {
      clearResolvedFailureArtifacts(rootDir);
      if (!extraHealArgs.includes('--json')) {
        const updatedBp = buildOrchestrationBlueprint(rootDir);
        console.log('\n' + formatCompactBlueprint(updatedBp));
      }
    }
    process.exit(res.status ?? 1);
  }

  if (args.includes('--ci-init')) {
    const ciRes = ensureCiPipelineConfigured(rootDir);
    console.log(`CI     | ${ciRes.status} -> ${ciRes.file}`);
    const updatedBp = buildOrchestrationBlueprint(rootDir);
    console.log(formatCompactBlueprint(updatedBp));
    if (args.includes('--verify')) {
      const vArgs = filterDelegatedArgs('verify', args.filter((a) => a !== '--ci-init' && a !== '--verify'));
      const vRes = spawnSync(process.execPath, [path.join(__dirname, 'verify-fast.mjs'), ...vArgs], {
        cwd: rootDir,
        stdio: 'inherit',
      });
      process.exit(vRes.status ?? 1);
    }
    process.exit(0);
  }

  if (args.includes('--verify')) {
    const vArgs = filterDelegatedArgs('verify', args.filter((a) => a !== '--verify'));
    const res = spawnSync(process.execPath, [path.join(__dirname, 'verify-fast.mjs'), ...vArgs], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    process.exit(res.status ?? 1);
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
  let resumeGate = null;
  let gateChoice = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--squad' && args[i + 1]) squad = args[++i];
    else if (args[i].startsWith('--squad=')) squad = args[i].slice('--squad='.length);
    else if (args[i] === '--max-steps' && args[i + 1]) maxSteps = Number(args[++i]);
    else if (args[i].startsWith('--max-steps=')) maxSteps = Number(args[i].slice('--max-steps='.length));
    else if (args[i] === '--workers' && args[i + 1]) workers = Number(args[++i]);
    else if (args[i].startsWith('--workers=')) workers = Number(args[i].slice('--workers='.length));
    else if (args[i] === '--resume-gate' && args[i + 1]) resumeGate = args[++i];
    else if (args[i].startsWith('--resume-gate=')) resumeGate = args[i].slice('--resume-gate='.length);
    else if (args[i] === '--choice' && args[i + 1]) gateChoice = Number(args[++i]);
    else if (args[i].startsWith('--choice=')) gateChoice = Number(args[i].slice('--choice='.length));
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

  let resumedGateInfo = null;
  if (resumeGate) {
    const blueprint = buildOrchestrationBlueprint(rootDir, { squad });
    const resolved = resolveGateChoice(blueprint, resumeGate, gateChoice);
    if (!resolved.ok) {
      if (jsonOut) {
        console.log(JSON.stringify({ resumed: false, executed: false, error: resolved.error, gateId: resumeGate }, null, 2));
      } else {
        console.error(`❌ --resume-gate failed: ${resolved.error}`);
      }
      process.exit(1);
    }
    resumedGateInfo = {
      gateId: resolved.gateId,
      choice: resolved.choice,
      selectedOption: resolved.option,
    };
    if (!loopMode) {
      if (jsonOut) {
        console.log(JSON.stringify({ resumed: true, executed: false, ...resumedGateInfo }, null, 2));
      } else {
        console.log(
          `✅ Resolved gate '${resolved.gateId}' with choice #${resolved.choice}: ${resolved.option.label} -> ${resolved.option.command}`
        );
      }
      process.exit(0);
    }

    // In --loop mode, actually execute allowlisted deterministic gate commands before continuing the loop.
    const execRes = executeSafeGateOption(rootDir, resolved.option);
    if (execRes.canceled) {
      if (jsonOut) {
        console.log(
          JSON.stringify(
            { resumed: true, executed: true, canceled: true, stoppedReason: 'canceled', resumedGate: resumedGateInfo },
            null,
            2
          )
        );
      }
      process.exit(0);
    }
    if (execRes.requiresAgentSeat) {
      if (jsonOut) {
        console.log(
          JSON.stringify(
            {
              resumed: true,
              executed: false,
              requiresAgentSeat: true,
              error: execRes.reason,
              resumedGate: resumedGateInfo,
            },
            null,
            2
          )
        );
      } else {
        console.error(`❌ ${execRes.reason}`);
      }
      process.exit(1);
    }
    if (execRes.exitCode !== 0) {
      if (jsonOut) {
        console.log(
          JSON.stringify(
            {
              resumed: true,
              executed: true,
              exitCode: execRes.exitCode,
              error: execRes.error,
              resumedGate: resumedGateInfo,
            },
            null,
            2
          )
        );
      } else {
        console.error(`❌ Resumed gate command failed: ${execRes.error}`);
      }
      process.exit(1);
    }
    resumedGateInfo = { ...resumedGateInfo, executed: true, exitCode: 0 };
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
        const output = resumedGateInfo ? { ...res, resumedGate: resumedGateInfo } : res;
        if (jsonOut) {
          console.log(JSON.stringify(output, null, 2));
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
        process.exit(res.status ?? 1);
      } else if (blueprint.nextAction.npmScript) {
        let npmCmd = 'npm';
        let npmArgs = ['run', blueprint.nextAction.npmScript];
        if (process.platform === 'win32') {
          const npmCliJs = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
          if (fs.existsSync(npmCliJs)) {
            npmCmd = process.execPath;
            npmArgs = [npmCliJs, 'run', blueprint.nextAction.npmScript];
          } else {
            npmCmd = 'npm.cmd';
          }
        }
        const res = spawnSync(npmCmd, npmArgs, {
          cwd: rootDir,
          stdio: jsonOut ? 'pipe' : 'inherit',
          shell: false,
        });
        process.exit(res.status ?? 1);
      }
    }
  }
  }
  }
}

