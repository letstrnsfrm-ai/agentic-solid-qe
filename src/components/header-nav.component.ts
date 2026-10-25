import type { Locator, Page } from '@playwright/test';
import type { IdentifiableComponent } from '@contracts/identifiable-component.contract';

/**
 * Atomic SRP Component for the primary navigation & secondary header bar.
 */
export class HeaderNavComponent implements IdentifiableComponent {
  readonly root: Locator;
  readonly pageTitle: Locator;
  readonly cartLink: Locator;
  readonly cartBadge: Locator;
  readonly sortDropdown: Locator;

  constructor(page: Page) {
    this.root = page.locator('#header_container');
    this.pageTitle = this.root.getByTestId('title');
    this.cartLink = this.root.getByTestId('shopping-cart-link');
    this.cartBadge = this.root.getByTestId('shopping-cart-badge');
    this.sortDropdown = this.root.getByTestId('product-sort-container');
  }

  async openCart(): Promise<void> {
    await this.cartLink.click();
  }

  async sortBy(sortCode: 'az' | 'za' | 'lohi' | 'hilo'): Promise<void> {
    await this.sortDropdown.selectOption(sortCode);
  }
}
