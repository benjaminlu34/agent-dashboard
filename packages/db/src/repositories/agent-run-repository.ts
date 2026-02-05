import { eq, inArray } from "drizzle-orm";

import type { AgentRunStatus, Provider } from "@agent-hub/domain";

import type { AgentHubDb } from "../client.js";
import { agentRuns, messages, touchUpdatedAt, turns } from "../schema.js";

export interface RunUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: string | null;
}

export interface CompleteRunInput {
  runId: string;
  finalContent: string;
  endedAt?: Date;
  usage: RunUsage;
}

export interface FailRunInput {
  runId: string;
  status: Extract<AgentRunStatus, "failed" | "timed_out">;
  errorCode: string;
  errorMessage: string;
  endedAt?: Date;
}

export class AgentRunRepository {
  constructor(private readonly db: AgentHubDb) {}

  async markStarted(runId: string, startedAt = new Date()): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        status: "running",
        startedAt,
        updatedAt: touchUpdatedAt,
      })
      .where(eq(agentRuns.id, runId));
  }

  async complete(input: CompleteRunInput): Promise<void> {
    const endedAt = input.endedAt ?? new Date();

    await this.db.transaction(async (tx) => {
      const run = await tx.query.agentRuns.findFirst({
        where: eq(agentRuns.id, input.runId),
        columns: {
          id: true,
          turnId: true,
          startedAt: true,
        },
      });

      if (!run) {
        throw new Error(`Run not found: ${input.runId}`);
      }

      const turn = await tx.query.turns.findFirst({
        where: eq(turns.id, run.turnId),
        columns: {
          conversationId: true,
        },
      });

      if (!turn) {
        throw new Error(`Turn not found for run: ${input.runId}`);
      }

      const latencyMs =
        run.startedAt === null ? null : endedAt.getTime() - run.startedAt.getTime();

      await tx
        .update(agentRuns)
        .set({
          status: "completed",
          endedAt,
          latencyMs,
          promptTokens: input.usage.promptTokens,
          completionTokens: input.usage.completionTokens,
          totalTokens: input.usage.totalTokens,
          costUsd: input.usage.costUsd,
          errorCode: null,
          errorMessage: null,
          updatedAt: touchUpdatedAt,
        })
        .where(eq(agentRuns.id, input.runId));

      await tx.insert(messages).values({
        conversationId: turn.conversationId,
        turnId: run.turnId,
        role: "assistant",
        content: input.finalContent,
        agentRunId: input.runId,
      });
    });
  }

  async fail(input: FailRunInput): Promise<void> {
    await this.db
      .update(agentRuns)
      .set({
        status: input.status,
        endedAt: input.endedAt ?? new Date(),
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        updatedAt: touchUpdatedAt,
      })
      .where(eq(agentRuns.id, input.runId));
  }

  async listByTurn(turnId: string) {
    return this.db.query.agentRuns.findMany({
      where: eq(agentRuns.turnId, turnId),
      orderBy: (runs, { asc }) => [asc(runs.createdAt), asc(runs.id)],
    });
  }

  async listByIds(runIds: string[]) {
    if (runIds.length === 0) {
      return [];
    }

    return this.db.query.agentRuns.findMany({
      where: inArray(agentRuns.id, runIds),
    });
  }
}

export interface RequestedRun {
  provider: Provider;
  model: string;
}

export function dedupeRequestedRuns(runs: RequestedRun[]): RequestedRun[] {
  const deduped = new Map<string, RequestedRun>();

  for (const run of runs) {
    const key = `${run.provider}:${run.model}`;
    if (!deduped.has(key)) {
      deduped.set(key, run);
    }
  }

  return [...deduped.values()];
}
