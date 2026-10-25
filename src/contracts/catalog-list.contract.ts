import type { Locator } from '@playwright/test';
import type { IdentifiableComponent } from './identifiable-component.contract';

/**
 * Liskov Substitution contract for repeatable product/item list widgets.
 */
export interface CatalogListContract extends IdentifiableComponent {
  readonly items: Locator;
  itemCardByName(productName: string): Locator;
  addItemToCart(productName: string): Promise<void>;
  removeItemFromCart(productName: string): Promise<void>;
}
