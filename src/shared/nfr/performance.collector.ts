import type { Page } from '@playwright/test';
import type {
  PerformanceAuditReport,
  PerformanceBudgetPolicy,
  PerformanceFinding,
  WebVitalsSnapshot,
} from './nfr.types';

const IS_CI = Boolean(process.env.CI || process.env.TF_BUILD);

/**
 * Pure Frontend Performance & Core Web Vitals Collector (SRP — zero dependencies, zero expect()).
 * Captures Navigation Timing, FCP, LCP, and CLS via standard browser Performance APIs.
 */
export class PerformanceCollector {
  async capture(page: Page): Promise<WebVitalsSnapshot> {
    const url = page.url();
    const raw = await page.evaluate(async () => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const paints = performance.getEntriesByType('paint');
      const fcpEntry = paints.find((p) => p.name === 'first-contentful-paint');

      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      let lcpMs: number | null = lcpEntries.length > 0 ? lcpEntries[lcpEntries.length - 1].startTime : null;

      let cls: number | null = 0;
      const shiftEntries = performance.getEntriesByType('layout-shift') as Array<
        PerformanceEntry & { value?: number; hadRecentInput?: boolean }
      >;
      if (shiftEntries.length > 0) {
        cls = shiftEntries.reduce((sum, e) => (e.hadRecentInput ? sum : sum + (e.value ?? 0)), 0);
      }

      if (lcpMs === null && typeof PerformanceObserver !== 'undefined') {
        lcpMs = await new Promise<number | null>((resolve) => {
          let latest: number | null = null;
          let settled = false;
          const finish = () => {
            if (!settled) {
              settled = true;
              resolve(latest);
            }
          };
          try {
            const obs = new PerformanceObserver((list) => {
              const entries = list.getEntries();
              if (entries.length > 0) latest = entries[entries.length - 1].startTime;
            });
            obs.observe({ type: 'largest-contentful-paint', buffered: true });
            setTimeout(() => {
              obs.disconnect();
              finish();
            }, 50);
          } catch {
            finish();
          }
        });
      }

      const round = (n: number | null | undefined): number | null =>
        typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : null;

      return {
        ttfbMs: nav ? round(nav.responseStart - nav.requestStart) : null,
        fcpMs: fcpEntry ? round(fcpEntry.startTime) : null,
        lcpMs: round(lcpMs),
        cls: round(cls),
        domContentLoadedMs: nav ? round(nav.domContentLoadedEventEnd) : null,
        loadEventMs: nav && nav.loadEventEnd > 0 ? round(nav.loadEventEnd) : null,
      };
    });

    return { url, ...raw };
  }

  evaluate(snapshot: WebVitalsSnapshot, policy: PerformanceBudgetPolicy, isCI = IS_CI): PerformanceAuditReport {
    const mult = isCI ? Math.max(1, policy.ciTimingMultiplier) : 1;
    const hardFailures: PerformanceFinding[] = [];
    const softWarnings: PerformanceFinding[] = [];

    const checkMetric = (
      metric: PerformanceFinding['metric'],
      actual: number | null,
      warnThreshold: number | undefined,
      maxThreshold: number | undefined,
      applyMultiplier: boolean
    ) => {
      if (actual === null) return;
      const effMax = maxThreshold !== undefined ? Math.round(maxThreshold * (applyMultiplier ? mult : 1) * 1000) / 1000 : undefined;
      const effWarn = warnThreshold !== undefined ? Math.round(warnThreshold * (applyMultiplier ? mult : 1) * 1000) / 1000 : undefined;
      if (effMax !== undefined && actual > effMax) {
        hardFailures.push({
          metric,
          actual,
          threshold: effMax,
          severity: 'hard-fail',
          message: `${metric}=${actual} exceeded hard ceiling ${effMax}${isCI && applyMultiplier ? ` (${mult}x CI)` : ''}`,
        });
      } else if (effWarn !== undefined && actual > effWarn) {
        softWarnings.push({
          metric,
          actual,
          threshold: effWarn,
          severity: 'warning',
          message: `${metric}=${actual} exceeded soft target ${effWarn}${isCI && applyMultiplier ? ` (${mult}x CI)` : ''}`,
        });
      }
    };

    checkMetric('lcpMs', snapshot.lcpMs, policy.lcpWarnMs, policy.lcpMaxMs, true);
    checkMetric('cls', snapshot.cls, policy.clsWarn, policy.clsMax, false);
    checkMetric('ttfbMs', snapshot.ttfbMs, policy.ttfbWarnMs, policy.ttfbMaxMs, true);
    checkMetric('domContentLoadedMs', snapshot.domContentLoadedMs, policy.domContentLoadedWarnMs, policy.domContentLoadedMaxMs, true);
    checkMetric('loadEventMs', snapshot.loadEventMs, policy.loadWarnMs, policy.loadMaxMs, true);

    const summary =
      hardFailures.length === 0 && softWarnings.length === 0
        ? `[perf] All budgets met (LCP=${snapshot.lcpMs ?? 'n/a'}ms, CLS=${snapshot.cls ?? 'n/a'}, TTFB=${snapshot.ttfbMs ?? 'n/a'}ms).`
        : `[perf] ${hardFailures.length} hard failure(s), ${softWarnings.length} warning(s): ${[...hardFailures, ...softWarnings]
            .map((f) => f.message)
            .join('; ')}`;

    return { url: snapshot.url, isCI, effectiveMultiplier: mult, metrics: snapshot, hardFailures, softWarnings, summary };
  }

  async audit(page: Page, policy: PerformanceBudgetPolicy): Promise<PerformanceAuditReport> {
    const snapshot = await this.capture(page);
    return this.evaluate(snapshot, policy);
  }
}
