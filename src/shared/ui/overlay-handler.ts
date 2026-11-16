import type { Page } from '@playwright/test';

/**
 * Registers non-blocking Playwright locator handlers for unpredictable overlays
 * (e.g., cookie consent banners, promotional modals, NPS feedback surveys)
 * so E2E tests remain deterministic without littering business steps.
 */
export async function registerOverlayHandlers(page: Page): Promise<void> {
  const cookieAcceptButton = page
    .getByRole('dialog')
    .getByRole('button', { name: /accept( all)?( cookies)?|allow all|agree/i });

  await page.addLocatorHandler(cookieAcceptButton, async (locator) => {
    await locator.click();
  });

  const promoCloseButton = page
    .getByRole('dialog', { name: /offer|newsletter|survey|feedback|promo/i })
    .getByRole('button', { name: /close|dismiss|no thanks|skip/i });

  await page.addLocatorHandler(promoCloseButton, async (locator) => {
    await locator.click();
  });
}
