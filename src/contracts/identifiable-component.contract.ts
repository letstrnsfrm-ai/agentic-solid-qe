import type { Locator } from '@playwright/test';

/**
 * Base contract (LSP) for all atomic UI Components.
 * Every component scopes its internal semantic locators to a deterministic root container.
 */
export interface IdentifiableComponent {
  readonly root: Locator;
}
