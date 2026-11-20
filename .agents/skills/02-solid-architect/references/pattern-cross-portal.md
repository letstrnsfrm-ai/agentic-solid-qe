# Pattern C: Cross-Portal Multi-Actor Handoffs (`Customer` ➔ `Back-Office Agent`)

> Read on-demand when automating UI-to-UI journeys spanning two distinct portals/personas (e.g., Customer Quote Referral ➔ Underwriter Agent Portal Approval).

## 1. Session Tape Structure (`charter: "cross-portal-handoff"`)
- Declare root `actors[]` with `actorId`, `role`, `portalBaseUrl`, `dataBuilderRef`, and `storageStatePath` (for authenticated back-office actors):
```json
"actors": [
  { "actorId": "customer", "role": "customer_anonymous", "portalBaseUrl": "https://quote.insurer.example.com", "dataBuilderRef": "MotorRiskBuilder.referredDriverPersona()" },
  { "actorId": "underwriter_agent", "role": "senior_underwriter", "portalBaseUrl": "https://agent-portal.insurer.example.com", "dataBuilderRef": "UserBuilder.seniorUnderwriter()", "storageStatePath": ".auth/senior_underwriter.json" }
]
```
- Tag every step in `semanticSteps[]` and every assertion in `expectedStates[]` with `actor` (`"customer"` vs. `"underwriter_agent"`).
- Capture handoff identifiers (`QuoteId`, `PolicyNumber`) via `capturedVariables[]` (`capturesVariable: "referralQuoteId"`) and reference them in downstream assertions via `expectedValueRef: "capturedVariable:referralQuoteId"`.

## 2. Isolated Multi-Actor Playwright Fixtures (`mergeTests` / `browser.newContext`)
Isolate each actor in its own `BrowserContext` so cookies, localStorage, and SSO tokens never collide:
```ts
import { test as base, expect } from '@playwright/test';
import { MotorQuoteWizardPage } from '@domains/motor-b2c/pages/motor-quote-wizard.page';
import { AgentReferralQueuePage } from '@domains/agent-portal/pages/agent-referral-queue.page';

export interface CrossPortalFixtures {
  customerQuotePage: MotorQuoteWizardPage;
  agentReferralPage: AgentReferralQueuePage;
}

export const test = base.extend<CrossPortalFixtures>({
  customerQuotePage: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    await use(new MotorQuoteWizardPage(await ctx.newPage()));
    await ctx.close();
  },
  agentReferralPage: async ({ browser }, use) => {
    const ctx = await browser.newContext({ storageState: '.auth/underwriter_agent.json' });
    await use(new AgentReferralQueuePage(await ctx.newPage()));
    await ctx.close();
  },
});

export { expect };
```
