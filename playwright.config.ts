import fs from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const isCI = Boolean(process.env.CI || process.env.TF_BUILD);

// Load .env for local runs only (Node >= 20.12); CI supplies env vars directly.
if (!isCI) {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env present */
  }
}

function resolveSafeBaseUrl(rawUrl: string | undefined): string {
  const candidate = (rawUrl || '').trim();
  if (!candidate) return 'https://www.saucedemo.com';
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid BASE_URL protocol '${parsed.protocol}'. Only http: and https: are allowed.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Invalid BASE_URL: embedded credentials in URL are forbidden.');
  }
  return candidate;
}

const hasAuthSetup = fs.existsSync('tests/auth.setup.ts');
const systemMapReporter: [string][] = fs.existsSync('./scripts/system-map-reporter.mjs')
  ? [['./scripts/system-map-reporter.mjs']]
  : [];
const rawCdpPort = !isCI && /^\d{4,5}$/.test(process.env.EXPLORE_CDP_PORT || '')
  ? Number(process.env.EXPLORE_CDP_PORT)
  : undefined;
const exploreCdpPort =
  rawCdpPort !== undefined && rawCdpPort >= 1024 && rawCdpPort <= 65535 ? rawCdpPort : undefined;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 4 : undefined,
  reporter: process.env.PW_BLOB_REPORT === '1'
    ? [['blob']]
    : isCI
      ? [['html', { open: 'never' }], ['github'], ['junit', { outputFile: 'test-results/junit.xml' }], ...systemMapReporter]
      : [['list'], ['html', { open: 'never' }], ...systemMapReporter],
  use: {
    baseURL: resolveSafeBaseUrl(process.env.BASE_URL),
    // Match your app's test-id attribute (e.g. 'data-testid'); unused if you locate by role/label/placeholder.
    testIdAttribute: 'data-test',
    // Opt-in for local networks with TLS-intercepting proxies. Blocked in CI unless ALLOW_CI_INSECURE_TLS=1 is set.
    ignoreHTTPSErrors:
      process.env.IGNORE_HTTPS_ERRORS === '1' &&
      (!isCI || process.env.ALLOW_CI_INSECURE_TLS === '1'),
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
      use: {
        ...devices['Desktop Chrome'],
        ...(exploreCdpPort
          ? {
              launchOptions: {
                args: [
                  '--remote-debugging-address=127.0.0.1',
                  `--remote-debugging-port=${exploreCdpPort}`,
                ],
              },
            }
          : {}),
      },
      ...(hasAuthSetup ? { dependencies: ['setup'] } : {}),
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      ...(hasAuthSetup ? { dependencies: ['setup'] } : {}),
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      ...(hasAuthSetup ? { dependencies: ['setup'] } : {}),
    },
  ],
});
