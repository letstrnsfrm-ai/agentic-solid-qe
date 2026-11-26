import type {
  AccessibilityAuditPolicy,
  PerformanceBudgetPolicy,
  SecurityHygienePolicy,
} from '@shared/nfr';

/**
 * Typed NFR Budget & Policy Data Builder (SRP — zero magic thresholds in specs).
 * Provides tiered severity and CI-aware defaults for @a11y, @perf, and @security specs.
 */
export class NfrBudgetBuilder {
  static wcagAA(overrides: Partial<AccessibilityAuditPolicy> = {}): AccessibilityAuditPolicy {
    return {
      wcagTags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
      blockingImpacts: ['critical', 'serious'],
      allowlistedRuleIds: [],
      allowFallbackDomScan: false,
      ...overrides,
    };
  }

  static wcagAAFallbackDom(overrides: Partial<AccessibilityAuditPolicy> = {}): AccessibilityAuditPolicy {
    return NfrBudgetBuilder.wcagAA({ allowFallbackDomScan: true, ...overrides });
  }

  static webVitalsStandard(overrides: Partial<PerformanceBudgetPolicy> = {}): PerformanceBudgetPolicy {
    return {
      lcpWarnMs: 2500,
      lcpMaxMs: 4000,
      clsWarn: 0.1,
      clsMax: 0.25,
      ttfbWarnMs: 800,
      ttfbMaxMs: 1800,
      domContentLoadedWarnMs: 2000,
      domContentLoadedMaxMs: 5000,
      loadWarnMs: 4000,
      loadMaxMs: 8000,
      ciTimingMultiplier: 1.5,
      ...overrides,
    };
  }

  static securityBaseline(overrides: Partial<SecurityHygienePolicy> = {}): SecurityHygienePolicy {
    return {
      requiredHeaders: ['x-content-type-options', 'x-frame-options'],
      recommendedHeaders: ['content-security-policy', 'referrer-policy', 'strict-transport-security'],
      requireHttpOnlyOnAuthCookies: true,
      requireSecureCookies: true,
      checkMixedContent: true,
      skipHttpsChecksOnLocalhost: true,
      authCookieNamePattern: '(?:session|sess|auth|token|jwt|sid|csrf)',
      ...overrides,
    };
  }
}
