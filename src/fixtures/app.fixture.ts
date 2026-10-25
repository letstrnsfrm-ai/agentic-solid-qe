import { test as base, expect } from '@playwright/test';
import { LoginPage } from '@pages/login.page';
import { InventoryPage } from '@pages/inventory.page';

/**
 * Segregated Fixture Contract (OCP & ISP).
 * Specs inject only the Page or Component objects they need for a given scenario.
 */
export interface AppFixtures {
  loginPage: LoginPage;
  inventoryPage: InventoryPage;
}

export const test = base.extend<AppFixtures>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  inventoryPage: async ({ page }, use) => {
    await use(new InventoryPage(page));
  },
});

export { expect };
