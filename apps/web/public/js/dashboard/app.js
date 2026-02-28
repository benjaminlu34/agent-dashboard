import {
  POLL_INTERVAL_MS,
  STATUS_NEEDS_HUMAN_APPROVAL,
  TERMINAL_LOG_CACHE_MAX_CHARS,
  TERMINAL_RECENT_WINDOW_MS,
  TERMINAL_STREAM_RECONNECT_MS,
  UI_STORAGE_KEY_SOUND_NEEDS_HUMAN_APPROVAL,
} from "./constants.js";
import {
  canvas,
  ctx,
  errorBannerEl,
  kickoffButtonLabelEl,
  kickoffButtonSpinnerEl,
  kickoffDetailsEl,
  kickoffFormEl,
  kickoffGoalEl,
  kickoffMessageEl,
  kickoffSprintEl,
  kickoffStartLoopButtonEl,
  kickoffStartLoopLabelEl,
  kickoffStartLoopSpinnerEl,
  kickoffStartRunnerLoopButtonEl,
  kickoffStartRunnerLoopLabelEl,
  kickoffStartRunnerLoopSpinnerEl,
  kickoffStopForceEl,
  kickoffStopOrchestratorsButtonEl,
  kickoffStopOrchestratorsLabelEl,
  kickoffStopOrchestratorsSpinnerEl,
  kickoffSubmitButtonEl,
  lastRefreshEl,
  orchestratorItemsEl,
  orchestratorSprintEl,
  orchestratorSummaryEl,
  runnerCountEl,
  runnerRunsEl,
  settingsBackdropEl,
  settingsCancelButtonEl,
  settingsCloseButtonEl,
  settingsFormEl,
  settingsGithubTokenEl,
  settingsMaxExecutorsEl,
  settingsMaxReviewersEl,
  settingsMessageEl,
  settingsModalEl,
  settingsOpenButtonEl,
  settingsProjectNumberEl,
  settingsSaveButtonEl,
  settingsSoundNeedsHumanApprovalEl,
  settingsTargetOwnerEl,
  settingsTargetRepoEl,
  targetRepoEl,
  terminalHealthBannerEl,
  terminalOutputEl,
  terminalTabsEl,
  terminalWindowEl,
} from "./dom.js";
import { createBackgroundAnimator } from "./background.js";
import {
  asObject,
  escapeHtml,
  formatTime,
  normalizeSprint,
  runBadgeClasses,
  statusBadgeClasses,
  toTimestampMs,
} from "./utils.js";

let isSettingsOpen = false;
let activeTerminalRunId = "";
let terminalRunIds = [];
const terminalLogCache = new Map();
const terminalLogSeqByRun = new Map();
const terminalRunMetaById = new Map();
let terminalStreamSource = null;
let terminalStreamRunId = "";
let terminalStreamReconnectTimerId = 0;
let terminalStreamSessionId = 0;
const settingsFieldByName = {
  targetOwner: settingsTargetOwnerEl,
  targetRepo: settingsTargetRepoEl,
  projectNumber: settingsProjectNumberEl,
  githubToken: settingsGithubTokenEl,
  maxExecutors: settingsMaxExecutorsEl,
  maxReviewers: settingsMaxReviewersEl,
};

const background = createBackgroundAnimator({ canvas, ctx });

let soundNeedsHumanApprovalEnabled = true;
let notificationAudioContext = null;
let hasOrchestratorSnapshot = false;
const previousOrchestratorStatusByItemId = new Map();
let kickoffWasAutoCollapsed = false;

function normalizeStatus(value) {
  return String(value ?? "").trim().toUpperCase();
}

function readStoredBoolean(key, defaultValue) {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return defaultValue;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no") {
      return false;
    }
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
  return defaultValue;
}

function writeStoredBoolean(key, value) {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

function loadUiPreferences() {
  soundNeedsHumanApprovalEnabled = readStoredBoolean(UI_STORAGE_KEY_SOUND_NEEDS_HUMAN_APPROVAL, true);
  if (settingsSoundNeedsHumanApprovalEl) {
    settingsSoundNeedsHumanApprovalEl.checked = soundNeedsHumanApprovalEnabled;
  }
}

function ensureNotificationAudioContext() {
  if (notificationAudioContext) {
    return notificationAudioContext;
  }

  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  notificationAudioContext = new AudioContextCtor();
  return notificationAudioContext;
}

async function unlockNotificationAudio() {
  const ctx = ensureNotificationAudioContext();
  if (!ctx) {
    return false;
  }
  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
  } catch {
    return false;
  }
  return ctx.state === "running";
}

function collapseKickoffSection({ force = false } = {}) {
  if (!kickoffDetailsEl) {
    return;
  }
  if (!kickoffDetailsEl.open) {
    kickoffWasAutoCollapsed = true;
    return;
  }
  if (!force && kickoffWasAutoCollapsed) {
    return;
  }
  kickoffDetailsEl.open = false;
  kickoffWasAutoCollapsed = true;
}

function handleNotificationAudioUnlockGesture() {
  if (!soundNeedsHumanApprovalEnabled) {
    return;
  }
  const ctx = ensureNotificationAudioContext();
  if (!ctx || ctx.state === "running") {
    return;
  }
  void unlockNotificationAudio();
}

function playNotificationBeep() {
  if (!soundNeedsHumanApprovalEnabled) {
    return;
  }

  const ctx = ensureNotificationAudioContext();
  if (!ctx) {
    return;
  }

  const play = () => {
    const now = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(880, now);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    oscillator.connect(gain);
    gain.connect(ctx.destination);

    oscillator.start(now);
    oscillator.stop(now + 0.24);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  };

  if (ctx.state !== "running") {
    void unlockNotificationAudio().then((unlocked) => {
      if (unlocked) {
        play();
      }
    });
    return;
  }

  play();
}

function detectReviewerNeedsHumanApprovalTransition(orchestrator) {
  const needsApproval = normalizeStatus(STATUS_NEEDS_HUMAN_APPROVAL);
  const itemsObj = asObject(orchestrator?.items);
  const nextStatuses = new Map();

  let shouldBeep = false;
  for (const [projectItemId, item] of Object.entries(itemsObj)) {
    const nextStatusRaw = item?.last_seen_status ?? "";
    const nextStatus = normalizeStatus(nextStatusRaw);
    nextStatuses.set(projectItemId, nextStatus);

    if (!hasOrchestratorSnapshot) {
      continue;
    }

    const previousStatus = previousOrchestratorStatusByItemId.get(projectItemId);
    if (typeof previousStatus !== "string" || !previousStatus) {
      continue;
    }

    if (previousStatus === needsApproval || nextStatus !== needsApproval) {
      continue;
    }

    const lastRole = String(item?.last_dispatched_role ?? "").trim().toUpperCase();
    if (lastRole !== "REVIEWER") {
      continue;
    }

    shouldBeep = true;
  }

  previousOrchestratorStatusByItemId.clear();
  for (const [projectItemId, status] of nextStatuses.entries()) {
    previousOrchestratorStatusByItemId.set(projectItemId, status);
  }
  hasOrchestratorSnapshot = true;

  return shouldBeep;
}

function deriveTargetFromData(orchestrator, runner, ownerHeader, repoHeader) {
  if (ownerHeader && repoHeader) {
    return `${ownerHeader}/${repoHeader}`;
  }

  const runnerEntries = Object.values(asObject(runner));
  for (const entry of runnerEntries) {
    const prUrl =
      entry?.result?.pr_url ??
      entry?.result?.urls?.pr_url ??
      entry?.result?.urls?.pull_request ??
      entry?.result?.pull_request_url;
    if (typeof prUrl !== "string") {
      continue;
    }
    const match = prUrl.match(/github\.com\/([^/]+)\/([^/]+)/i);
    if (match?.[1] && match?.[2]) {
      return `${match[1]}/${match[2]}`;
    }
  }

  const sprintPlanTarget = orchestrator?.sprint_plan?.target;
  if (typeof sprintPlanTarget === "string" && sprintPlanTarget.includes("/")) {
    return sprintPlanTarget;
  }

  return "Unknown / Unknown";
}

function deriveSprint(orchestrator) {
  const sprintFromPlan = orchestrator?.sprint_plan?.sprint;
  if (typeof sprintFromPlan === "string" && sprintFromPlan.trim()) {
    return sprintFromPlan.trim();
  }

  const items = Object.values(asObject(orchestrator?.items));
  for (const item of items) {
    const sprint = item?.last_seen_sprint;
    if (typeof sprint === "string" && sprint.trim()) {
      return sprint.trim();
    }
  }

  return "N/A";
}

function renderOrchestrator(orchestrator) {
  const itemsObj = asObject(orchestrator?.items);
  const entries = Object.entries(itemsObj)
    .map(([projectItemId, value]) => ({
      projectItemId,
      issueNumber: Number(value?.last_seen_issue_number ?? 0),
      issueTitle: typeof value?.last_seen_issue_title === "string" ? value.last_seen_issue_title.trim() : "",
      status: String(value?.last_seen_status ?? "Unknown"),
      lastSeenAt: value?.last_seen_at ?? "",
      statusSinceAt: value?.status_since_at ?? "",
      lastRole: value?.last_dispatched_role ?? "",
      lastRunId: value?.last_run_id ?? "",
      reviewCycles: Number(value?.review_cycle_count ?? 0),
    }))
    .sort((left, right) => {
      if (left.issueNumber && right.issueNumber && left.issueNumber !== right.issueNumber) {
        return left.issueNumber - right.issueNumber;
      }
      return String(left.projectItemId).localeCompare(String(right.projectItemId));
    });

  const statusCounts = {};
  for (const entry of entries) {
    statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
  }

  orchestratorSummaryEl.innerHTML = "";
  const statusPairs = Object.entries(statusCounts);
  orchestratorSummaryEl.classList.toggle("hidden", statusPairs.length === 0);
  if (statusPairs.length > 0) {
    orchestratorSummaryEl.innerHTML = statusPairs
      .map(
        ([status, count]) =>
          `<span class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClasses(status)}">${escapeHtml(status)} <span class="text-[11px] opacity-80">${count}</span></span>`,
      )
      .join("");
  }

  if (entries.length === 0) {
    orchestratorItemsEl.innerHTML = `
      <div class="rounded-2xl border border-dashed border-zinc-800 bg-black px-6 py-10 text-center">
        <p class="text-sm font-medium text-zinc-100">Awaiting sprint kickoff</p>
        <p class="mt-2 text-xs text-zinc-500">Start Runner Loop or Kickoff to populate sprint items.</p>
      </div>
    `;
    return;
  }

  orchestratorItemsEl.innerHTML = entries
    .map(
      (entry) => `
        <article class="rounded-xl border border-zinc-800 bg-black p-4 shadow-md shadow-white/5 transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-white/10">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p class="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Issue</p>
              <h3 class="mt-1 text-base font-medium text-zinc-100">${
                entry.issueNumber > 0 ? `#${entry.issueNumber}` : "Unnumbered Issue"
              }${
                entry.issueTitle ? ` · ${escapeHtml(entry.issueTitle)}` : ""
              }</h3>
            </div>
            <span class="inline-flex rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClasses(entry.status)}">${escapeHtml(entry.status)}</span>
          </div>
          <div class="mt-3 grid gap-2 text-[11px] text-zinc-500 sm:grid-cols-2">
            <p>Last seen: <span class="font-medium text-zinc-300">${escapeHtml(formatTime(entry.lastSeenAt))}</span></p>
            <p>In status since: <span class="font-medium text-zinc-300">${escapeHtml(formatTime(entry.statusSinceAt))}</span></p>
            <p>Last dispatch role: <span class="font-medium text-zinc-300">${escapeHtml(entry.lastRole || "—")}</span></p>
            <p>Review cycles: <span class="font-medium text-zinc-300">${Number.isFinite(entry.reviewCycles) ? entry.reviewCycles : 0}</span></p>
          </div>
          ${
            entry.lastRunId
              ? `<p class="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-[10px] text-zinc-500">run_id: <span class="font-mono text-[10px] text-zinc-300">${escapeHtml(entry.lastRunId)}</span></p>`
              : ""
          }
        </article>
      `,
    )
    .join("");
}

function buildRunnerEntries(runner) {
  return Object.values(asObject(runner))
    .filter((value) => value && typeof value === "object")
    .map((value) => {
      const normalizedStatus = normalizeStatus(value?.status ?? "");
      const timestamp =
        value?.running_at ??
        value?.result?.completed_at ??
        value?.result?.finished_at ??
        value?.result?.updated_at ??
        value?.received_at;

      const blockedReason =
        value?.result?.blocked_reason ??
        value?.result?.reason ??
        value?.result?.error ??
        value?.result?.message ??
        "";
      const summary = typeof value?.result?.summary === "string" ? value.result.summary : "";
      const errorMessages = Array.isArray(value?.result?.errors)
        ? value.result.errors
            .map((errorEntry) => {
              if (errorEntry && typeof errorEntry === "object") {
                const message = errorEntry.message ?? errorEntry.error ?? errorEntry.code;
                return typeof message === "string" ? message.trim() : "";
              }
              return typeof errorEntry === "string" ? errorEntry.trim() : "";
            })
            .filter((message) => message.length > 0)
        : [];

      const timestampMs = toTimestampMs(timestamp);
      return {
        runId: value?.run_id ?? "",
        role: value?.role ?? "UNKNOWN",
        status: value?.status ?? "unknown",
        isRunning: normalizedStatus === "RUNNING",
        timestamp,
        timestampMs,
        receivedAt: value?.received_at ?? "",
        outcome: value?.result?.outcome ?? "",
        summary,
        errorMessages,
        blockedReason: typeof blockedReason === "string" ? blockedReason : "",
        prUrl:
          value?.result?.pr_url ??
          value?.result?.urls?.pr_url ??
          value?.result?.urls?.pull_request ??
          "",
      };
    })
    .sort((left, right) => {
      if (left.isRunning !== right.isRunning) {
        return left.isRunning ? -1 : 1;
      }
      return right.timestampMs - left.timestampMs;
    })
    .slice(0, 200);
}

function collectTerminalRunIds(runnerEntries) {
  const nowMs = Date.now();
  const runIds = [];
  const seen = new Set();
  for (const entry of runnerEntries) {
    const runId = String(entry?.runId ?? "").trim();
    if (!runId || seen.has(runId)) {
      continue;
    }

    const normalizedStatus = String(entry?.status ?? "").toUpperCase();
    const isRunning = normalizedStatus === "RUNNING";
    const isFinished = normalizedStatus === "SUCCEEDED" || normalizedStatus === "FAILED" || normalizedStatus === "SKIPPED";
    const isRecentlyFinished = isFinished && entry.timestampMs > 0 && nowMs - entry.timestampMs <= TERMINAL_RECENT_WINDOW_MS;

    if (!isRunning && !isRecentlyFinished) {
      continue;
    }

    seen.add(runId);
    runIds.push(runId);
  }
  return runIds;
}

function normalizeRoleLabel(value) {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized) {
    return normalized;
  }
  return "AGENT";
}

function shortRunSuffix(runId) {
  const normalized = String(runId ?? "").replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
  if (!normalized) {
    return "0000";
  }
  return normalized.slice(0, 4);
}

function isScrolledToBottom(element) {
  if (!element) {
    return true;
  }
  return element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
}

function renderTerminalOutput(logs) {
  const shouldStickToBottom = isScrolledToBottom(terminalWindowEl);
  const content = typeof logs === "string" && logs.length > 0 ? logs : "No logs available for this run yet.";
  terminalOutputEl.textContent = content;
  if (shouldStickToBottom) {
    terminalWindowEl.scrollTop = terminalWindowEl.scrollHeight;
  }
}

function renderTerminalTabs() {
  if (terminalRunIds.length === 0) {
    terminalTabsEl.innerHTML = `
      <li class="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">No active runs</li>
    `;
    terminalOutputEl.textContent = "Waiting for an active or recently finished run...";
    return;
  }

  const roleCounts = {};
  for (const runId of terminalRunIds) {
    const role = normalizeRoleLabel(terminalRunMetaById.get(runId)?.role);
    roleCounts[role] = (roleCounts[role] ?? 0) + 1;
  }

  terminalTabsEl.innerHTML = terminalRunIds
    .map((runId) => {
      const isActive = runId === activeTerminalRunId;
      const role = normalizeRoleLabel(terminalRunMetaById.get(runId)?.role);
      const label = roleCounts[role] > 1 ? `${role} (${shortRunSuffix(runId)})` : role;
      return `
        <li>
          <button
            type="button"
            data-run-id="${escapeHtml(runId)}"
            class="border-r border-zinc-800 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] transition ${
              isActive ? "bg-zinc-800 text-white" : "bg-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            }"
          >
            ${escapeHtml(label)}
          </button>
        </li>
      `;
    })
    .join("");

  const cachedLogs = terminalLogCache.get(activeTerminalRunId);
  if (typeof cachedLogs === "string") {
    renderTerminalOutput(cachedLogs);
    return;
  }
  terminalOutputEl.textContent = "Loading logs...";
}

function setActiveTerminalRun(runId) {
  const normalizedRunId = String(runId ?? "").trim();
  if (!normalizedRunId || !terminalRunIds.includes(normalizedRunId)) {
    return;
  }
  if (normalizedRunId === activeTerminalRunId) {
    return;
  }
  activeTerminalRunId = normalizedRunId;
  renderTerminalTabs();
  restartTerminalStreamNow();
}

function syncTerminalRuns(runnerEntries) {
  const previousRunKey = terminalRunIds.join("|");
  const previousActiveRunId = activeTerminalRunId;
  terminalRunIds = collectTerminalRunIds(runnerEntries);
  terminalRunMetaById.clear();
  for (const entry of runnerEntries) {
    const runId = String(entry?.runId ?? "").trim();
    if (!runId || !terminalRunIds.includes(runId)) {
      continue;
    }
    if (!terminalRunMetaById.has(runId)) {
      terminalRunMetaById.set(runId, entry);
    }
  }
  if (terminalRunIds.length === 0) {
    activeTerminalRunId = "";
    terminalLogCache.clear();
    terminalLogSeqByRun.clear();
    closeTerminalStream();
    clearTerminalStreamReconnectTimer();
    renderTerminalTabs();
    return;
  }

  for (const runId of Array.from(terminalLogCache.keys())) {
    if (!terminalRunIds.includes(runId) && runId !== activeTerminalRunId) {
      terminalLogCache.delete(runId);
    }
  }
  for (const runId of Array.from(terminalLogSeqByRun.keys())) {
    if (!terminalRunIds.includes(runId) && runId !== activeTerminalRunId) {
      terminalLogSeqByRun.delete(runId);
    }
  }

  if (!terminalRunIds.includes(activeTerminalRunId)) {
    activeTerminalRunId = terminalRunIds[0];
  }

  renderTerminalTabs();
  const nextRunKey = terminalRunIds.join("|");
  const runSetChanged = previousRunKey !== nextRunKey;
  const activeChanged = previousActiveRunId !== activeTerminalRunId;
  const streamMismatched = terminalStreamRunId !== activeTerminalRunId;
  if (runSetChanged || activeChanged || streamMismatched || !terminalStreamSource) {
    restartTerminalStreamNow();
  }
}

function clearTerminalStreamReconnectTimer() {
  if (terminalStreamReconnectTimerId) {
    window.clearTimeout(terminalStreamReconnectTimerId);
    terminalStreamReconnectTimerId = 0;
  }
}

function closeTerminalStream() {
  if (terminalStreamSource) {
    terminalStreamSource.close();
    terminalStreamSource = null;
  }
  terminalStreamRunId = "";
}

function capTerminalLogs(logs) {
  const value = typeof logs === "string" ? logs : "";
  if (value.length <= TERMINAL_LOG_CACHE_MAX_CHARS) {
    return value;
  }
  return value.slice(value.length - TERMINAL_LOG_CACHE_MAX_CHARS);
}

async function loadTerminalSnapshot(runId, sessionId) {
  const response = await fetch(`/internal/logs/${encodeURIComponent(runId)}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const payload = asObject(await response.json());
  const logs = capTerminalLogs(typeof payload.logs === "string" ? payload.logs : "");
  const seq = Number.isInteger(payload.seq) && payload.seq > 0 ? payload.seq : 0;
  terminalLogCache.set(runId, logs);
  terminalLogSeqByRun.set(runId, seq);
  if (sessionId === terminalStreamSessionId && runId === activeTerminalRunId) {
    renderTerminalOutput(logs);
  }
}

function scheduleTerminalStreamReconnect(sessionId, delayMs = TERMINAL_STREAM_RECONNECT_MS) {
  clearTerminalStreamReconnectTimer();
  terminalStreamReconnectTimerId = window.setTimeout(() => {
    if (sessionId !== terminalStreamSessionId) {
      return;
    }
    void startTerminalStreamSession(sessionId);
  }, Math.max(250, Number(delayMs) || 0));
}

function connectTerminalStream(runId, sessionId) {
  if (document.hidden || !runId || runId !== activeTerminalRunId || sessionId !== terminalStreamSessionId) {
    return;
  }

  const after = terminalLogSeqByRun.get(runId) ?? 0;
  const source = new EventSource(`/internal/logs/stream/${encodeURIComponent(runId)}?after=${encodeURIComponent(after)}`);
  terminalStreamSource = source;
  terminalStreamRunId = runId;

  source.addEventListener("transcript", (event) => {
    if (sessionId !== terminalStreamSessionId || runId !== activeTerminalRunId) {
      return;
    }
    let payload = {};
    try {
      payload = asObject(JSON.parse(event.data || "{}"));
    } catch {
      payload = {};
    }
    const chunk = typeof payload.chunk === "string" ? payload.chunk : "";
    if (!chunk) {
      return;
    }
    const seq = Number.isInteger(payload.seq) && payload.seq > 0 ? payload.seq : 0;
    const currentSeq = terminalLogSeqByRun.get(runId) ?? 0;
    if (seq > 0 && seq <= currentSeq) {
      return;
    }
    const previous = terminalLogCache.get(runId) ?? "";
    const nextLogs = capTerminalLogs(`${previous}${chunk}`);
    terminalLogCache.set(runId, nextLogs);
    if (seq > 0) {
      terminalLogSeqByRun.set(runId, seq);
    }
    renderTerminalOutput(nextLogs);
  });

  source.addEventListener("ping", () => {});

  source.onerror = () => {
    if (sessionId !== terminalStreamSessionId || source !== terminalStreamSource || runId !== activeTerminalRunId) {
      return;
    }
    closeTerminalStream();
    scheduleTerminalStreamReconnect(sessionId);
  };
}

async function startTerminalStreamSession(sessionId) {
  const runId = activeTerminalRunId;
  if (!runId || document.hidden || sessionId !== terminalStreamSessionId) {
    return;
  }
  try {
    await loadTerminalSnapshot(runId, sessionId);
  } catch (error) {
    if (sessionId !== terminalStreamSessionId || runId !== activeTerminalRunId) {
      return;
    }
    if (!terminalLogCache.has(runId)) {
      terminalOutputEl.textContent = `Unable to load logs for ${runId}: ${error?.message ?? "Unknown error"}`;
    }
    scheduleTerminalStreamReconnect(sessionId);
    return;
  }
  if (sessionId !== terminalStreamSessionId || runId !== activeTerminalRunId || document.hidden) {
    return;
  }
  connectTerminalStream(runId, sessionId);
}

function restartTerminalStreamNow() {
  terminalStreamSessionId += 1;
  const sessionId = terminalStreamSessionId;
  closeTerminalStream();
  clearTerminalStreamReconnectTimer();
  if (!activeTerminalRunId || document.hidden) {
    return;
  }
  void startTerminalStreamSession(sessionId);
}

function deriveRunFailureDetail(entry) {
  const parts = [];
  const summary = typeof entry?.summary === "string" ? entry.summary.trim() : "";
  if (summary.length > 0) {
    parts.push(summary);
  }

  const errorMessages = Array.isArray(entry?.errorMessages) ? entry.errorMessages : [];
  for (const message of errorMessages.slice(0, 3)) {
    if (typeof message !== "string") {
      continue;
    }
    const normalized = message.trim();
    if (!normalized || parts.includes(normalized)) {
      continue;
    }
    parts.push(normalized);
  }

  const blockedReason = typeof entry?.blockedReason === "string" ? entry.blockedReason.trim() : "";
  if (blockedReason && !parts.includes(blockedReason)) {
    parts.push(blockedReason);
  }

  if (parts.length === 0) {
    return "";
  }
  return parts.join(" | ");
}

function setTerminalHealthBanner(message) {
  const normalized = String(message ?? "").trim();
  if (!normalized) {
    terminalHealthBannerEl.textContent = "";
    terminalHealthBannerEl.classList.add("hidden");
    return;
  }
  terminalHealthBannerEl.textContent = normalized;
  terminalHealthBannerEl.classList.remove("hidden");
}

function renderTerminalHealth(entries) {
  const latestOrchestrator = entries.find((entry) => String(entry?.role ?? "").toUpperCase() === "ORCHESTRATOR");
  const orchestratorRunning = entries.some(
    (entry) =>
      String(entry?.role ?? "").toUpperCase() === "ORCHESTRATOR" &&
      String(entry?.status ?? "").toUpperCase() === "RUNNING",
  );

  if (orchestratorRunning || !latestOrchestrator) {
    setTerminalHealthBanner("");
    return;
  }

  const latestStatus = String(latestOrchestrator?.status ?? "").toUpperCase();
  if (latestStatus !== "FAILED") {
    setTerminalHealthBanner("");
    return;
  }

  const detail = deriveRunFailureDetail(latestOrchestrator) || "No detailed error message was captured.";
  const atTime = formatTime(latestOrchestrator.timestamp || latestOrchestrator.receivedAt);
  setTerminalHealthBanner(
    `Orchestrator loop is not running. Last run failed at ${atTime}. ${detail} Restart Runner Loop after resolving this error.`,
  );
}

function renderRunner(entries) {
  runnerCountEl.textContent = `${entries.length} Run${entries.length === 1 ? "" : "s"}`;

  if (entries.length === 0) {
    runnerRunsEl.innerHTML = `
      <div class="rounded-2xl border border-dashed border-zinc-800 bg-black px-5 py-10 text-center">
        <p class="text-sm font-medium text-zinc-100">No active runs</p>
        <p class="mt-2 text-xs text-zinc-500">Start Runner Loop to populate this ledger.</p>
      </div>
    `;
    return;
  }

  runnerRunsEl.innerHTML = entries
    .map((entry) => {
      const normalizedStatus = normalizeStatus(entry.status);
      const isRunning = Boolean(entry?.isRunning);
      const isDimmed = !isRunning;
      const showBlocked = normalizedStatus === "FAILED" || normalizedStatus === "BLOCKED";
      const failureDetail = deriveRunFailureDetail(entry);
      const headerToneClass = isRunning ? "text-zinc-100" : "text-zinc-500";
      return `
        <article class="relative rounded-xl border border-zinc-800 bg-black p-4 shadow-md shadow-white/5 ${isDimmed ? "opacity-75" : ""}">
          <div class="absolute left-0 top-5 h-4 w-1 rounded-r-full ${showBlocked ? "bg-zinc-500" : "bg-white/70"}"></div>
          <div class="flex flex-wrap items-start justify-between gap-3 pl-3">
            <div>
              <p class="text-[10px] font-semibold uppercase tracking-[0.16em] ${headerToneClass}">${escapeHtml(entry.role)}</p>
              <p class="mt-1 text-[11px] font-mono font-medium ${isRunning ? "text-zinc-100" : "text-zinc-500"}">${entry.runId ? escapeHtml(entry.runId) : "Unknown run"}</p>
              <p class="mt-1 text-[11px] text-zinc-500">${escapeHtml(formatTime(entry.timestamp || entry.receivedAt))}</p>
            </div>
            <span class="inline-flex rounded-full px-3 py-1 text-xs font-medium ${runBadgeClasses(entry.status)}">${escapeHtml(String(entry.status).toUpperCase())}</span>
          </div>
          ${
            entry.outcome
              ? `<p class="mt-3 pl-3 text-[11px] text-zinc-500">Outcome: <span class="font-medium text-zinc-300">${escapeHtml(entry.outcome)}</span></p>`
              : ""
          }
          ${
            showBlocked && failureDetail
              ? `<p class="mt-3 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2 text-xs text-zinc-300">${escapeHtml(failureDetail)}</p>`
              : ""
          }
          ${
            entry.prUrl
              ? `<a class="mt-3 inline-flex pl-3 text-xs font-semibold text-zinc-200 underline decoration-zinc-600 underline-offset-4 hover:text-white" target="_blank" rel="noreferrer" href="${escapeHtml(entry.prUrl)}">Open linked PR</a>`
              : ""
          }
        </article>
      `;
    })
    .join("");
}

function showError(message) {
  errorBannerEl.textContent = message;
  errorBannerEl.classList.remove("hidden");
}

function clearError() {
  errorBannerEl.textContent = "";
  errorBannerEl.classList.add("hidden");
}

function setSettingsOpen(nextOpen) {
  isSettingsOpen = Boolean(nextOpen);
  settingsModalEl.classList.toggle("hidden", !isSettingsOpen);
  document.body.classList.toggle("overflow-hidden", isSettingsOpen);

  if (isSettingsOpen) {
    settingsTargetOwnerEl.focus();
  }
}

function showSettingsMessage(message, type = "info") {
  settingsMessageEl.textContent = message;
  settingsMessageEl.classList.remove("hidden", "border-zinc-700", "text-zinc-200", "border-zinc-500", "text-white");
  if (type === "error") {
    settingsMessageEl.classList.add("border-zinc-700", "bg-zinc-900", "text-zinc-200");
    return;
  }
  settingsMessageEl.classList.add("border-zinc-500", "bg-zinc-900", "text-white");
}

function clearSettingsMessage() {
  settingsMessageEl.textContent = "";
  settingsMessageEl.classList.add("hidden");
}

function setSettingsLoading(isLoading) {
  settingsSaveButtonEl.disabled = Boolean(isLoading);
  settingsSaveButtonEl.textContent = isLoading ? "Saving..." : "Save Settings";
}

function showKickoffMessage(message, type = "success") {
  kickoffMessageEl.textContent = message;
  kickoffMessageEl.classList.remove(
    "hidden",
    "border-zinc-700",
    "border-zinc-500",
    "text-zinc-200",
    "text-white",
  );

  kickoffMessageEl.classList.add("bg-zinc-900");
  if (type === "error") {
    kickoffMessageEl.classList.add("border-zinc-700", "text-zinc-200");
    return;
  }
  kickoffMessageEl.classList.add("border-zinc-500", "text-white");
}

function clearKickoffMessage() {
  kickoffMessageEl.textContent = "";
  kickoffMessageEl.classList.add("hidden");
}

function setKickoffLoading(isLoading) {
  const nextLoading = Boolean(isLoading);
  kickoffSubmitButtonEl.disabled = nextLoading;
  kickoffGoalEl.disabled = nextLoading;
  kickoffStartLoopButtonEl.disabled = nextLoading;
  kickoffStartRunnerLoopButtonEl.disabled = nextLoading;
  kickoffStopOrchestratorsButtonEl.disabled = nextLoading;
  kickoffStopForceEl.disabled = nextLoading;
  kickoffButtonSpinnerEl.classList.toggle("hidden", !nextLoading);
  kickoffButtonLabelEl.textContent = nextLoading ? "Saving..." : "Save Goal (Step 1)";
}

function setKickoffLoopLoading(isLoading) {
  setLoopStartLoading({
    isLoading,
    spinnerEl: kickoffStartLoopSpinnerEl,
    labelEl: kickoffStartLoopLabelEl,
    idleLabel: "Start Kickoff Loop (Step 2)",
  });
}

function setRunnerLoopLoading(isLoading) {
  setLoopStartLoading({
    isLoading,
    spinnerEl: kickoffStartRunnerLoopSpinnerEl,
    labelEl: kickoffStartRunnerLoopLabelEl,
    idleLabel: "Start Runner Loop (No Kickoff)",
  });
}

function setLoopStartLoading({ isLoading, spinnerEl, labelEl, idleLabel }) {
  const nextLoading = Boolean(isLoading);
  kickoffStartLoopButtonEl.disabled = nextLoading;
  kickoffStartRunnerLoopButtonEl.disabled = nextLoading;
  kickoffStopOrchestratorsButtonEl.disabled = nextLoading;
  kickoffStopForceEl.disabled = nextLoading;
  kickoffSprintEl.disabled = nextLoading;
  spinnerEl.classList.toggle("hidden", !nextLoading);
  labelEl.textContent = nextLoading ? "Starting..." : idleLabel;
}

function setStopOrchestratorsLoading(isLoading) {
  const nextLoading = Boolean(isLoading);
  kickoffSubmitButtonEl.disabled = nextLoading;
  kickoffGoalEl.disabled = nextLoading;
  kickoffStartLoopButtonEl.disabled = nextLoading;
  kickoffStartRunnerLoopButtonEl.disabled = nextLoading;
  kickoffStopOrchestratorsButtonEl.disabled = nextLoading;
  kickoffStopForceEl.disabled = nextLoading;
  kickoffSprintEl.disabled = nextLoading;
  kickoffStopOrchestratorsSpinnerEl.classList.toggle("hidden", !nextLoading);
  kickoffStopOrchestratorsLabelEl.textContent = nextLoading ? "Stopping..." : "Stop Orchestrators";
}

async function submitKickoff(event) {
  event.preventDefault();
  clearKickoffMessage();

  const goal = kickoffGoalEl.value;
  if (goal.trim().length === 0) {
    showKickoffMessage("Goal is required.", "error");
    kickoffGoalEl.focus();
    return;
  }

  setKickoffLoading(true);

  try {
    const response = await fetch("/internal/kickoff", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ goal }),
    });

    const rawResponseBody = await response.text();
    let payload = {};
    if (rawResponseBody.trim().length > 0) {
      try {
        payload = asObject(JSON.parse(rawResponseBody));
      } catch {
        payload = {};
      }
    }

    if (!response.ok) {
      const fallbackMessage =
        (typeof payload.error === "string" && payload.error.trim().length > 0
          ? payload.error.trim()
          : rawResponseBody.trim()) || `HTTP ${response.status}`;
      throw new Error(fallbackMessage);
    }

    const successMessage =
      typeof payload.message === "string" && payload.message.trim().length > 0
        ? payload.message.trim()
        : "Goal received.";
    showKickoffMessage(`${successMessage} Next: click Start Kickoff Loop (Step 2).`);
  } catch (error) {
    showKickoffMessage(`Failed to write goal: ${error?.message ?? "Unknown error"}`, "error");
  } finally {
    setKickoffLoading(false);
  }
}

async function startKickoffLoop() {
  clearKickoffMessage();

  const sprint = normalizeSprint(kickoffSprintEl.value);
  if (!sprint) {
    showKickoffMessage("Sprint must be one of M1, M2, M3, or M4.", "error");
    kickoffSprintEl.focus();
    return;
  }

  kickoffSprintEl.value = sprint;
  collapseKickoffSection({ force: true });
  setKickoffLoopLoading(true);

  try {
    const response = await fetch("/internal/kickoff/start-loop", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sprint }),
    });

    const rawResponseBody = await response.text();
    let payload = {};
    if (rawResponseBody.trim().length > 0) {
      try {
        payload = asObject(JSON.parse(rawResponseBody));
      } catch {
        payload = {};
      }
    }

    if (!response.ok) {
      if (response.status === 409 && String(payload.status ?? "") === "ALREADY_RUNNING") {
        const runningSprint =
          typeof payload.sprint === "string" && payload.sprint.trim().length > 0 ? payload.sprint.trim() : sprint;
        const runningPid = Number(payload.pid);
        const runningPidText = Number.isInteger(runningPid) && runningPid > 0 ? `, PID ${runningPid}` : "";
        showKickoffMessage(`Kickoff loop is already running (Sprint ${runningSprint}${runningPidText}).`);
        collapseKickoffSection({ force: true });
        return;
      }
      const fallbackMessage =
        (typeof payload.error === "string" && payload.error.trim().length > 0
          ? payload.error.trim()
          : rawResponseBody.trim()) || `HTTP ${response.status}`;
      throw new Error(fallbackMessage);
    }

    const successMessage =
      typeof payload.message === "string" && payload.message.trim().length > 0
        ? payload.message.trim()
        : "Kickoff loop started.";
    const statusParts = [];
    if (typeof payload.sprint === "string" && payload.sprint.trim().length > 0) {
      statusParts.push(`Sprint ${payload.sprint.trim()}`);
    }
    const pid = Number(payload.pid);
    if (Number.isInteger(pid) && pid > 0) {
      statusParts.push(`PID ${pid}`);
    }
    const suffix = statusParts.length > 0 ? ` (${statusParts.join(", ")})` : "";
    showKickoffMessage(`${successMessage}${suffix}`);
    collapseKickoffSection({ force: true });
  } catch (error) {
    if (kickoffDetailsEl) {
      kickoffDetailsEl.open = true;
    }
    kickoffWasAutoCollapsed = false;
    showKickoffMessage(`Failed to start kickoff loop: ${error?.message ?? "Unknown error"}`, "error");
  } finally {
    setKickoffLoopLoading(false);
  }
}

async function startRunnerLoop() {
  clearKickoffMessage();

  const sprint = normalizeSprint(kickoffSprintEl.value);
  if (!sprint) {
    showKickoffMessage("Sprint must be one of M1, M2, M3, or M4.", "error");
    kickoffSprintEl.focus();
    return;
  }

  kickoffSprintEl.value = sprint;
  setRunnerLoopLoading(true);

  try {
    const response = await fetch("/internal/runner/start-loop", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ sprint }),
    });

    const rawResponseBody = await response.text();
    let payload = {};
    if (rawResponseBody.trim().length > 0) {
      try {
        payload = asObject(JSON.parse(rawResponseBody));
      } catch {
        payload = {};
      }
    }

    if (!response.ok) {
      if (response.status === 409 && String(payload.status ?? "") === "ALREADY_RUNNING") {
        const runningSprint =
          typeof payload.sprint === "string" && payload.sprint.trim().length > 0 ? payload.sprint.trim() : sprint;
        const runningPid = Number(payload.pid);
        const runningPidText = Number.isInteger(runningPid) && runningPid > 0 ? `, PID ${runningPid}` : "";
        showKickoffMessage(`Runner loop is already running (Sprint ${runningSprint}${runningPidText}).`);
        return;
      }
      const fallbackMessage =
        (typeof payload.error === "string" && payload.error.trim().length > 0
          ? payload.error.trim()
          : rawResponseBody.trim()) || `HTTP ${response.status}`;
      throw new Error(fallbackMessage);
    }

    const successMessage =
      typeof payload.message === "string" && payload.message.trim().length > 0
        ? payload.message.trim()
        : "Runner loop started.";
    const statusParts = [];
    if (typeof payload.sprint === "string" && payload.sprint.trim().length > 0) {
      statusParts.push(`Sprint ${payload.sprint.trim()}`);
    }
    const pid = Number(payload.pid);
    if (Number.isInteger(pid) && pid > 0) {
      statusParts.push(`PID ${pid}`);
    }
    const suffix = statusParts.length > 0 ? ` (${statusParts.join(", ")})` : "";
    showKickoffMessage(`${successMessage}${suffix}`);
  } catch (error) {
    showKickoffMessage(`Failed to start runner loop: ${error?.message ?? "Unknown error"}`, "error");
  } finally {
    setRunnerLoopLoading(false);
  }
}

async function stopOrchestrators() {
  clearKickoffMessage();

  const force = Boolean(kickoffStopForceEl?.checked);
  const confirmMessage = force
    ? "Force-stop all agent loops for this repo? This bypasses PID sanity checks and may kill unrelated processes if the loop state is corrupt."
    : "Stop runner/kickoff loops (and their orchestrators) for this repo?";
  if (!window.confirm(confirmMessage)) {
    return;
  }

  setStopOrchestratorsLoading(true);

  try {
    const results = [];
    const endpoints = [
      { label: "Runner", url: "/internal/runner/stop-loop" },
      { label: "Kickoff", url: "/internal/kickoff/stop-loop" },
    ];

    for (const endpoint of endpoints) {
      const response = await fetch(endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(force ? { force: true } : {}),
      });

      const rawResponseBody = await response.text();
      let payload = {};
      if (rawResponseBody.trim().length > 0) {
        try {
          payload = asObject(JSON.parse(rawResponseBody));
        } catch {
          payload = {};
        }
      }

      if (!response.ok) {
        const fallbackMessage =
          (typeof payload.error === "string" && payload.error.trim().length > 0
            ? payload.error.trim()
            : rawResponseBody.trim()) || `HTTP ${response.status}`;
        throw new Error(`${endpoint.label}: ${fallbackMessage}`);
      }

      const stoppedStatus =
        typeof payload.status === "string" && payload.status.trim().length > 0 ? payload.status.trim() : "OK";
      results.push(`${endpoint.label}: ${stoppedStatus}`);
    }

    showKickoffMessage(`Stop request complete. ${results.join(" · ")}`);
    loadStatus();
  } catch (error) {
    showKickoffMessage(`Failed to stop orchestrators: ${error?.message ?? "Unknown error"}`, "error");
  } finally {
    setStopOrchestratorsLoading(false);
  }
}

function clearSettingsFieldValidation() {
  for (const field of Object.values(settingsFieldByName)) {
    field.classList.remove("border-zinc-300", "ring-1", "ring-zinc-300/60");
    field.classList.add("border-zinc-700");
  }
}

function markSettingsFieldInvalid(field) {
  if (!field) {
    return;
  }
  field.classList.remove("border-zinc-700");
  field.classList.add("border-zinc-300", "ring-1", "ring-zinc-300/60");
}

function toPositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

async function loadConfig() {
  clearSettingsFieldValidation();
  try {
    const response = await fetch("/internal/config", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = asObject(await response.json());

    settingsTargetOwnerEl.value = typeof payload.targetOwner === "string" ? payload.targetOwner : "";
    settingsTargetRepoEl.value = typeof payload.targetRepo === "string" ? payload.targetRepo : "";
    settingsProjectNumberEl.value = Number.isInteger(payload.projectNumber) ? String(payload.projectNumber) : "";
    settingsMaxExecutorsEl.value = Number.isInteger(payload.maxExecutors) ? String(payload.maxExecutors) : "";
    settingsMaxReviewersEl.value = Number.isInteger(payload.maxReviewers) ? String(payload.maxReviewers) : "";
    settingsGithubTokenEl.value = "";
    settingsGithubTokenEl.placeholder = payload.hasGithubToken
      ? "Token is set (enter to overwrite)"
      : "Enter token to set";

    if (settingsTargetOwnerEl.value && settingsTargetRepoEl.value) {
      targetRepoEl.textContent = `${settingsTargetOwnerEl.value}/${settingsTargetRepoEl.value}`;
    }
  } catch (error) {
    showSettingsMessage(`Unable to load config: ${error?.message ?? "Unknown error"}`, "error");
  }
}

async function submitConfig(event) {
  event.preventDefault();
  clearSettingsMessage();
  clearSettingsFieldValidation();

  const targetOwner = settingsTargetOwnerEl.value.trim();
  const targetRepo = settingsTargetRepoEl.value.trim();
  const projectNumber = toPositiveInteger(settingsProjectNumberEl.value);
  const maxExecutors = toPositiveInteger(settingsMaxExecutorsEl.value);
  const maxReviewers = toPositiveInteger(settingsMaxReviewersEl.value);
  const githubToken = settingsGithubTokenEl.value.trim();

  const validationErrors = [];
  if (!targetOwner) {
    validationErrors.push({ field: "targetOwner", message: "Target Owner is required." });
  }
  if (!targetRepo) {
    validationErrors.push({ field: "targetRepo", message: "Target Repo is required." });
  }
  if (!projectNumber) {
    validationErrors.push({ field: "projectNumber", message: "Project V2 Number must be a positive integer." });
  }
  if (!maxExecutors) {
    validationErrors.push({ field: "maxExecutors", message: "Max Executors must be a positive integer." });
  }
  if (!maxReviewers) {
    validationErrors.push({ field: "maxReviewers", message: "Max Reviewers must be a positive integer." });
  }

  if (validationErrors.length > 0) {
    for (const error of validationErrors) {
      markSettingsFieldInvalid(settingsFieldByName[error.field]);
    }
    showSettingsMessage(validationErrors.map((error) => error.message).join(" "), "error");
    const firstInvalidField = settingsFieldByName[validationErrors[0].field];
    if (firstInvalidField) {
      firstInvalidField.focus();
    }
    return;
  }

  const body = {
    targetOwner,
    targetRepo,
    projectNumber,
    maxExecutors,
    maxReviewers,
  };
  if (githubToken) {
    body.githubToken = githubToken;
  }

  setSettingsLoading(true);
  try {
    const response = await fetch("/internal/config", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const rawResponseBody = await response.text();
    let payload = {};
    if (rawResponseBody.trim().length > 0) {
      try {
        payload = asObject(JSON.parse(rawResponseBody));
      } catch {
        payload = {};
      }
    }

    if (!response.ok) {
      const serverErrors = Array.isArray(payload.errors) ? payload.errors : [];
      for (const error of serverErrors) {
        if (typeof error?.field === "string") {
          markSettingsFieldInvalid(settingsFieldByName[error.field]);
        }
      }
      const serverMessages = serverErrors
        .map((error) => (typeof error?.message === "string" ? error.message : ""))
        .filter((message) => message.length > 0);
      const fallbackMessage =
        (typeof payload.error === "string" && payload.error.trim().length > 0
          ? payload.error.trim()
          : rawResponseBody.trim()) || `HTTP ${response.status}`;
      const message = serverMessages.length > 0 ? serverMessages.join(" ") : fallbackMessage;
      throw new Error(message);
    }

    settingsGithubTokenEl.value = "";
    settingsGithubTokenEl.placeholder = payload.hasGithubToken
      ? "Token is set (enter to overwrite)"
      : "Enter token to set";
    showSettingsMessage("Settings saved.");

    targetRepoEl.textContent = `${targetOwner}/${targetRepo}`;
    loadStatus();
  } catch (error) {
    showSettingsMessage(`Failed to save settings: ${error?.message ?? "Unknown error"}`, "error");
  } finally {
    setSettingsLoading(false);
  }
}

async function loadStatus() {
  try {
    const response = await fetch("/internal/status", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = asObject(await response.json());
    const orchestrator = asObject(payload?.orchestrator);
    const runner = asObject(payload?.runner);
    const runnerEntries = buildRunnerEntries(runner);

    if (detectReviewerNeedsHumanApprovalTransition(orchestrator)) {
      playNotificationBeep();
    }

    const hasRunningRun = runnerEntries.some((entry) => normalizeStatus(entry?.status) === "RUNNING");
    const orchestratorLoopRunning = runnerEntries.some(
      (entry) => normalizeRoleLabel(entry?.role) === "ORCHESTRATOR" && normalizeStatus(entry?.status) === "RUNNING",
    );
    if (orchestratorLoopRunning || hasRunningRun) {
      collapseKickoffSection();
    }

    const ownerHeader = response.headers.get("x-target-owner") ?? "";
    const repoHeader = response.headers.get("x-target-repo") ?? "";

    targetRepoEl.textContent = deriveTargetFromData(orchestrator, runner, ownerHeader, repoHeader);
    orchestratorSprintEl.textContent = deriveSprint(orchestrator);
    renderOrchestrator(orchestrator);
    renderRunner(runnerEntries);
    syncTerminalRuns(runnerEntries);
    renderTerminalHealth(runnerEntries);
    background.setActivityFromData(orchestrator, runner);
    lastRefreshEl.textContent = formatTime(new Date().toISOString());
    clearError();
  } catch (error) {
    showError(`Unable to refresh status data: ${error?.message ?? "Unknown error"}`);
    lastRefreshEl.textContent = "Refresh failed";
    background.setActivityTarget(0.12);
  }
}

window.addEventListener("resize", () => background.resize(), { passive: true });
settingsOpenButtonEl.addEventListener("click", () => {
  clearSettingsMessage();
  setSettingsOpen(true);
});
settingsCloseButtonEl.addEventListener("click", () => setSettingsOpen(false));
settingsCancelButtonEl.addEventListener("click", () => setSettingsOpen(false));
settingsBackdropEl.addEventListener("click", () => setSettingsOpen(false));
settingsFormEl.addEventListener("submit", submitConfig);
settingsSoundNeedsHumanApprovalEl?.addEventListener("change", () => {
  soundNeedsHumanApprovalEnabled = Boolean(settingsSoundNeedsHumanApprovalEl.checked);
  writeStoredBoolean(UI_STORAGE_KEY_SOUND_NEEDS_HUMAN_APPROVAL, soundNeedsHumanApprovalEnabled);
  if (soundNeedsHumanApprovalEnabled) {
    void unlockNotificationAudio();
  }
});
kickoffFormEl.addEventListener("submit", submitKickoff);
kickoffStartLoopButtonEl.addEventListener("click", startKickoffLoop);
kickoffStartRunnerLoopButtonEl.addEventListener("click", startRunnerLoop);
kickoffStopOrchestratorsButtonEl.addEventListener("click", stopOrchestrators);
terminalTabsEl.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const button = event.target.closest("button[data-run-id]");
  if (!button) {
    return;
  }
  setActiveTerminalRun(button.getAttribute("data-run-id"));
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isSettingsOpen) {
    setSettingsOpen(false);
  }
});

background.resize();
background.start();

loadUiPreferences();
window.addEventListener("pointerdown", handleNotificationAudioUnlockGesture, { passive: true });
window.addEventListener("keydown", handleNotificationAudioUnlockGesture, { passive: true });
loadConfig();
loadStatus();
setInterval(loadStatus, POLL_INTERVAL_MS);
restartTerminalStreamNow();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    closeTerminalStream();
    clearTerminalStreamReconnectTimer();
  } else {
    restartTerminalStreamNow();
  }
});

window.addEventListener("beforeunload", () => {
  background.stop();
  closeTerminalStream();
  clearTerminalStreamReconnectTimer();
});
