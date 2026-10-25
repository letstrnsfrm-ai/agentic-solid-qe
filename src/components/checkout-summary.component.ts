import type { Locator, Page } from '@playwright/test';
import type { IdentifiableComponent } from '@contracts/identifiable-component.contract';

/**
 * Atomic SRP Component for Checkout Step Two Overview & Order Completion (/checkout-step-two.html & /checkout-complete.html).
 */
export class CheckoutSummaryComponent implements IdentifiableComponent {
  readonly root: Locator;
  readonly subtotalLabel: Locator;
  readonly taxLabel: Locator;
  readonly totalLabel: Locator;
  readonly finishButton: Locator;
  readonly confirmationHeading: Locator;
  readonly backHomeButton: Locator;

  constructor(page: Page) {
    this.root = page.locator('#contents_wrapper');
    this.subtotalLabel = this.root.getByTestId('subtotal-label');
    this.taxLabel = this.root.getByTestId('tax-label');
    this.totalLabel = this.root.getByTestId('total-label');
    this.finishButton = this.root.getByRole('button', { name: 'Finish', exact: true });
    this.confirmationHeading = this.root.getByRole('heading', {
      name: 'Thank you for your order!',
      exact: true,
    });
    this.backHomeButton = this.root.getByRole('button', { name: 'Back Home', exact: true });
  }

  async finishOrder(): Promise<void> {
    await this.finishButton.click();
  }
}
