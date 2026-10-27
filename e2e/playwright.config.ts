import { defineConfig, devices } from '@playwright/test';

// The suite drives a running stack. Locally:
//   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build
//   E2E_BASE_URL=http://localhost:8080 npm run e2e
// Testing the nginx stack (not the dev server) also exercises the Content-Security-Policy.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
