import type { AgentRunStatus } from "./models.js";

const allowedTransitions: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  queued: ["running", "failed", "timed_out"],
  running: ["completed", "failed", "timed_out"],
  completed: [],
  failed: [],
  timed_out: [],
};

export const terminalAgentRunStatuses = [
  "completed",
  "failed",
  "timed_out",
] as const satisfies ReadonlyArray<AgentRunStatus>;

const terminalAgentRunStatusSet = new Set<AgentRunStatus>(
  terminalAgentRunStatuses,
);

export function isTerminalAgentRunStatus(
  status: AgentRunStatus,
): status is (typeof terminalAgentRunStatuses)[number] {
  return terminalAgentRunStatusSet.has(status);
}

export function canTransitionAgentRunStatus(
  from: AgentRunStatus,
  to: AgentRunStatus,
): boolean {
  if (from === to) {
    return true;
  }

  return allowedTransitions[from].includes(to);
}

export function assertAgentRunStatusTransition(
  from: AgentRunStatus,
  to: AgentRunStatus,
): void {
  if (!canTransitionAgentRunStatus(from, to)) {
    throw new Error(`Invalid agent run status transition: ${from} -> ${to}`);
  }
}
