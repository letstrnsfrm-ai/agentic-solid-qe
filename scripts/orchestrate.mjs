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
import { fileURLToPath } from 'node:url';
import { discoverLegacyTests } from './legacy-test-migrator.mjs';

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
  const analyzerPath = path.join(rootDir, 'scripts/analyze-coverage.mjs');
  const fallbackAnalyzer = path.join(__dirname, 'analyze-coverage.mjs');
  const scriptToRun = fs.existsSync(analyzerPath) ? analyzerPath : fallbackAnalyzer;

  const args = [scriptToRun, '--summary', '--json'];
  if (squad) args.push('--squad', squad);

  const res = spawnSync(process.execPath, args, {
    cwd: rootDir,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (res.status !== 0) {
    throw new Error(`analyze-coverage.mjs failed (exit ${res.status}): ${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout);
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
    const scenarioId = typeof firstTape === 'string' ? firstTape : firstTape.scenarioId;
    maturityStage =
      counts.wizardSteps > 0 || counts.apiClients > 0
        ? 'Stage 3 — Enterprise Wizards, APIs & Handoffs'
        : 'Stage 1 — P0 Golden-Path Baseline (1 Test at a Time)';
    nextAction = {
      priority: 3,
      skill: '02-solid-architect',
      why: `${uncompiledTapes.length} recorded Session Tape(s) ready for deterministic SOLID compilation (next: ${scenarioId}).`,
      command: `npx cortex compile ${scenarioId} --apply`,
      runArgs: [path.join(__dirname, 'compile-tape.mjs'), scenarioId, '--apply'],
      autoRunnable: true,
      humanGate: 'None — agent compiles & runs npm run verify autonomously.',
    };
  } else if (totalLegacyCount > 0) {
    maturityStage = 'Stage 0 — Legacy Rules & Test Migration';
    const hasLegacyTests = legacyCodeTests.length > 0;
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
    nextAction,
  };
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

// CLI Entrypoint
const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🧠 Master Orchestrator CLI (npx cortex orchestrate)

Usage:
  npx cortex orchestrate [--squad <squad>] [--json] [--run]
`);
    process.exit(0);
  }

  let squad = null;
  let jsonOut = false;
  let runNext = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--squad' && args[i + 1]) squad = args[++i];
    else if (args[i].startsWith('--squad=')) squad = args[i].slice('--squad='.length);
    else if (args[i] === '--json') jsonOut = true;
    else if (args[i] === '--run') runNext = true;
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
  const blueprint = buildOrchestrationBlueprint(rootDir, { squad });

  if (jsonOut) {
    console.log(JSON.stringify(blueprint, null, 2));
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
