import type { Locator, Page } from '@playwright/test';
import type { IdentifiableComponent } from '@contracts/identifiable-component.contract';

/**
 * Atomic SRP Component for the Shopping Cart container (/cart.html).
 */
export class CartListComponent implements IdentifiableComponent {
  readonly root: Locator;
  readonly cartItems: Locator;
  readonly checkoutButton: Locator;
  readonly continueShoppingButton: Locator;

  constructor(page: Page) {
    this.root = page.locator('#cart_contents_container');
    this.cartItems = this.root.getByTestId('inventory-item');
    this.checkoutButton = this.root.getByRole('button', { name: 'Checkout', exact: true });
    this.continueShoppingButton = this.root.getByRole('button', {
      name: 'Continue Shopping',
      exact: true,
    });
  }

  async proceedToCheckout(): Promise<void> {
    await this.checkoutButton.click();
  }
}
