import { test, expect } from "@playwright/test";

test.describe("dashboard terminal UI", () => {
  test("boots against the live server and shows empty runner/terminal states", async ({ page, request }) => {
    await request.post("/__test/scenario", { data: { name: "empty" } });
    await page.goto("/");

    await expect(page.locator("#target-repo")).toHaveText("e2e-owner/e2e-repo");
    await expect(page.locator("#runner-runs")).toContainText("No active runs");
    await expect(page.locator("#terminal-tabs")).toContainText("No active runs");
    await expect(page.locator("#terminal-output")).toContainText("Waiting for an active run");
  });

  test("renders multi-run terminal state, health banner, and tab switching", async ({ page, request }) => {
    await request.post("/__test/scenario", { data: { name: "multi-run" } });
    await page.goto("/");

    await expect(page.locator("#runner-count")).toContainText("4 Runs");
    await expect(page.locator("#terminal-health-banner")).toContainText("Orchestrator loop is not running");
    await expect(page.locator("#terminal-tabs button")).toHaveCount(2);
    await expect(page.locator("#terminal-tabs")).toContainText("EXECUTOR (");
    await expect(page.locator("#runner-runs")).toContainText("Open linked PR");

    await page.locator("#terminal-tabs button").nth(1).click();
    await expect(page.locator("#terminal-output")).toContainText("Executor primary initial log");
  });

  test("streams transcript updates and reveals recent finished runs when active-only is disabled", async ({
    page,
    request,
  }) => {
    await request.post("/__test/scenario", { data: { name: "multi-run" } });
    const state = await request.get("/__test/state").then((response) => response.json());

    await page.goto("/");
    await page.locator("#terminal-tabs button").nth(1).click();
    await expect(page.locator("#terminal-output")).toContainText("Executor primary initial log");

    await request.post("/__test/emit-transcript", {
      data: {
        runId: state.runs.primaryExecutor.runId,
        role: "EXECUTOR",
        section: "SYSTEM OBSERVATION",
        content: "Live transcript append",
      },
    });
    await expect(page.locator("#terminal-output")).toContainText("Live transcript append");

    await page.locator("#terminal-active-only-toggle").uncheck();
    await expect(page.locator("#terminal-tabs")).toContainText("REVIEWER");
  });
});
