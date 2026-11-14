import fs from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Load .env for local runs (Node >= 20.12); CI supplies env vars directly.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env present */
}

const hasAuthSetup = fs.existsSync('tests/auth.setup.ts');

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
    // Opt-in for local networks with TLS-intercepting proxies. Blocked in CI unless ALLOW_CI_INSECURE_TLS=1 is set.
    ignoreHTTPSErrors:
      process.env.IGNORE_HTTPS_ERRORS === '1' &&
      (!process.env.CI || process.env.ALLOW_CI_INSECURE_TLS === '1'),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    ...(hasAuthSetup ? [{ name: 'setup', testMatch: /.*\.setup\.ts/ }] : []),
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      ...(hasAuthSetup ? { dependencies: ['setup'] } : {}),
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
