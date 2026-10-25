import type { Page } from '@playwright/test';
import { HeaderNavComponent } from '@components/header-nav.component';
import { InventoryListComponent } from '@components/inventory-list.component';

/**
 * Composed Page Object for the Swag Labs Inventory Catalog view.
 * Composes HeaderNavComponent and InventoryListComponent (SRP & OCP).
 */
export class InventoryPage {
  readonly header: HeaderNavComponent;
  readonly catalog: InventoryListComponent;

  constructor(private readonly page: Page) {
    this.header = new HeaderNavComponent(page);
    this.catalog = new InventoryListComponent(page);
  }

  async openDirect(): Promise<void> {
    await this.page.goto('/inventory.html');
  }
}
