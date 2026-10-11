/**
 * Playwright for Nuzli (brief §14). Not installed in the repository yet:
 *   npm i -D @playwright/test && npx playwright install chromium
 *   npx playwright test -c e2e/playwright.config.ts
 *
 * Target: the GitHub Pages demo build served by `vite preview` (in-browser DemoApi), so the
 * offline E2E needs no backend. Override with E2E_BASE_URL (e.g. the Docker stack over HTTPS).
 */
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:4173/nuzli-project-management/';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'ar-SA',
    timezoneId: 'Asia/Riyadh',
    trace: 'retain-on-failure',
    // The service worker must be allowed for the offline reload.
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'mobile-360',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 360, height: 740 },
        deviceScaleFactor: 2,
        permissions: ['geolocation'],
        geolocation: { latitude: 24.71361, longitude: 46.67531, accuracy: 18 },
      },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run build:demo -w @nuzli/web && npm run preview:demo -w @nuzli/web',
        url: BASE_URL,
        cwd: '..',
        timeout: 180_000,
        reuseExistingServer: true,
      },
});
