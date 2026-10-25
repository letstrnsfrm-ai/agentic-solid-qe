import type { Locator, Page } from '@playwright/test';
import type { ErrorBannerContract } from '@contracts/error-banner.contract';

/**
 * Atomic SRP Component representing the Swag Labs authentication form.
 * Exposes action methods and readonly semantic Locators (zero expect() calls).
 */
export class LoginFormComponent implements ErrorBannerContract {
  readonly root: Locator;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;
  readonly errorBanner: Locator;
  readonly dismissErrorButton: Locator;

  constructor(page: Page) {
    this.root = page.locator('#login_button_container');
    this.usernameInput = this.root.getByPlaceholder('Username', { exact: true });
    this.passwordInput = this.root.getByPlaceholder('Password', { exact: true });
    this.loginButton = this.root.getByRole('button', { name: 'Login', exact: true });
    this.errorBanner = this.root.getByTestId('error');
    this.dismissErrorButton = this.root.getByTestId('error-button');
  }

  async submitCredentials(username: string, password: string): Promise<void> {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.loginButton.click();
  }

  async dismissError(): Promise<void> {
    await this.dismissErrorButton.click();
  }
}
