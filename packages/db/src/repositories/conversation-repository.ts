import { eq, inArray } from "drizzle-orm";

import type { Provider } from "@agent-hub/domain";

import type { AgentHubDb } from "../client.js";
import { agentRuns, conversations, messages, turns } from "../schema.js";
import { dedupeRequestedRuns } from "./agent-run-repository.js";

export interface CreateConversationInput {
  title?: string;
}

export interface CreateTurnInput {
  conversationId: string;
  userContent: string;
  runs: Array<{
    provider: Provider;
    model: string;
  }>;
}

export interface TurnCreationResult {
  turnId: string;
  userMessageId: string;
  runIds: string[];
}

export class ConversationRepository {
  constructor(private readonly db: AgentHubDb) {}

  async createConversation(input: CreateConversationInput = {}) {
    const [created] = await this.db
      .insert(conversations)
      .values({
        title: input.title?.trim() || "New Conversation",
      })
      .returning();

    return created;
  }

  async getConversationById(conversationId: string) {
    return this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });
  }

  async getConversationWithTurns(conversationId: string) {
    const conversation = await this.db.query.conversations.findFirst({
      where: eq(conversations.id, conversationId),
    });

    if (!conversation) {
      return null;
    }

    const turnRows = await this.db.query.turns.findMany({
      where: eq(turns.conversationId, conversationId),
      orderBy: (turn, { asc }) => [asc(turn.createdAt), asc(turn.id)],
    });

    const turnIds = turnRows.map((turn) => turn.id);

    const messageRows =
      turnIds.length === 0
        ? []
        : await this.db.query.messages.findMany({
            where: eq(messages.conversationId, conversationId),
            orderBy: (message, { asc }) => [asc(message.createdAt), asc(message.id)],
          });

    const runRows =
      turnIds.length === 0
        ? []
        : await this.db.query.agentRuns.findMany({
            where: inArray(agentRuns.turnId, turnIds),
            orderBy: (run, { asc }) => [asc(run.createdAt), asc(run.id)],
          });

    return {
      conversation,
      turns: turnRows,
      messages: messageRows,
      runs: runRows,
    };
  }

  async createTurnWithUserMessage(input: CreateTurnInput): Promise<TurnCreationResult> {
    const requestedRuns = dedupeRequestedRuns(input.runs);

    if (requestedRuns.length === 0) {
      throw new Error("At least one agent run must be requested");
    }

    return this.db.transaction(async (tx) => {
      const [turn] = await tx
        .insert(turns)
        .values({
          conversationId: input.conversationId,
        })
        .returning({
          id: turns.id,
        });
      if (!turn) {
        throw new Error("Failed to create turn");
      }

      const [userMessage] = await tx
        .insert(messages)
        .values({
          conversationId: input.conversationId,
          turnId: turn.id,
          role: "user",
          content: input.userContent,
        })
        .returning({
          id: messages.id,
        });
      if (!userMessage) {
        throw new Error("Failed to create user message");
      }

      await tx
        .update(turns)
        .set({
          userMessageId: userMessage.id,
        })
        .where(eq(turns.id, turn.id));

      const insertedRuns = await tx
        .insert(agentRuns)
        .values(
          requestedRuns.map((run) => ({
            turnId: turn.id,
            provider: run.provider,
            model: run.model,
            status: "queued" as const,
          })),
        )
        .returning({
          id: agentRuns.id,
        });

      return {
        turnId: turn.id,
        userMessageId: userMessage.id,
        runIds: insertedRuns.map((run) => run.id),
      };
    });
  }
}
