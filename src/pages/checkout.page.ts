import type { Page } from '@playwright/test';
import { CartListComponent } from '@components/cart-list.component';
import { CheckoutFormComponent } from '@components/checkout-form.component';
import { CheckoutSummaryComponent } from '@components/checkout-summary.component';
import { HeaderNavComponent } from '@components/header-nav.component';

/**
 * Composed Page Object for Cart and Multi-Step Checkout workflows.
 */
export class CheckoutPage {
  readonly header: HeaderNavComponent;
  readonly cart: CartListComponent;
  readonly form: CheckoutFormComponent;
  readonly summary: CheckoutSummaryComponent;

  constructor(page: Page) {
    this.header = new HeaderNavComponent(page);
    this.cart = new CartListComponent(page);
    this.form = new CheckoutFormComponent(page);
    this.summary = new CheckoutSummaryComponent(page);
  }
}
