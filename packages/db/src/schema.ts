import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const messageRoleEnum = pgEnum("message_role", ["user", "assistant"]);
export const providerEnum = pgEnum("provider", ["openai", "gemini"]);
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "timed_out",
]);

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const turns = pgTable(
  "turns",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    // M1 keeps this nullable to allow turn insert before user message write in one transaction.
    userMessageId: uuid("user_message_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    conversationCreatedAtIdx: index("turns_conversation_created_at_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  }),
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    provider: providerEnum("provider").notNull(),
    model: text("model").notNull(),
    status: agentRunStatusEnum("status").notNull().default("queued"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    latencyMs: integer("latency_ms"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    turnCreatedAtIdx: index("agent_runs_turn_created_at_idx").on(
      table.turnId,
      table.createdAt,
    ),
    statusIdx: index("agent_runs_status_idx").on(table.status),
  }),
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    turnId: uuid("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    conversationCreatedAtIdx: index("messages_conversation_created_at_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    uniqueAgentRunId: uniqueIndex("messages_agent_run_unique_idx").on(
      table.agentRunId,
    ),
  }),
);

export const conversationsRelations = relations(conversations, ({ many }) => ({
  turns: many(turns),
}));

export const turnsRelations = relations(turns, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [turns.conversationId],
    references: [conversations.id],
  }),
  runs: many(agentRuns),
  messages: many(messages),
}));

export const agentRunsRelations = relations(agentRuns, ({ one }) => ({
  turn: one(turns, {
    fields: [agentRuns.turnId],
    references: [turns.id],
  }),
  assistantMessage: one(messages, {
    fields: [agentRuns.id],
    references: [messages.agentRunId],
  }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  turn: one(turns, {
    fields: [messages.turnId],
    references: [turns.id],
  }),
  run: one(agentRuns, {
    fields: [messages.agentRunId],
    references: [agentRuns.id],
  }),
}));

export const touchUpdatedAt = sql`timezone('utc', now())`;
