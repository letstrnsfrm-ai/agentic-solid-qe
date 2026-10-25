import type { Locator, Page } from '@playwright/test';
import type { CatalogListContract } from '@contracts/catalog-list.contract';

/**
 * Atomic SRP Component for the product catalog grid.
 * Uses hierarchical parent scoping on each product card to prevent Playwright strict-mode collisions.
 */
export class InventoryListComponent implements CatalogListContract {
  readonly root: Locator;
  readonly items: Locator;
  readonly itemNames: Locator;

  constructor(page: Page) {
    this.root = page.getByTestId('inventory-container');
    this.items = this.root.getByTestId('inventory-item');
    this.itemNames = this.root.getByTestId('inventory-item-name');
  }

  itemCardByName(productName: string): Locator {
    return this.items.filter({ hasText: productName });
  }

  itemActionButton(productName: string, actionLabel: 'Add to cart' | 'Remove'): Locator {
    return this.itemCardByName(productName).getByRole('button', {
      name: actionLabel,
      exact: true,
    });
  }

  async addItemToCart(productName: string): Promise<void> {
    await this.itemActionButton(productName, 'Add to cart').click();
  }

  async removeItemFromCart(productName: string): Promise<void> {
    await this.itemActionButton(productName, 'Remove').click();
  }
}
