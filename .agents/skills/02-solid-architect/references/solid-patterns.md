# Reference SOLID Playwright Patterns

Follow these exact TypeScript blueprints when compiling a Session Tape into `src/` and `tests/`.

---

## 1. Contract Layer (`src/contracts/*.contract.ts` — LSP)
Define lightweight structural interfaces for repeatable UI widgets:
```ts
import type { Locator } from '@playwright/test';

export interface IdentifiableComponent {
  readonly root: Locator;
}

export interface ErrorBannerContract {
  readonly errorBanner: Locator;
  dismissError(): Promise<void>;
}
```

---

## 2. Atomic Component Layer (`src/components/*.component.ts` — SRP, ≤ 150 lines, Zero `expect()`)
Scope child locators to `this.root` when `parentScope` is present in the Session Tape:
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

---

## 3. Page Composition Layer (`src/pages/*.page.ts` — SRP, Zero `expect()`)
Compose atomic components into higher-level page workflows:
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
Centralize all test personas, inputs, and expected copy:
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
Expose modular fixtures via `test.extend<>()` and re-export `expect`:
```ts
import { test as base, expect } from '@playwright/test';
// Extend and export test, expect
```
