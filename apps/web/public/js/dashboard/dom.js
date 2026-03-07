function getCanvasContext(canvas) {
  if (!canvas || typeof canvas.getContext !== "function") {
    return null;
  }
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

export function getDashboardDom(doc = globalThis.document) {
  const documentRef = doc ?? null;
  const canvas = documentRef?.getElementById("bg-canvas") ?? null;

  return {
    document: documentRef,
    orchestratorItemsEl: documentRef?.getElementById("orchestrator-items") ?? null,
    orchestratorSummaryEl: documentRef?.getElementById("orchestrator-summary") ?? null,
    orchestratorSprintEl: documentRef?.getElementById("orchestrator-sprint") ?? null,
    runnerRunsEl: documentRef?.getElementById("runner-runs") ?? null,
    runnerCountEl: documentRef?.getElementById("runner-count") ?? null,
    terminalTabsEl: documentRef?.getElementById("terminal-tabs") ?? null,
    terminalWindowEl: documentRef?.getElementById("terminal-window") ?? null,
    terminalOutputEl: documentRef?.getElementById("terminal-output") ?? null,
    terminalHealthBannerEl: documentRef?.getElementById("terminal-health-banner") ?? null,
    terminalActiveOnlyToggleEl: documentRef?.getElementById("terminal-active-only-toggle") ?? null,
    targetRepoEl: documentRef?.getElementById("target-repo") ?? null,
    lastRefreshEl: documentRef?.getElementById("last-refresh") ?? null,
    errorBannerEl: documentRef?.getElementById("error-banner") ?? null,
    settingsOpenButtonEl: documentRef?.getElementById("settings-open-button") ?? null,
    settingsModalEl: documentRef?.getElementById("settings-modal") ?? null,
    settingsBackdropEl: documentRef?.getElementById("settings-backdrop") ?? null,
    settingsCloseButtonEl: documentRef?.getElementById("settings-close-button") ?? null,
    settingsCancelButtonEl: documentRef?.getElementById("settings-cancel-button") ?? null,
    settingsFormEl: documentRef?.getElementById("settings-form") ?? null,
    settingsSaveButtonEl: documentRef?.getElementById("settings-save-button") ?? null,
    settingsMessageEl: documentRef?.getElementById("settings-message") ?? null,
    settingsTargetOwnerEl: documentRef?.getElementById("settings-target-owner") ?? null,
    settingsTargetRepoEl: documentRef?.getElementById("settings-target-repo") ?? null,
    settingsProjectNumberEl: documentRef?.getElementById("settings-project-number") ?? null,
    settingsGithubTokenEl: documentRef?.getElementById("settings-github-token") ?? null,
    settingsMaxExecutorsEl: documentRef?.getElementById("settings-max-executors") ?? null,
    settingsMaxReviewersEl: documentRef?.getElementById("settings-max-reviewers") ?? null,
    settingsSoundNeedsHumanApprovalEl:
      documentRef?.getElementById("settings-sound-needs-human-approval") ?? null,
    sealControlsEl: documentRef?.getElementById("seal-controls") ?? null,
    sealSprintEl: documentRef?.getElementById("seal-sprint") ?? null,
    sealSprintButtonEl: documentRef?.getElementById("seal-sprint-button") ?? null,
    sealSprintSpinnerEl: documentRef?.getElementById("seal-sprint-spinner") ?? null,
    sealSprintLabelEl: documentRef?.getElementById("seal-sprint-label") ?? null,
    sealErrorsContainerEl: documentRef?.getElementById("seal-errors-container") ?? null,
    kickoffFormEl: documentRef?.getElementById("kickoff-form") ?? null,
    kickoffDetailsEl: documentRef?.getElementById("kickoff-details") ?? null,
    kickoffGoalEl: documentRef?.getElementById("kickoff-goal") ?? null,
    kickoffSprintEl: documentRef?.getElementById("kickoff-sprint") ?? null,
    kickoffRequireVerificationEl: documentRef?.getElementById("kickoff-require-verification") ?? null,
    kickoffStartWorkflowHintEl: documentRef?.getElementById("kickoff-start-workflow-hint") ?? null,
    kickoffMessageEl: documentRef?.getElementById("kickoff-message") ?? null,
    kickoffSubmitButtonEl: documentRef?.getElementById("kickoff-submit-button") ?? null,
    kickoffButtonSpinnerEl: documentRef?.getElementById("kickoff-button-spinner") ?? null,
    kickoffButtonLabelEl: documentRef?.getElementById("kickoff-button-label") ?? null,
    kickoffStartLoopButtonEl: documentRef?.getElementById("kickoff-start-loop-button") ?? null,
    kickoffStartLoopSpinnerEl: documentRef?.getElementById("kickoff-start-loop-spinner") ?? null,
    kickoffStartLoopLabelEl: documentRef?.getElementById("kickoff-start-loop-label") ?? null,
    kickoffRunnerLoopContainerEl: documentRef?.getElementById("kickoff-runner-loop-container") ?? null,
    kickoffStartRunnerLoopButtonEl: documentRef?.getElementById("kickoff-start-runner-loop-button") ?? null,
    kickoffStartRunnerLoopSpinnerEl:
      documentRef?.getElementById("kickoff-start-runner-loop-spinner") ?? null,
    kickoffStartRunnerLoopLabelEl: documentRef?.getElementById("kickoff-start-runner-loop-label") ?? null,
    kickoffStopOrchestratorsButtonEl:
      documentRef?.getElementById("kickoff-stop-orchestrators-button") ?? null,
    kickoffStopOrchestratorsSpinnerEl:
      documentRef?.getElementById("kickoff-stop-orchestrators-spinner") ?? null,
    kickoffStopOrchestratorsLabelEl:
      documentRef?.getElementById("kickoff-stop-orchestrators-label") ?? null,
    kickoffStopForceEl: documentRef?.getElementById("kickoff-stop-force") ?? null,
    canvas,
    ctx: getCanvasContext(canvas),
  };
}
