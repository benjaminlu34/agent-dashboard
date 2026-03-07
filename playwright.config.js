import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.DASHBOARD_E2E_PORT || 4100);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./apps/web/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  webServer: {
    command: "node apps/web/e2e/support/server.js",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
