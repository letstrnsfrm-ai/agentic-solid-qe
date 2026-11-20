# Complex UI Resilience, Relative Dates & Worker-Scoped Fixtures

> Read on-demand when handling overlays, iframes, portals, Shadow DOM, dynamic dates, or scaling fixtures to 500+ specs.

## 1. Complex UI Resilience Patterns
- **Cookie / Promo Overlays:** Register `page.addLocatorHandler()` in `@shared/ui/overlay-handler` (wired in `app.fixture.ts`) and pre-seed consent in `.auth/<persona>.json` — never pollute business steps with `if (await banner.isVisible())`.
- **Iframes (`iframeSelector`):** Scope child locators via `page.frameLocator('iframe[title="..."]')` inside the Component constructor.
- **Portal Dropdowns (`portalScope: true`):** When a combobox renders `role="listbox"` under `document.body` outside `this.root`, root the option locator on `page` instead of `this.root`.
- **Custom / `sr-only` Radios (`force: true`):** Target `getByRole('radio', { name })` or `getByLabel(...)`; use `.check({ force: true })` when a styled `<label>` intercepts pointer events.
- **Shadow DOM:** Semantic locators (`getByRole`, `getByLabel`, `getByTestId`) pierce open Shadow DOM automatically; avoid XPath (`xpath=...`).
- **Native Dialogs & Popups:** Register `page.once('dialog', (d) => d.accept())` before the trigger; wrap popup triggers in `Promise.all([page.waitForEvent('popup'), trigger.click()])`.

## 2. Dynamic Dates (`RelativeDateHelper`)
Use `RelativeDateHelper` (`@shared/data/relative-date.helper`) inside `src/data/*.builder.ts` or `src/domains/<squad>/data/*.builder.ts` to generate deterministic relative policy effective dates, driver DOBs, and claim dates (`daysFromToday`, `yearsAgo`) so specs never rot on calendar dates.

## 3. High-Scale Worker-Scoped Auth & API Clients (`{ scope: 'worker' }`)
At 500+ specs, share an authenticated `APIRequestContext` or `.auth/<persona>.json` session per Playwright worker instead of re-minting per test:
```ts
export const test = base.extend<{}, { workerApi: MotorQuoteApiClient }>({
  workerApi: [
    async ({ playwright }, use) => {
      const apiContext = await playwright.request.newContext({
        baseURL: process.env.API_BASE_URL,
      });
      await use(new MotorQuoteApiClient(apiContext, process.env.API_BASE_URL!, '.auth/underwriter.json'));
      await apiContext.dispose();
    },
    { scope: 'worker' },
  ],
});
```
