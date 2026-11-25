import type { Page } from '@playwright/test';
import type {
  AccessibilityAuditPolicy,
  AccessibilityAuditReport,
  AccessibilityImpact,
  AccessibilityViolationSummary,
} from './nfr.types';

interface AxeNodeLike {
  target?: readonly (string | readonly string[])[];
}

interface AxeViolationLike {
  id: string;
  impact?: string | null;
  help: string;
  helpUrl?: string;
  nodes?: readonly AxeNodeLike[];
}

interface AxeBuilderLike {
  withTags(tags: string[]): AxeBuilderLike;
  include(selector: string): AxeBuilderLike;
  exclude(selector: string): AxeBuilderLike;
  disableRules(rules: string[]): AxeBuilderLike;
  analyze(): Promise<{ violations: readonly AxeViolationLike[] }>;
}

type AxeBuilderCtor = new (options: { page: Page }) => AxeBuilderLike;

const OPTIONAL_AXE_PKG = '@axe-core/playwright';

function normalizeImpact(raw: string | null | undefined): AccessibilityImpact {
  return raw === 'critical' || raw === 'serious' || raw === 'moderate' || raw === 'minor' ? raw : 'moderate';
}

function summarizeReport(
  engine: AccessibilityAuditReport['engine'],
  blocking: readonly AccessibilityViolationSummary[],
  warnings: readonly AccessibilityViolationSummary[]
): string {
  if (blocking.length === 0 && warnings.length === 0) return `[a11y:${engine}] 0 violations.`;
  const top = blocking.slice(0, 3).map((v) => `${v.id}(${v.impact}:${v.nodesCount})`).join(', ');
  return `[a11y:${engine}] ${blocking.length} blocking, ${warnings.length} warnings${top ? ` — ${top}` : ''}.`;
}

/**
 * Pure Accessibility Audit Collector (SRP — zero expect() calls).
 * Lazily loads optional @axe-core/playwright; supports lightweight DOM fallback when configured.
 */
export class AccessibilityCollector {
  async audit(page: Page, policy: AccessibilityAuditPolicy): Promise<AccessibilityAuditReport> {
    const url = page.url();
    const AxeCtor = await this.loadAxeBuilder();
    if (!AxeCtor) {
      if (policy.allowFallbackDomScan) return this.runFallbackDomScan(page, policy);
      const msg =
        `Optional dependency '${OPTIONAL_AXE_PKG}' is not installed. ` +
        `Run 'npm install -D ${OPTIONAL_AXE_PKG}' to enable full WCAG axe-core assertions.`;
      return {
        url,
        engine: 'missing-optional-dependency',
        blockingViolations: [{ id: 'axe-dependency-missing', impact: 'critical', help: msg, nodesCount: 1, targets: [] }],
        warnings: [],
        summary: msg,
      };
    }

    let builder = new AxeCtor({ page });
    if (policy.wcagTags.length > 0) builder = builder.withTags([...policy.wcagTags]);
    if (policy.includeSelector) builder = builder.include(policy.includeSelector);
    for (const sel of policy.excludeSelectors ?? []) builder = builder.exclude(sel);
    if (policy.allowlistedRuleIds?.length) builder = builder.disableRules([...policy.allowlistedRuleIds]);

    const result = await builder.analyze();
    return this.partitionViolations(url, 'axe-core', result.violations, policy);
  }

  private async loadAxeBuilder(): Promise<AxeBuilderCtor | null> {
    try {
      const mod = (await import(OPTIONAL_AXE_PKG)) as { default?: AxeBuilderCtor; AxeBuilder?: AxeBuilderCtor };
      return mod.default ?? mod.AxeBuilder ?? null;
    } catch {
      return null;
    }
  }

  private partitionViolations(
    url: string,
    engine: AccessibilityAuditReport['engine'],
    rawViolations: readonly AxeViolationLike[],
    policy: AccessibilityAuditPolicy
  ): AccessibilityAuditReport {
    const blockingSet = new Set<AccessibilityImpact>(policy.blockingImpacts);
    const allowlist = new Set<string>(policy.allowlistedRuleIds ?? []);
    const blocking: AccessibilityViolationSummary[] = [];
    const warnings: AccessibilityViolationSummary[] = [];

    for (const v of rawViolations) {
      if (allowlist.has(v.id)) continue;
      const impact = normalizeImpact(v.impact);
      const targets = (v.nodes ?? [])
        .map((n) => (Array.isArray(n.target) ? n.target.map(String).join(' ') : ''))
        .filter(Boolean)
        .slice(0, 5);
      const item: AccessibilityViolationSummary = {
        id: v.id,
        impact,
        help: v.help,
        helpUrl: v.helpUrl,
        nodesCount: v.nodes?.length ?? 1,
        targets,
      };
      (blockingSet.has(impact) ? blocking : warnings).push(item);
    }

    return { url, engine, blockingViolations: blocking, warnings, summary: summarizeReport(engine, blocking, warnings) };
  }

  private async runFallbackDomScan(page: Page, policy: AccessibilityAuditPolicy): Promise<AccessibilityAuditReport> {
    const findings = await page.evaluate(() => {
      const out: { id: string; impact: string; help: string; targets: string[] }[] = [];
      if (!document.documentElement.getAttribute('lang')?.trim()) {
        out.push({ id: 'html-has-lang', impact: 'serious', help: '<html> element must have a lang attribute', targets: ['html'] });
      }
      if (!document.title.trim()) {
        out.push({ id: 'document-title', impact: 'serious', help: 'Document must have a non-empty <title>', targets: ['title'] });
      }
      const imgsNoAlt = Array.from(document.querySelectorAll('img')).filter((img) => !img.hasAttribute('alt'));
      if (imgsNoAlt.length > 0) {
        out.push({ id: 'image-alt', impact: 'critical', help: 'Images must have alternate text', targets: imgsNoAlt.slice(0, 5).map((i) => i.src || 'img') });
      }
      return out;
    });
    const raw: AxeViolationLike[] = findings.map((f) => ({ id: f.id, impact: f.impact, help: f.help, nodes: f.targets.map((t) => ({ target: [t] })) }));
    return this.partitionViolations(page.url(), 'dom-fallback', raw, policy);
  }
}
