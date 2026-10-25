import type { Page } from '@playwright/test';
import { LoginFormComponent } from '@components/login-form.component';
import type { UserPersona } from '@data/user.builder';

/**
 * Composed Page Object for the Swag Labs entry view.
 * Contains zero expect() calls; delegates UI interactions to LoginFormComponent.
 */
export class LoginPage {
  readonly form: LoginFormComponent;

  constructor(private readonly page: Page) {
    this.form = new LoginFormComponent(page);
  }

  async open(): Promise<void> {
    await this.page.goto('/');
  }

  async loginAs(persona: UserPersona): Promise<void> {
    await this.form.submitCredentials(persona.username, persona.password);
  }
}
