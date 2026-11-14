# Reference SOLID Playwright Patterns (Multi-Page & Enterprise Flows)

Follow these exact TypeScript blueprints when compiling a Session Tape into `src/` and `tests/`.

---

## 1. Contract Layer (`src/contracts/*.contract.ts` — LSP)
Define lightweight structural interfaces for repeatable UI widgets:
```ts
import type { Locator } from '@playwright/test';

export interface IdentifiableComponent {
  readonly root: Locator;
}

export interface ErrorBannerContract extends IdentifiableComponent {
  readonly errorBanner: Locator;
  dismissError(): Promise<void>;
}
```

---

## 2. Atomic Component Layer (`src/components/*.component.ts` — SRP, ≤ 150 lines, Zero `expect()`)
Scope child locators to `this.root` when `parentScope` is present in the Session Tape. Use `.filter({ hasText })` when `filterTextRef` is specified on repeating cards or table rows:
```ts
import type { Locator, Page } from '@playwright/test';
import type { IdentifiableComponent } from '@contracts/identifiable-component.contract';

export class LoginFormComponent implements IdentifiableComponent {
  readonly root: Locator;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;
  readonly errorBanner: Locator;

  constructor(page: Page) {
    this.root = page.locator('#login_button_container');
    this.usernameInput = this.root.getByPlaceholder('Username');
    this.passwordInput = this.root.getByPlaceholder('Password');
    this.loginButton = this.root.getByRole('button', { name: 'Login' });
    this.errorBanner = this.root.getByTestId('error');
  }

  async submitCredentials(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }
}
```

### Dynamic Row / Card Scoping (`filterTextRef`)
```ts
itemCardByName(productName: string): Locator {
  return this.root.getByTestId('inventory-item').filter({ hasText: productName });
}
```

---

## 3. Page Composition & Multi-Page Synchronization (`src/pages/*.page.ts` — SRP, Zero `expect()`)
Compose atomic components into page workflows. When a Session Tape step defines `waitForNetwork`, synchronize the action and network response deterministically without hard sleeps:
```ts
import type { Page } from '@playwright/test';
import { LoginFormComponent } from '@components/login-form.component';

export class LoginPage {
  readonly form: LoginFormComponent;

  constructor(private readonly page: Page) {
    this.form = new LoginFormComponent(page);
  }

  async open(): Promise<void> {
    await this.page.goto('/');
  }
}
```

---

## 4. Data Builder Layer (`src/data/*.builder.ts` — DIP)
Centralize all test personas, inputs, and expected copy. Never hardcode credentials, URLs, or magic strings in `tests/*.spec.ts`:
```ts
export interface UserCredentials {
  readonly role: string;
  readonly username: string;
  readonly password: string;
  readonly expectedError?: string;
}
```

---

## 5. Fixture Layer (`src/fixtures/app.fixture.ts` — OCP & ISP)
Expose modular Page/Component fixtures via `test.extend<>()` and re-export `expect`:
```ts
import { test as base, expect } from '@playwright/test';
// Extend and export test, expect
```

---

## 6. Multi-Page Spec & Cross-Page State (`tests/*.spec.ts`)
- Include the Session Tape `scenarioId` and `tags` (`@p0`, `@smoke`, `@regression`) in the `test.describe` or `test` title/details.
- When `capturedVariables` is present in the tape, read the runtime value from the source page locator (`const capturedTotal = await ...textContent()`) or API response (`source: "apiResponseJson"`) and assert it on downstream pages/portals using web-first assertions (`await expect(...)`).

---

## 7. Conditional Multi-Step Wizard Orchestration (`WizardStepContract<TRiskProfile>`)
For 5–12 step workflows (e.g., Motor/Home Insurance Quote & Buy wizards), keep every wizard section an atomic `≤ 150`-line component implementing `WizardStepContract<TRiskProfile>` (`@contracts/wizard-step.contract`), and orchestrate them in the Page class without `expect()`:
```ts
import type { Locator, Page } from '@playwright/test';
import type { WizardStepContract } from '@contracts/wizard-step.contract';
import type { MotorRiskProfile } from '@domains/motor-b2c/data/motor-risk.builder';

export class ClaimsHistoryStepComponent implements WizardStepContract<MotorRiskProfile> {
  readonly stepId = 'claims-history';
  readonly root: Locator;
  readonly claimDateInput: Locator;
  readonly continueButton: Locator;

  constructor(page: Page) {
    this.root = page.getByRole('region', { name: 'Claims History' });
    this.claimDateInput = this.root.getByLabel('Date of Incident');
    this.continueButton = this.root.getByRole('button', { name: 'Continue' });
  }

  isApplicable(profile: MotorRiskProfile): boolean {
    return profile.hasPriorClaims && Boolean(profile.priorClaimDate);
  }

  async completeStep(profile: MotorRiskProfile): Promise<void> {
    if (profile.priorClaimDate) {
      await this.claimDateInput.fill(profile.priorClaimDate);
    }
    await this.continueButton.click();
  }
}
```
And in the Wizard Page orchestrator:
```ts
export class MotorQuoteWizardPage {
  private readonly steps: ReadonlyArray<WizardStepContract<MotorRiskProfile>>;

  constructor(private readonly page: Page) {
    this.steps = [
      new VehicleLookupStepComponent(page),
      new DriverDetailsStepComponent(page),
      new ClaimsHistoryStepComponent(page),
      new CoverOptionsStepComponent(page),
    ];
  }

  async completeApplicableSteps(profile: MotorRiskProfile): Promise<void> {
    for (const step of this.steps) {
      if (step.isApplicable(profile)) {
        await step.completeStep(profile);
      }
    }
  }
}
```

---

## 8. Backend API Clients & `.auth` Token Bridge (`src/domains/<squad>/api/*.client.ts`)
Implement `ApiClientContract` (`@contracts/api-client.contract`) with **zero `expect()` calls**. Use `AuthTokenBridge.extractAuthHeaders('.auth/<persona>.json')` (`@shared/api/auth-token.bridge`) so backend API calls reuse SSO/MFA tokens captured by `/00-env-bootstrap`:
```ts
import type { APIRequestContext } from '@playwright/test';
import type { ApiClientContract, ApiResponseEnvelope } from '@contracts/api-client.contract';
import { AuthTokenBridge } from '@shared/api/auth-token.bridge';

export interface QuoteSeedResponse {
  readonly quoteId: string;
  readonly annualPremium: number;
  readonly referralRequired: boolean;
}

export class MotorQuoteApiClient implements ApiClientContract {
  constructor(
    readonly request: APIRequestContext,
    readonly baseUrl: string,
    private readonly storageStatePath?: string
  ) {}

  async createQuote<TPayload>(payload: TPayload): Promise<ApiResponseEnvelope<QuoteSeedResponse>> {
    const headers = this.storageStatePath
      ? AuthTokenBridge.extractAuthHeaders(this.storageStatePath)
      : {};
    const res = await this.request.post(`${this.baseUrl}/api/v1/quotes`, {
      data: payload,
      headers,
    });
    return {
      status: res.status(),
      ok: res.ok(),
      headers: res.headers(),
      body: (await res.json()) as QuoteSeedResponse,
    };
  }
}
```

---

## 9. Multi-Portal Cross-Actor Fixtures (`Customer Portal` ➔ `Back-Office Agent Portal`)
When a Session Tape declares `charter: "cross-portal-handoff"` and root `actors`, isolate each portal/persona in its own Playwright `BrowserContext` via `mergeTests()` so Customer and Back-Office Agent sessions never collide:
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
    const customerContext = await browser.newContext();
    const page = await customerContext.newPage();
    await use(new MotorQuoteWizardPage(page));
    await customerContext.close();
  },
  agentReferralPage: async ({ browser }, use) => {
    const agentContext = await browser.newContext({
      storageState: '.auth/underwriter_agent.json',
    });
    const page = await agentContext.newPage();
    await use(new AgentReferralQueuePage(page));
    await agentContext.close();
  },
});

export { expect };
```

---

## 10. Dynamic Risk-Persona Data Builders (`RelativeDateHelper`)
Use `RelativeDateHelper` (`@shared/data/relative-date.helper`) inside `src/domains/<squad>/data/*.builder.ts` to compute dynamic policy effective dates, driver DOBs, and prior claim dates at runtime without hardcoded calendar strings.
