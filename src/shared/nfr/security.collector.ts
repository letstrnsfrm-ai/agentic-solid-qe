import type { Page, Response } from '@playwright/test';
import type { SecurityFinding, SecurityHygienePolicy, SecurityHygieneReport } from './nfr.types';

function parseUrlSafe(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

function isLocalhostUrl(rawUrl: string): boolean {
  const host = parseUrlSafe(rawUrl)?.hostname.toLowerCase() ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/**
 * Pure Web Security Hygiene Collector (SRP — zero dependencies, zero expect()).
 * Audits HTTP security headers, cookie flags (HttpOnly/Secure/SameSite), and HTTPS mixed content.
 */
export class SecurityHygieneCollector {
  async audit(
    page: Page,
    policy: SecurityHygienePolicy,
    navigationResponse?: Response | null
  ): Promise<SecurityHygieneReport> {
    const url = page.url();
    const isLocalhost = isLocalhostUrl(url);
    const skipHttps = isLocalhost && policy.skipHttpsChecksOnLocalhost;
    const hardFailures: SecurityFinding[] = [];
    const warnings: SecurityFinding[] = [];

    const headers = await this.resolveHeaders(page, navigationResponse);
    this.auditHeaders(headers, policy, skipHttps, hardFailures, warnings);

    const cookies = await page.context().cookies(url ? [url] : undefined);
    this.auditCookies(cookies, policy, skipHttps, hardFailures, warnings);

    if (policy.checkMixedContent && parseUrlSafe(url)?.protocol === 'https:') {
      for (const mixed of (await this.detectMixedContent(page)).slice(0, 5)) {
        hardFailures.push({
          category: 'mixed-content',
          rule: 'no-mixed-content',
          severity: 'hard-fail',
          message: `HTTPS page loads insecure http:// resource: ${mixed}`,
        });
      }
    }

    const summary =
      hardFailures.length === 0 && warnings.length === 0
        ? `[security] Clean (${Object.keys(headers).length} headers, ${cookies.length} cookies checked).`
        : `[security] ${hardFailures.length} hard failure(s), ${warnings.length} warning(s): ${[...hardFailures, ...warnings]
            .slice(0, 4)
            .map((f) => f.rule)
            .join(', ')}`;

    return { url, isLocalhost, headersChecked: headers, cookiesChecked: cookies.length, hardFailures, warnings, summary };
  }

  private async resolveHeaders(page: Page, navigationResponse?: Response | null): Promise<Record<string, string>> {
    if (navigationResponse) return navigationResponse.allHeaders();
    const url = page.url();
    if (!/^https?:\/\//i.test(url)) return {};
    try {
      return (await page.request.get(url, { failOnStatusCode: false })).headers();
    } catch {
      return {};
    }
  }

  private auditHeaders(
    headers: Record<string, string>,
    policy: SecurityHygienePolicy,
    skipHttps: boolean,
    hardFailures: SecurityFinding[],
    warnings: SecurityFinding[]
  ): void {
    const norm: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) norm[k.toLowerCase()] = v;

    const check = (headerName: string, severity: 'hard-fail' | 'warning') => {
      const key = headerName.toLowerCase();
      if (skipHttps && key === 'strict-transport-security') return;
      const val = norm[key];
      const hasCspFrameAncestors = key === 'x-frame-options' && /frame-ancestors/i.test(norm['content-security-policy'] ?? '');
      if (!val && !hasCspFrameAncestors) {
        const finding: SecurityFinding = { category: 'header', rule: `missing-header:${key}`, severity, message: `Missing HTTP security header '${key}'.` };
        (severity === 'hard-fail' ? hardFailures : warnings).push(finding);
      } else if (key === 'x-content-type-options' && val && val.toLowerCase() !== 'nosniff') {
        hardFailures.push({ category: 'header', rule: 'invalid-x-content-type-options', severity: 'hard-fail', message: `Expected 'x-content-type-options: nosniff', got '${val}'.` });
      }
    };

    for (const h of policy.requiredHeaders) check(h, 'hard-fail');
    for (const h of policy.recommendedHeaders) check(h, 'warning');
  }

  private auditCookies(
    cookies: ReadonlyArray<{ name: string; httpOnly: boolean; secure: boolean; sameSite?: string }>,
    policy: SecurityHygienePolicy,
    skipHttps: boolean,
    hardFailures: SecurityFinding[],
    warnings: SecurityFinding[]
  ): void {
    const authRegex = new RegExp(policy.authCookieNamePattern, 'i');
    for (const c of cookies) {
      const isAuth = authRegex.test(c.name);
      if (policy.requireHttpOnlyOnAuthCookies && isAuth && !c.httpOnly) {
        hardFailures.push({ category: 'cookie', rule: `cookie-missing-httponly:${c.name}`, severity: 'hard-fail', message: `Auth cookie '${c.name}' is missing HttpOnly.` });
      }
      if (!skipHttps && policy.requireSecureCookies && isAuth && !c.secure) {
        hardFailures.push({ category: 'cookie', rule: `cookie-missing-secure:${c.name}`, severity: 'hard-fail', message: `Auth cookie '${c.name}' is missing Secure on HTTPS.` });
      }
      if (!skipHttps && c.sameSite === 'None' && !c.secure) {
        warnings.push({ category: 'cookie', rule: `cookie-samesite-none-insecure:${c.name}`, severity: 'warning', message: `Cookie '${c.name}' sets SameSite=None without Secure.` });
      }
    }
  }

  private async detectMixedContent(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const insecure: string[] = [];
      const pairs = [['script[src]', 'src'], ['link[rel="stylesheet"][href]', 'href'], ['iframe[src]', 'src'], ['img[src]', 'src']] as const;
      for (const [sel, attr] of pairs) {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const val = el.getAttribute(attr);
          if (val && /^http:\/\//i.test(val)) insecure.push(val);
        }
      }
      return insecure;
    });
  }
}
