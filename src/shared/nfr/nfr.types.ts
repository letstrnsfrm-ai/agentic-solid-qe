/**
 * Shared Non-Functional Testing (NFR) contracts (ISP & DIP).
 * Pure data interfaces consumed by collectors in src/shared/nfr/ and builders in src/data/.
 */

export type NfrSeverity = 'hard-fail' | 'warning';

export type AccessibilityImpact = 'minor' | 'moderate' | 'serious' | 'critical';

export interface AccessibilityAuditPolicy {
  readonly wcagTags: readonly string[];
  readonly blockingImpacts: readonly AccessibilityImpact[];
  readonly allowlistedRuleIds?: readonly string[];
  readonly includeSelector?: string;
  readonly excludeSelectors?: readonly string[];
  readonly allowFallbackDomScan?: boolean;
}

export interface AccessibilityViolationSummary {
  readonly id: string;
  readonly impact: AccessibilityImpact;
  readonly help: string;
  readonly helpUrl?: string;
  readonly nodesCount: number;
  readonly targets: readonly string[];
}

export interface AccessibilityAuditReport {
  readonly url: string;
  readonly engine: 'axe-core' | 'dom-fallback' | 'missing-optional-dependency';
  readonly blockingViolations: readonly AccessibilityViolationSummary[];
  readonly warnings: readonly AccessibilityViolationSummary[];
  readonly summary: string;
}

export interface PerformanceBudgetPolicy {
  readonly lcpWarnMs: number;
  readonly lcpMaxMs: number;
  readonly clsWarn: number;
  readonly clsMax: number;
  readonly ttfbWarnMs: number;
  readonly ttfbMaxMs: number;
  readonly domContentLoadedWarnMs?: number;
  readonly domContentLoadedMaxMs?: number;
  readonly loadWarnMs: number;
  readonly loadMaxMs: number;
  readonly ciTimingMultiplier: number;
}

export interface WebVitalsSnapshot {
  readonly url: string;
  readonly ttfbMs: number | null;
  readonly fcpMs: number | null;
  readonly lcpMs: number | null;
  readonly cls: number | null;
  readonly domContentLoadedMs: number | null;
  readonly loadEventMs: number | null;
}

export interface PerformanceFinding {
  readonly metric: 'lcpMs' | 'cls' | 'ttfbMs' | 'domContentLoadedMs' | 'loadEventMs';
  readonly actual: number;
  readonly threshold: number;
  readonly severity: NfrSeverity;
  readonly message: string;
}

export interface PerformanceAuditReport {
  readonly url: string;
  readonly isCI: boolean;
  readonly effectiveMultiplier: number;
  readonly metrics: WebVitalsSnapshot;
  readonly hardFailures: readonly PerformanceFinding[];
  readonly softWarnings: readonly PerformanceFinding[];
  readonly summary: string;
}

export interface SecurityHygienePolicy {
  readonly requiredHeaders: readonly string[];
  readonly recommendedHeaders: readonly string[];
  readonly requireHttpOnlyOnAuthCookies: boolean;
  readonly requireSecureCookies: boolean;
  readonly checkMixedContent: boolean;
  readonly skipHttpsChecksOnLocalhost: boolean;
  readonly authCookieNamePattern: string;
}

export interface SecurityFinding {
  readonly category: 'header' | 'cookie' | 'mixed-content';
  readonly rule: string;
  readonly severity: NfrSeverity;
  readonly message: string;
}

export interface SecurityHygieneReport {
  readonly url: string;
  readonly isLocalhost: boolean;
  readonly headersChecked: Readonly<Record<string, string>>;
  readonly cookiesChecked: number;
  readonly hardFailures: readonly SecurityFinding[];
  readonly warnings: readonly SecurityFinding[];
  readonly summary: string;
}
