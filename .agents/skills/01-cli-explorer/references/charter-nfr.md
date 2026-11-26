# Non-Functional Testing (NFR) Charters

> Read on-demand when exploring Accessibility (`@a11y`), Frontend Performance (`@perf`), Security Hygiene (`@security`), or Visual Regression (`@visual`).

## 1. Execution & SOLID Guardrails
- **Dedicated NFR Specs:** Keep functional `@p0`/`@smoke` specs pure. Compile NFR tapes into dedicated specs tagged `@nfr` plus `@a11y`, `@perf`, `@security`, or `@visual` (`npm run test:nfr`).
- **Pure Collectors (`src/shared/nfr/`):** Collectors return typed reports with **zero `expect()`** (`≤ 150`L each). All `expect()` assertions live in `tests/*.spec.ts`.
- **Typed Budgets (`src/data/nfr-budget.builder.ts`):** Reference `NfrBudgetBuilder` presets (`wcagAA()`, `webVitalsStandard()`, `securityBaseline()`) in `expectedValueRef` — never magic thresholds.
- **No Budget Loosening:** Treat NFR regressions in `03-drift-healer` as product defects (`defects/`), never silently weakening thresholds.

## 2. Tier 1 Browser-Native NFR Charters
| Charter | Live `agent-browser` Oracle | `expectedStates[]` Encoding | Failure Policy |
| :--- | :--- | :--- | :--- |
| **`accessibility`** | `a11y --json` (WCAG 2.1 AA; optional `@axe-core/playwright` for compiled axe checks) + landmarks/headings | `toPassAxeAudit` (`NfrBudgetBuilder.wcagAA()`) and/or `toMatchAriaSnapshot` | Hard-fail `critical`/`serious`; annotate `moderate`/`minor`. |
| **`performance-budget`** | `vitals --json` (LCP, CLS, TTFB, DOMContentLoaded, Load) | `toMeetPerformanceBudget` (`NfrBudgetBuilder.webVitalsStandard()`) | Soft-warn Web Vitals targets; hard-fail catastrophic ceilings (CI multiplier). |
| **`security-hygiene`** | Security headers (`X-Content-Type-Options`, `X-Frame-Options`/CSP, `HSTS`, `Referrer-Policy`), `HttpOnly`/`Secure` cookies, mixed content | `toMeetSecurityHygiene` (`NfrBudgetBuilder.securityBaseline()`) | Hard-fail deterministic header/cookie/mixed-content flaws; auto-skip HTTPS checks on `localhost`. |
| **`visual-regression`** | Identify volatile regions (timestamps, live counters, avatars) | `toHaveScreenshot`, `maskSelectors`, `maxDiffPixelRatio: 0.02` | Hard-fail pixel diffs beyond ratio (`animations: 'disabled'`). |
