#!/usr/bin/env node
/**
 * Lightweight Playwright Custom Reporter that records per-scenario execution health
 * and `test.step()` audit steps into gitignored `reports/.coverage-state.json`,
 * then automatically refreshes `reports/system-map.html` after local test runs
 * and CI `playwright merge-reports`.
 */
import path from 'node:path';
import { buildSystemMap, recordPlaywrightRunState } from './build-system-map.mjs';

export default class SystemMapReporter {
  constructor(options = {}) {
    this.rootDir = options.rootDir ? path.resolve(options.rootDir) : process.cwd();
    this.resultsByKey = new Map();
    this.startedAt = Date.now();
  }

  onBegin(config) {
    this.startedAt = Date.now();
    if (config?.rootDir) {
      // config.rootDir is typically `<repo>/tests`; resolve workspace root cleanly
      const candidate = path.resolve(config.rootDir);
      this.rootDir = path.basename(candidate) === 'tests' ? path.dirname(candidate) : process.cwd();
    }
  }

  onTestEnd(test, result) {
    try {
      const fileAbs = test?.location?.file;
      if (!fileAbs) return;
      const relFile = path.relative(this.rootDir, fileAbs).replace(/\\/g, '/');
      if (!relFile.endsWith('.spec.ts') || relFile.startsWith('..')) return;

      const outcome = typeof test.outcome === 'function' ? test.outcome() : '';
      let status = 'failed';
      if (result.status === 'skipped' || outcome === 'skipped') {
        status = 'skipped';
      } else if (result.status === 'passed' || outcome === 'expected' || outcome === 'flaky') {
        status = 'passed';
      }

      const steps = Array.isArray(result.steps)
        ? result.steps
            .filter((s) => !s.category || s.category === 'test.step')
            .map((s) => String(s.title || '').trim())
            .filter(Boolean)
        : [];

      const key = `${relFile}::${test.title}`;
      this.resultsByKey.set(key, {
        specFile: relFile,
        title: test.title,
        status,
        durationMs: Number(result.duration || 0),
        steps,
      });
    } catch {
      /* never fail test suite due to reporting */
    }
  }

  onEnd(result) {
    if (process.env.PW_BLOB_REPORT === '1' || process.env.ASQE_SKIP_SYSTEM_MAP === '1') {
      return;
    }
    try {
      const testResults = [...this.resultsByKey.values()];
      if (testResults.length > 0) {
        recordPlaywrightRunState(this.rootDir, {
          status: result?.status || 'passed',
          durationMs: Number(result?.duration || Date.now() - this.startedAt),
          completedAt: new Date().toISOString(),
          testResults,
        });
      }
      buildSystemMap({ rootDir: this.rootDir, quiet: true });
    } catch {
      /* non-fatal */
    }
  }

  printsToStdio() {
    return false;
  }
}
