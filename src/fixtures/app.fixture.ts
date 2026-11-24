import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { LoginPage } from '@pages/login.page';
import { InventoryPage } from '@pages/inventory.page';
import { CheckoutPage } from '@pages/checkout.page';
import { registerOverlayHandlers } from '@shared/ui/overlay-handler';
import { holdForExplore } from '@shared/ui/explore-handshake';

/**
 * Segregated Fixture Contract (OCP & ISP).
 * Specs inject only the Page or Component objects they need for a given scenario.
 */
export interface AppFixtures {
  loginPage: LoginPage;
  inventoryPage: InventoryPage;
  checkoutPage: CheckoutPage;
  explorePause: void;
}

const activeExploreContexts = new Map<string, { page: Page; context: BrowserContext; held: boolean }>();

const isCI = Boolean(process.env.CI || process.env.TF_BUILD);

export const test = base.extend<AppFixtures>({
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  inventoryPage: async ({ page }, use) => {
    await use(new InventoryPage(page));
  },
  checkoutPage: async ({ page }, use) => {
    await use(new CheckoutPage(page));
  },
  explorePause: [
    async ({ page, context }, use, testInfo) => {
      await registerOverlayHandlers(page);
      const state = { page, context, held: false };
      activeExploreContexts.set(testInfo.testId, state);
      try {
        await use();
        if (!isCI && process.env.PW_PAUSE_FOR_EXPLORE === '1' && !state.held) {
          state.held = true;
          await holdForExplore(page, context);
        }
      } finally {
        activeExploreContexts.delete(testInfo.testId);
      }
    },
    { auto: true },
  ],
});

if (!isCI && process.env.PW_PAUSE_FOR_EXPLORE === '1' && process.env.PW_EXPLORE_UNTIL_STEP) {
  const targetStep = process.env.PW_EXPLORE_UNTIL_STEP.toLowerCase();
  const originalStep = test.step.bind(test);
  test.step = (async <T>(title: string, body: () => Promise<T>, options?: { box?: boolean }): Promise<T> => {
    const result = await originalStep(title, body, options);
    if (title.toLowerCase().includes(targetStep)) {
      let active: { page: Page; context: BrowserContext; held: boolean } | undefined;
      try {
        active = activeExploreContexts.get(test.info().testId);
      } catch {
        /* outside test context */
      }
      if (active && !active.held) {
        active.held = true;
        await holdForExplore(active.page, active.context, { pausedAtStep: title });
      }
    }
    return result;
  }) as typeof test.step;
}

export { expect };
