#!/usr/bin/env node
/**
 * Parallel Two-Tier Verification Gate (`npx cortex verify` / `npm run verify:fast` / `npm run verify`).
 *
 * Eliminates sequential `npm run` wrapper overhead by executing all static guardrails
 * concurrently (`tsc --noEmit` with incremental `.tsbuildinfo`, in-process `buildDomainGraph`,
 * `audit-solid.mjs`, and `validate-tapes.mjs`) before running either:
 *   - Fast inner-loop tier (`--fast [--specs a.spec.ts,b.spec.ts]`): static checks + only affected specs
 *   - Full final gate (default): static checks + optional `--with-engine` + full `@smoke|@p0` suite
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildDomainGraph } from './build-domain-graph.mjs';
import { buildSystemMap } from './build-system-map.mjs';
import { resolveLocalBin } from './explore-session.mjs';
import { analyzeImpact } from './impact-graph.mjs';
import {
  capLines,
  isCompactMode,
  summarizeNodeTestRun,
  summarizePlaywrightRun,
} from './lib/cli-output.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAFE_SPEC_REL_RE = /^tests\/[a-zA-Z0-9_./-]+\.spec\.ts$/;

export function sanitizeSpecList(specs = [], rootDir = process.cwd()) {
  const resolvedRoot = path.resolve(rootDir);
  const clean = [];
  for (const raw of specs) {
    const normalized = String(raw || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/^\.\//, '');
    if (!normalized) continue;
    if (!SAFE_SPEC_REL_RE.test(normalized) || normalized.includes('..')) {
      throw new Error(
        `Security Error: Invalid spec path '${raw}'. Must match tests/<path>.spec.ts with no traversal.`
      );
    }
    const abs = path.resolve(resolvedRoot, normalized);
    const rel = path.relative(resolvedRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Security Error: Spec path escapes workspace root: '${raw}'.`);
    }
    clean.push(normalized);
  }
  return [...new Set(clean)];
}

function spawnAsync(command, args, { cwd, env = process.env, inherit = false } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (!inherit) {
      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
    }
    child.on('error', (err) => {
      resolve({
        status: 1,
        stdout,
        stderr: stderr || err.message,
        durationMs: Math.round(performance.now() - t0),
      });
    });
    child.on('close', (code) => {
      resolve({
        status: code ?? 1,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - t0),
      });
    });
  });
}

export async function runFastVerify({
  rootDir = process.cwd(),
  fast = false,
  specs = [],
  affected = false,
  noAffected = false,
  baseRef = '',
  maxAffected = 10,
  changedFiles = null,
  skipTests = false,
  withEngine = false,
  skipMap = fast,
  workers = 4,
  quiet = false,
  compact = false,
} = {}) {
  const tStart = performance.now();
  const safeSpecs = sanitizeSpecList(specs, rootDir);
  const safeWorkers = Math.max(1, Math.min(32, Number.isFinite(Number(workers)) ? Math.floor(Number(workers)) : 4));
  const safeMaxAffected = Math.max(1, Number.isFinite(Number(maxAffected)) ? Math.floor(Number(maxAffected)) : 10);
  const captureTests = quiet || compact;

  const stages = {};
  const warnings = [];

  // Resolve fixture-aware git-diff blast radius (unless explicitly disabled via --no-affected)
  let impact = null;
  if (!noAffected) {
    try {
      impact = analyzeImpact(rootDir, {
        files: changedFiles,
        baseRef,
        maxFastSpecs: safeMaxAffected,
      });
    } catch {
      /* non-fatal if git/graph unavailable */
    }
  }

  // Merge explicit --specs with git-diff affected specs (capped by safeMaxAffected)
  const effectiveSpecs = [...safeSpecs];
  if (impact && (affected || (fast && safeSpecs.length > 0))) {
    for (const sp of impact.recommendedFastSpecs) {
      if (!effectiveSpecs.includes(sp)) effectiveSpecs.push(sp);
    }
    if (impact.exceedsFastCap && impact.deferredSpecs.length > 0) {
      const warnMsg =
        `HIGH BLAST RADIUS: ${impact.affectedSpecs.length} specs affected (cap=${safeMaxAffected}). ` +
        `Running ${effectiveSpecs.length} prioritized spec(s); ${impact.deferredSpecs.length} deferred. ` +
        `Run 'npx cortex verify --affected --max-affected ${impact.affectedSpecs.length}' or CI to verify all.`;
      warnings.push(warnMsg);
      if (!quiet) console.warn(`⚠️  ${warnMsg}`);
    }
  }

  // 1. Run all static gates concurrently (tsc + in-process domainGraph + audit:solid + validate:tapes)
  const tscPromise = (async () => {
    if (!fs.existsSync(path.join(rootDir, 'tsconfig.json'))) {
      return { name: 'typecheck', status: 0, skipped: true, durationMs: 0, stdout: '', stderr: '' };
    }
    const tscBin = resolveLocalBin('tsc', rootDir);
    const res = await spawnAsync(tscBin.command, [...tscBin.prefixArgs, '--noEmit'], { cwd: rootDir });
    return { name: 'typecheck', ...res };
  })();

  const domainGraphPromise = Promise.resolve().then(() => {
    const t0 = performance.now();
    try {
      const graph = buildDomainGraph({ rootDir, writeToDisk: true });
      if (!skipMap && path.resolve(rootDir) === path.resolve(process.cwd())) {
        try {
          buildSystemMap({ quiet: true });
        } catch {
          /* non-fatal */
        }
      }
      return {
        name: 'domainGraph',
        status: 0,
        durationMs: Math.round(performance.now() - t0),
        stdout: `Compiled ${graph.summary.totalShards} shard(s), ${Object.keys(graph.routeIndex).length} route(s).`,
        stderr: '',
      };
    } catch (err) {
      return {
        name: 'domainGraph',
        status: 1,
        durationMs: Math.round(performance.now() - t0),
        stdout: '',
        stderr: String(err.message || err),
      };
    }
  });

  const auditPromise = (async () => {
    const auditScript = path.join(__dirname, 'audit-solid.mjs');
    const res = await spawnAsync(process.execPath, [auditScript], { cwd: rootDir });
    return { name: 'auditSolid', ...res };
  })();

  const validateTapesPromise = (async () => {
    const validateScript = path.join(__dirname, 'validate-tapes.mjs');
    const res = await spawnAsync(process.execPath, [validateScript], { cwd: rootDir });
    return { name: 'validateTapes', ...res };
  })();

  const staticResults = await Promise.all([
    tscPromise,
    domainGraphPromise,
    auditPromise,
    validateTapesPromise,
  ]);

  let failedStage = null;
  for (const r of staticResults) {
    stages[r.name] = {
      status: r.status,
      durationMs: r.durationMs,
      ...(r.skipped ? { skipped: true } : {}),
    };
    if (r.status !== 0 && !failedStage) {
      failedStage = {
        stage: r.name,
        status: r.status,
        output: (r.stderr || r.stdout || '').trim().slice(0, 2000),
      };
    }
  }

  if (failedStage) {
    if (!quiet) {
      const msg = compact ? capLines(failedStage.output, { maxLines: 25 }) : failedStage.output;
      console.error(`❌ verify failed at static stage '${failedStage.stage}':\n${msg}`);
    }
    return {
      ok: false,
      mode: fast ? 'fast' : 'full',
      failedStage,
      stages,
      impact,
      warnings,
      totalMs: Math.round(performance.now() - tStart),
    };
  }

  // 2. Test Execution Tier (targeted + affected specs in --fast/--affected mode, full engine + smoke + affected @regression in full mode)
  if (!skipTests) {
    if (withEngine && !fast && fs.existsSync(path.join(rootDir, 'scripts/self-test.mjs'))) {
      const engRes = await spawnAsync(process.execPath, ['--test', 'scripts/self-test.mjs'], {
        cwd: rootDir,
        inherit: !captureTests,
      });
      const engSummary = captureTests ? summarizeNodeTestRun(engRes.stdout, engRes.stderr) : null;
      stages.engineTests = {
        status: engRes.status,
        durationMs: engRes.durationMs,
        ...(engSummary ? { summary: engSummary.summaryLine } : {}),
      };
      if (engRes.status !== 0) {
        const failureExcerpt = engSummary?.failingTests?.length
          ? engSummary.failingTests.join('\n')
          : capLines(engRes.stderr || engRes.stdout || '', { maxLines: 25 });
        if (!quiet && compact) {
          console.error(`❌ verify failed at 'engineTests' (${engSummary?.summaryLine || `exit ${engRes.status}`}):\n${failureExcerpt}`);
        }
        return {
          ok: false,
          mode: 'full',
          failedStage: {
            stage: 'engineTests',
            status: engRes.status,
            output: failureExcerpt.slice(0, 2000),
          },
          stages,
          impact,
          warnings,
          totalMs: Math.round(performance.now() - tStart),
        };
      }
    }

    const shouldRunPlaywright = !fast || effectiveSpecs.length > 0;
    if (shouldRunPlaywright) {
      const pwBin = resolveLocalBin('playwright', rootDir);
      const pwArgs = [...pwBin.prefixArgs, 'test'];
      if (effectiveSpecs.length > 0) {
        pwArgs.push(...effectiveSpecs, '--project=chromium', `--workers=${safeWorkers}`, '--pass-with-no-tests');
      } else {
        pwArgs.push('--project=chromium', '--grep', '@smoke|@p0', '--pass-with-no-tests');
      }
      if (captureTests) {
        pwArgs.push('--reporter=line');
      }
      const pwRes = await spawnAsync(pwBin.command, pwArgs, {
        cwd: rootDir,
        inherit: !captureTests,
      });
      const pwSummary = captureTests ? summarizePlaywrightRun(pwRes.stdout, pwRes.stderr) : null;
      stages.playwrightTests = {
        status: pwRes.status,
        durationMs: pwRes.durationMs,
        specs: effectiveSpecs.length > 0 ? effectiveSpecs : ['@smoke|@p0'],
        ...(pwSummary ? { summary: pwSummary.summaryLine } : {}),
      };
      if (pwRes.status !== 0) {
        const blocks = pwSummary?.failureBlocks?.length
          ? pwSummary.failureBlocks.join('\n')
          : capLines(pwRes.stderr || pwRes.stdout || '', { maxLines: 25 });
        const ctxHint = pwSummary?.errorContextPaths?.length
          ? `\nArtifacts: ${pwSummary.errorContextPaths.join(', ')}`
          : '';
        const failureExcerpt = `${blocks}${ctxHint}`;
        if (!quiet && compact) {
          console.error(`❌ verify failed at 'playwrightTests' (${pwSummary?.summaryLine || `exit ${pwRes.status}`}):\n${failureExcerpt}`);
        }
        return {
          ok: false,
          mode: fast ? 'fast' : 'full',
          failedStage: {
            stage: 'playwrightTests',
            status: pwRes.status,
            output: failureExcerpt.slice(0, 2000),
          },
          stages,
          impact,
          warnings,
          totalMs: Math.round(performance.now() - tStart),
        };
      }

      // In full verify mode without explicit --specs, also run git-diff affected @regression specs (closing the @smoke|@p0 blind spot)
      if (!fast && effectiveSpecs.length === 0 && impact && impact.affectedRegressionSpecs.length > 0) {
        const regSpecs = impact.affectedRegressionSpecs.slice(0, safeMaxAffected);
        if (impact.affectedRegressionSpecs.length > safeMaxAffected) {
          const warnMsg =
            `HIGH BLAST RADIUS: ${impact.affectedRegressionSpecs.length} affected @regression specs exceed cap (${safeMaxAffected}); running first ${regSpecs.length}.`;
          warnings.push(warnMsg);
          if (!quiet) console.warn(`⚠️  ${warnMsg}`);
        }
        const regArgs = [
          ...pwBin.prefixArgs,
          'test',
          ...regSpecs,
          '--project=chromium',
          `--workers=${safeWorkers}`,
          '--pass-with-no-tests',
          ...(captureTests ? ['--reporter=line'] : []),
        ];
        const regRes = await spawnAsync(pwBin.command, regArgs, {
          cwd: rootDir,
          inherit: !captureTests,
        });
        const regSummary = captureTests ? summarizePlaywrightRun(regRes.stdout, regRes.stderr) : null;
        stages.affectedRegressionTests = {
          status: regRes.status,
          durationMs: regRes.durationMs,
          specs: regSpecs,
          ...(regSummary ? { summary: regSummary.summaryLine } : {}),
        };
        if (regRes.status !== 0) {
          const blocks = regSummary?.failureBlocks?.length
            ? regSummary.failureBlocks.join('\n')
            : capLines(regRes.stderr || regRes.stdout || '', { maxLines: 25 });
          if (!quiet && compact) {
            console.error(`❌ verify failed at 'affectedRegressionTests' (${regSummary?.summaryLine || `exit ${regRes.status}`}):\n${blocks}`);
          }
          return {
            ok: false,
            mode: 'full',
            failedStage: {
              stage: 'affectedRegressionTests',
              status: regRes.status,
              output: blocks.slice(0, 2000),
            },
            stages,
            impact,
            warnings,
            totalMs: Math.round(performance.now() - tStart),
          };
        }
      }
    }
  }

  return {
    ok: true,
    mode: fast ? 'fast' : 'full',
    stages,
    impact,
    warnings,
    totalMs: Math.round(performance.now() - tStart),
  };
}

const isMain =
  Boolean(process.argv[1]) &&
  fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(__filename);

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
⚡ Cortex Parallel Two-Tier Verify Gate (npx cortex verify)

Usage:
  npx cortex verify [--fast] [--specs tests/a.spec.ts,tests/b.spec.ts] [--affected] [--no-affected] [--base <git-ref>] [--max-affected <N>] [--skip-tests] [--with-engine] [--skip-map] [--workers N] [--compact|--verbose|--json]
`);
    process.exit(0);
  }

  const fast = args.includes('--fast');
  const affected = args.includes('--affected');
  const noAffected = args.includes('--no-affected');
  const skipTests = args.includes('--skip-tests');
  const withEngine = args.includes('--with-engine');
  const skipMap = args.includes('--skip-map') || fast;
  const jsonOut = args.includes('--json');
  const compactOut = !jsonOut && isCompactMode(args);

  const specs = [];
  let workers = 4;
  let baseRef = '';
  let maxAffected = 10;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--specs' && args[i + 1]) {
      specs.push(...args[++i].split(',').filter(Boolean));
    } else if (a.startsWith('--specs=')) {
      specs.push(...a.slice('--specs='.length).split(',').filter(Boolean));
    } else if (a === '--spec' && args[i + 1]) {
      specs.push(args[++i]);
    } else if (a === '--workers' && args[i + 1]) {
      workers = Number(args[++i]);
    } else if (a.startsWith('--workers=')) {
      workers = Number(a.slice('--workers='.length));
    } else if (a === '--base' && args[i + 1]) {
      baseRef = args[++i];
    } else if (a.startsWith('--base=')) {
      baseRef = a.slice('--base='.length);
    } else if (a === '--max-affected' && args[i + 1]) {
      maxAffected = Number(args[++i]);
    } else if (a.startsWith('--max-affected=')) {
      maxAffected = Number(a.slice('--max-affected='.length));
    }
  }

  runFastVerify({
    rootDir: process.cwd(),
    fast,
    specs,
    affected,
    noAffected,
    baseRef,
    maxAffected,
    skipTests,
    withEngine,
    skipMap,
    workers,
    quiet: jsonOut,
    compact: compactOut,
  })
    .then((res) => {
      if (jsonOut) {
        console.log(JSON.stringify(res, null, 2));
      } else if (res.ok) {
        const parts = Object.entries(res.stages)
          .map(([k, v]) => `${k}:${v.summary ? `${v.summary} ` : ''}${v.durationMs}ms`)
          .join(', ');
        console.log(`✅ verify (${res.mode}) passed in ${res.totalMs}ms [${parts}]`);
      }
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(`❌ verify error: ${err.message}`);
      process.exit(1);
    });
}
