import { defineConfig, devices } from '@playwright/test';

// Load .env for local runs (Node >= 20.12); CI supplies env vars directly.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env present */
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github'], ['junit', { outputFile: 'test-results/junit.xml' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL || 'https://www.saucedemo.com',
    // Match your app's test-id attribute (e.g. 'data-testid'); unused if you locate by role/label/placeholder.
    testIdAttribute: 'data-test',
    // Opt-in for networks with TLS-intercepting proxies. Never enable against production.
    ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === '1',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
});
