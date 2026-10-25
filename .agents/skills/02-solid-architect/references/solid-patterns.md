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
- When `capturedVariables` is present in the tape, read the runtime value from the source page locator (`const capturedTotal = await ...textContent()`) and assert it on downstream pages using web-first assertions (`await expect(...)`).
