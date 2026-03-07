import assert from "node:assert/strict";
import test from "node:test";

import {
  UI_STORAGE_KEY_TERMINAL_ACTIVE_ONLY,
} from "../public/js/dashboard/constants.js";
import { createDashboardHarness } from "./helpers/dashboard-harness.js";

function runEntry({
  runId,
  role,
  status,
  receivedAt,
  runningAt,
  summary = "",
  errors = [],
  urls = {},
  blockedReason = "",
  outcome = "",
}) {
  return {
    run_id: runId,
    role,
    status,
    received_at: receivedAt,
    running_at: runningAt,
    result: {
      summary,
      errors,
      urls,
      blocked_reason: blockedReason,
      outcome,
    },
  };
}

test("dashboard terminal shows empty state for empty runner payloads", async () => {
  const harness = await createDashboardHarness({
    statusPayload: {
      orchestrator: {},
      runner: {},
    },
  });

  try {
    await harness.app.ready;
    assert.equal(harness.document.querySelector("#target-repo")?.textContent?.trim(), "test-owner/test-repo");
    assert.match(harness.document.querySelector("#runner-runs")?.textContent ?? "", /No active runs/);
    assert.match(harness.document.querySelector("#terminal-tabs")?.textContent ?? "", /No active runs/);
    assert.equal(harness.document.querySelector("#terminal-output")?.textContent?.trim(), "Waiting for an active run...");
  } finally {
    harness.destroy();
  }
});

test("dashboard terminal renders duplicate role tabs, health banner, and switches snapshots", async () => {
  const now = Date.now();
  const recentIso = new Date(now - 60_000).toISOString();
  const oldIso = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
  const statusPayload = {
    orchestrator: {},
    runner: {
      plan_version: "2026-03-07T00:00:00.000Z",
      runs: {
        "qa11-run-main": runEntry({
          runId: "qa11-run-main",
          role: "EXECUTOR",
          status: "running",
          receivedAt: recentIso,
          runningAt: recentIso,
          urls: { pr_url: "https://github.com/test-owner/test-repo/pull/51" },
        }),
        "qb22-run-side": runEntry({
          runId: "qb22-run-side",
          role: "EXECUTOR",
          status: "running",
          receivedAt: new Date(now - 30_000).toISOString(),
          runningAt: new Date(now - 30_000).toISOString(),
        }),
        "orch-failed-1": runEntry({
          runId: "orch-failed-1",
          role: "ORCHESTRATOR",
          status: "failed",
          receivedAt: oldIso,
          summary: "orchestrator failed",
          errors: [{ message: "network request failed" }],
        }),
      },
    },
  };

  const harness = await createDashboardHarness({
    statusPayload,
    logSnapshots: {
      "qa11-run-main": { logs: "executor-main\n", seq: 1, role: "EXECUTOR" },
      "qb22-run-side": { logs: "executor-side\n", seq: 1, role: "EXECUTOR" },
    },
  });

  try {
    await harness.app.ready;
    await harness.tick(10);
    assert.match(harness.document.querySelector("#terminal-tabs")?.textContent ?? "", /EXECUTOR \(qa11\)/);
    assert.match(harness.document.querySelector("#terminal-tabs")?.textContent ?? "", /EXECUTOR \(qb22\)/);
    assert.match(harness.document.querySelector("#runner-runs")?.innerHTML ?? "", /Open linked PR/);
    assert.match(harness.document.querySelector("#terminal-health-banner")?.textContent ?? "", /Orchestrator loop is not running/);
    assert.match(harness.document.querySelector("#terminal-output")?.textContent ?? "", /executor-side/);

    const buttons = harness.document.querySelectorAll("#terminal-tabs button[data-run-id]");
    assert.equal(buttons.length, 2);
    buttons[1].dispatchEvent(new harness.window.MouseEvent("click", { bubbles: true }));
    await harness.tick();

    assert.match(harness.document.querySelector("#terminal-output")?.textContent ?? "", /executor-main/);
  } finally {
    harness.destroy();
  }
});

test("dashboard terminal appends SSE logs, reconnects, and respects visibility pause", async () => {
  const recentIso = new Date(Date.now() - 10_000).toISOString();
  const runId = "qt33-stream-run";
  const harness = await createDashboardHarness({
    statusPayload: {
      orchestrator: {},
      runner: {
        runs: {
          [runId]: runEntry({
            runId,
            role: "EXECUTOR",
            status: "running",
            receivedAt: recentIso,
            runningAt: recentIso,
          }),
        },
      },
    },
    logSnapshots: {
      [runId]: { logs: "alpha\n", seq: 1, role: "EXECUTOR" },
    },
    terminalStreamReconnectMs: 10,
  });

  try {
    await harness.app.ready;
    await harness.tick(10);
    assert.equal(harness.eventSources.length, 1);
    const initialSource = harness.eventSources[0];
    initialSource.emit("transcript", {
      seq: 2,
      chunk: "beta\n",
      role: "EXECUTOR",
      run_id: runId,
      created_at: new Date().toISOString(),
    });
    await harness.tick();
    assert.match(harness.document.querySelector("#terminal-output")?.textContent ?? "", /alpha[\s\S]*beta/);

    initialSource.triggerError();
    await harness.tick(200);
    assert.equal(harness.eventSources.length >= 2, true);

    harness.setHidden(true);
    harness.document.dispatchEvent(new harness.window.Event("visibilitychange"));
    await harness.tick();
    assert.equal(harness.eventSources.at(-1)?.closed, true);

    harness.setHidden(false);
    harness.document.dispatchEvent(new harness.window.Event("visibilitychange"));
    await harness.tick(200);
    assert.equal(harness.eventSources.length >= 3, true);
  } finally {
    harness.destroy();
  }
});

test("dashboard terminal supports active-only toggling and logs fetch failures", async () => {
  const now = Date.now();
  const activeRunId = "ta11-active";
  const finishedRunId = "tb22-finished";
  const harness = await createDashboardHarness({
    statusPayload: {
      orchestrator: {},
      runner: {
        runs: {
          [activeRunId]: runEntry({
            runId: activeRunId,
            role: "EXECUTOR",
            status: "running",
            receivedAt: new Date(now - 5_000).toISOString(),
            runningAt: new Date(now - 5_000).toISOString(),
          }),
          [finishedRunId]: runEntry({
            runId: finishedRunId,
            role: "REVIEWER",
            status: "succeeded",
            receivedAt: new Date(now - 30_000).toISOString(),
            summary: "review complete",
            outcome: "PASS",
          }),
        },
      },
    },
    logSnapshots: {
      [activeRunId]: {
        status: 503,
        body: { error: "transcript store unavailable" },
      },
      [finishedRunId]: { logs: "review logs\n", seq: 1, role: "REVIEWER" },
    },
    terminalStreamReconnectMs: 5_000,
  });

  try {
    await harness.app.ready;
    await harness.tick();
    assert.match(harness.document.querySelector("#terminal-output")?.textContent ?? "", /Unable to load logs for ta11-active/);

    const toggle = harness.document.querySelector("#terminal-active-only-toggle");
    toggle.checked = false;
    toggle.dispatchEvent(new harness.window.Event("change", { bubbles: true }));
    await harness.tick();

    assert.match(harness.document.querySelector("#terminal-tabs")?.textContent ?? "", /REVIEWER/);
    assert.equal(harness.storage.getItem(UI_STORAGE_KEY_TERMINAL_ACTIVE_ONLY), "0");
  } finally {
    harness.destroy();
  }
});
