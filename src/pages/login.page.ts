import type { Locator, Page } from '@playwright/test';
import { LoginFormComponent } from '@components/login-form.component';
import type { UserPersona } from '@data/user.builder';

/**
 * Composed Page Object for the Swag Labs entry view.
 * Contains zero expect() calls; delegates UI interactions to LoginFormComponent.
 */
export class LoginPage {
  readonly form: LoginFormComponent;
  readonly demoPasswordPanel: Locator;

  constructor(private readonly page: Page) {
    this.form = new LoginFormComponent(page);
    this.demoPasswordPanel = page.getByTestId('login-password');
  }

  async open(): Promise<void> {
    await this.page.goto('/');
  }

  async readDemoPassword(): Promise<string | undefined> {
    await this.form.usernameInput.waitFor({ state: 'visible' });
    if (!(await this.demoPasswordPanel.isVisible())) return undefined;
    const lines = (await this.demoPasswordPanel.innerText())
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith(':'));
    return lines[lines.length - 1];
  }

  async loginAs(persona: UserPersona): Promise<void> {
    const password = persona.password || (await this.readDemoPassword());
    if (!password) {
      throw new Error(
        'Missing required environment variable: TEST_PASSWORD. Set it in .env or CI secrets (or ensure the login page exposes demo credentials).'
      );
    }
    await this.form.submitCredentials(persona.username, password);
  }
}
