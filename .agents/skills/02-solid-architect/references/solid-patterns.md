# Core SOLID Playwright Patterns (Contracts, Components, Pages, Builders, Specs)

> Read on-demand when authoring or refining standard UI Components, Pages, Data Builders, Fixtures, or `.spec.ts` files.

## 1. Contract Layer (`src/contracts/*.contract.ts` — LSP)
```ts
import type { Locator } from '@playwright/test';
export interface IdentifiableComponent { readonly root: Locator; }
export interface ErrorBannerContract extends IdentifiableComponent {
  readonly errorBanner: Locator;
  dismissError(): Promise<void>;
}
```

## 2. Atomic Component (`src/components/*.component.ts` — SRP, ≤ 150 lines, Zero `expect()`)
Scope child locators to `this.root` when `parentScope` exists; use `.filter({ hasText })` for dynamic cards/rows (`filterTextRef`):
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
Dynamic row helper: `itemCardByName(name: string): Locator { return this.root.getByTestId('inventory-item').filter({ hasText: name }); }`

## 3. Page Orchestrator (`src/pages/*.page.ts` — Zero `expect()`)
Compose atomic components; synchronize `waitForNetwork` / `waitForUrl` deterministically without sleeps:
```ts
export class LoginPage {
  readonly form: LoginFormComponent;
  constructor(private readonly page: Page) { this.form = new LoginFormComponent(page); }
  async open(): Promise<void> { await this.page.goto('/'); }
}
```

## 4. Data Builders (`src/data/*.builder.ts` — DIP) & Fixtures (`src/fixtures/app.fixture.ts` — OCP/ISP)
- Centralize all credentials, personas, inputs, and expected copy in typed Builders (zero hardcoded literals in `tests/*.spec.ts`).
- Expose modular Page/Component fixtures via `test.extend<>()` and re-export `expect`.

## 5. Business-Domain Specs (`tests/*.spec.ts`)
- Include `scenarioId` and CI tags (`@p0`, `@smoke`, `@regression`).
- Group related actions & web-first assertions inside `await test.step('<Business behaviour>', ...)` — describe *what* the business achieves, never UI mechanics (`click`, `fill`, `locator`).
- For `capturedVariables`, declare `let capturedVar = '';` outside `test.step()`, assign in the producing step, and assert downstream.
