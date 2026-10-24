import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests run against isolated servers: a fresh throwaway SQLite file, AI disabled (deterministic),
 * API on 3101 and the Vite dev server on 5174 so they never touch the developer's database.
 */
const API_PORT = '3101';
const WEB_PORT = '5174';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /responsive.spec.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: [
    {
      command: 'node -e "require(\'fs\').rmSync(\'data/e2e.sqlite\',{force:true});require(\'fs\').rmSync(\'data/e2e.sqlite-wal\',{force:true});require(\'fs\').rmSync(\'data/e2e.sqlite-shm\',{force:true})" && npx tsx server/index.ts',
      url: `http://localhost:${API_PORT}/api/health`,
      env: { API_PORT, DB_PATH: './data/e2e.sqlite', AI_PROVIDER: 'disabled', RATE_LIMIT_PER_MINUTE: '10000' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite',
      url: `http://localhost:${WEB_PORT}`,
      env: { API_PORT, WEB_PORT },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
