import type { Locator, Page } from '@playwright/test';
import type { ErrorBannerContract } from '@contracts/error-banner.contract';
import type { CustomerCheckoutInfo } from '@data/checkout.builder';

/**
 * Atomic SRP Component for Checkout Step One customer information form (/checkout-step-one.html).
 */
export class CheckoutFormComponent implements ErrorBannerContract {
  readonly root: Locator;
  readonly firstNameInput: Locator;
  readonly lastNameInput: Locator;
  readonly postalCodeInput: Locator;
  readonly continueButton: Locator;
  readonly cancelButton: Locator;
  readonly errorBanner: Locator;
  readonly dismissErrorButton: Locator;

  constructor(page: Page) {
    this.root = page.locator('#checkout_info_container');
    this.firstNameInput = this.root.getByPlaceholder('First Name', { exact: true });
    this.lastNameInput = this.root.getByPlaceholder('Last Name', { exact: true });
    this.postalCodeInput = this.root.getByPlaceholder('Zip/Postal Code', { exact: true });
    this.continueButton = this.root.getByRole('button', { name: 'Continue', exact: true });
    this.cancelButton = this.root.getByRole('button', { name: 'Cancel', exact: true });
    this.errorBanner = this.root.getByTestId('error');
    this.dismissErrorButton = this.root.getByTestId('error-button');
  }

  async submitCustomerInfo(customer: CustomerCheckoutInfo): Promise<void> {
    await this.firstNameInput.fill(customer.firstName);
    await this.lastNameInput.fill(customer.lastName);
    await this.postalCodeInput.fill(customer.postalCode);
    await this.continueButton.click();
  }

  async dismissError(): Promise<void> {
    await this.dismissErrorButton.click();
  }
}
