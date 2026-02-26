import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildPreflightHandler } from "./internal-preflight.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../../");
const RUN_ID_RE = /^[A-Za-z0-9-]+$/u;
const ROLE_RE = /^[A-Z][A-Z0-9_]*$/u;
const SECTION_RE = /^[A-Z][A-Z0-9 _-]{1,63}$/u;
const MAX_RUNS = 80;
const MAX_EVENTS_PER_RUN = 800;
const MAX_CONTENT_CHARS = 16000;
const MAX_RUN_IDLE_MS = 2 * 60 * 60 * 1000;
const PREFLIGHT_CACHE_TTL_MS = 5 * 60 * 1000;
const SSE_HEARTBEAT_MS = 20000;

function parseRunId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !RUN_ID_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function parseRole(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (!ROLE_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

function parseSection(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (!SECTION_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

function parseAfterSeq(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  const truncated = Math.trunc(parsed);
  if (truncated <= 0) {
    return 0;
  }
  return truncated;
}

function clipContent(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= MAX_CONTENT_CHARS) {
    return normalized;
  }
  return normalized.slice(0, MAX_CONTENT_CHARS - 3).trimEnd() + "...";
}

function formatChunk(section, content) {
  return `\n========== ${section} ==========\n${content}\n`;
}

function createReplyRecorder() {
  return {
    statusCode: 200,
    code(nextStatusCode) {
      this.statusCode = nextStatusCode;
      return this;
    },
    type() {
      return this;
    },
    header() {
      return this;
    },
    send() {
      return this;
    },
  };
}

function writeSseEvent(rawResponse, { id, event, data }) {
  if (id !== undefined && id !== null) {
    rawResponse.write(`id: ${String(id)}\n`);
  }
  if (event) {
    rawResponse.write(`event: ${event}\n`);
  }
  const serialized = typeof data === "string" ? data : JSON.stringify(data ?? {});
  rawResponse.write(`data: ${serialized}\n\n`);
}

export function createLiveTranscriptStore() {
  const runs = new Map();

  function ensureRun(runId, role = "") {
    const nowMs = Date.now();
    let run = runs.get(runId);
    if (!run) {
      run = {
        runId,
        role,
        seqCounter: 0,
        entries: [],
        subscribers: new Set(),
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      runs.set(runId, run);
    } else {
      if (role && !run.role) {
        run.role = role;
      }
      run.updatedAtMs = nowMs;
    }
    return run;
  }

  function prune() {
    const nowMs = Date.now();

    for (const [runId, run] of runs.entries()) {
      if (run.subscribers.size > 0) {
        continue;
      }
      if (nowMs - run.updatedAtMs > MAX_RUN_IDLE_MS) {
        runs.delete(runId);
      }
    }

    if (runs.size <= MAX_RUNS) {
      return;
    }

    const candidates = Array.from(runs.values())
      .filter((run) => run.subscribers.size === 0)
      .sort((left, right) => left.updatedAtMs - right.updatedAtMs);

    while (runs.size > MAX_RUNS && candidates.length > 0) {
      const next = candidates.shift();
      if (!next) {
        break;
      }
      runs.delete(next.runId);
    }
  }

  return {
    append({ runId, role, section, content, createdAt }) {
      const run = ensureRun(runId, role);
      run.seqCounter += 1;

      const event = {
        runId,
        role: run.role || role,
        section,
        content,
        chunk: formatChunk(section, content),
        seq: run.seqCounter,
        createdAt: typeof createdAt === "string" && createdAt.trim().length > 0 ? createdAt.trim() : new Date().toISOString(),
      };

      run.entries.push(event);
      run.updatedAtMs = Date.now();
      if (run.entries.length > MAX_EVENTS_PER_RUN) {
        run.entries.splice(0, run.entries.length - MAX_EVENTS_PER_RUN);
      }

      for (const subscriber of run.subscribers) {
        try {
          subscriber(event);
        } catch {
          // Subscribers are best-effort; failures are isolated.
        }
      }

      prune();
      return event;
    },
    getSnapshot(runId) {
      const run = runs.get(runId);
      if (!run) {
        return {
          runId,
          role: "",
          seq: 0,
          logs: "",
        };
      }

      return {
        runId,
        role: run.role || "",
        seq: run.seqCounter,
        logs: run.entries.map((entry) => entry.chunk).join(""),
      };
    },
    getEventsAfter(runId, afterSeq = 0) {
      const run = runs.get(runId);
      if (!run) {
        return [];
      }
      return run.entries.filter((entry) => entry.seq > afterSeq);
    },
    subscribe(runId, subscriber) {
      const run = ensureRun(runId);
      run.subscribers.add(subscriber);
      return () => {
        const current = runs.get(runId);
        if (!current) {
          return;
        }
        current.subscribers.delete(subscriber);
      };
    },
  };
}

async function runPreflightGateForRole({ role, preflightHandler, preflightCache }) {
  const nowMs = Date.now();
  const cached = preflightCache.get(role);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.value;
  }

  const preflightReply = createReplyRecorder();
  const preflightPayload = await preflightHandler({ query: { role } }, preflightReply);
  const result = {
    statusCode: preflightReply.statusCode,
    payload: preflightPayload,
  };

  if (preflightReply.statusCode === 200 && preflightPayload?.status !== "FAIL") {
    preflightCache.set(role, {
      value: result,
      expiresAtMs: nowMs + PREFLIGHT_CACHE_TTL_MS,
    });
  }
  return result;
}

export function buildInternalLogsSnapshotHandler({ transcriptStore }) {
  return async function internalLogsSnapshotHandler(request, reply) {
    const runId = parseRunId(request?.params?.runId);
    if (!runId) {
      reply.code(400);
      return { error: "runId must contain only letters, numbers, and hyphens" };
    }

    const snapshot = transcriptStore.getSnapshot(runId);
    return {
      logs: snapshot.logs,
      seq: snapshot.seq,
      role: snapshot.role,
    };
  };
}

export function buildInternalLogsEventIngestHandler({
  repoRoot = DEFAULT_REPO_ROOT,
  transcriptStore,
  preflightHandler,
  preflightCache,
} = {}) {
  const resolvedPreflightHandler = preflightHandler ?? buildPreflightHandler({ repoRoot });
  const resolvedPreflightCache = preflightCache ?? new Map();

  return async function internalLogsEventIngestHandler(request, reply) {
    const runId = parseRunId(request?.body?.run_id ?? request?.body?.runId);
    if (!runId) {
      reply.code(400);
      return { error: "body.run_id must contain only letters, numbers, and hyphens" };
    }

    const role = parseRole(request?.body?.role);
    if (!role) {
      reply.code(400);
      return { error: "body.role must be an uppercase role token" };
    }

    const section = parseSection(request?.body?.section ?? "SYSTEM OBSERVATION");
    if (!section) {
      reply.code(400);
      return { error: "body.section must be an uppercase section token" };
    }

    const content = clipContent(request?.body?.content);
    if (!content) {
      reply.code(400);
      return { error: "body.content must be a non-empty string" };
    }

    const preflightResult = await runPreflightGateForRole({
      role,
      preflightHandler: resolvedPreflightHandler,
      preflightCache: resolvedPreflightCache,
    });
    if (preflightResult.statusCode !== 200) {
      reply.code(preflightResult.statusCode);
      return preflightResult.payload;
    }
    if (preflightResult.payload?.status === "FAIL") {
      reply.code(409);
      return preflightResult.payload;
    }

    const event = transcriptStore.append({
      runId,
      role,
      section,
      content,
      createdAt: request?.body?.created_at ?? request?.body?.createdAt,
    });

    return {
      status: "ok",
      run_id: runId,
      seq: event.seq,
    };
  };
}

export function buildInternalLogsStreamHandler({ transcriptStore }) {
  return async function internalLogsStreamHandler(request, reply) {
    const runId = parseRunId(request?.params?.runId);
    if (!runId) {
      reply.code(400);
      return { error: "runId must contain only letters, numbers, and hyphens" };
    }

    let afterSeq = parseAfterSeq(request?.query?.after);

    reply.hijack();
    const rawResponse = reply.raw;
    rawResponse.statusCode = 200;
    rawResponse.setHeader("content-type", "text/event-stream; charset=utf-8");
    rawResponse.setHeader("cache-control", "no-cache, no-transform");
    rawResponse.setHeader("connection", "keep-alive");
    rawResponse.setHeader("x-accel-buffering", "no");
    rawResponse.write(": connected\n\n");

    for (const event of transcriptStore.getEventsAfter(runId, afterSeq)) {
      afterSeq = Math.max(afterSeq, event.seq);
      writeSseEvent(rawResponse, {
        id: event.seq,
        event: "transcript",
        data: {
          seq: event.seq,
          run_id: runId,
          role: event.role,
          section: event.section,
          chunk: event.chunk,
          created_at: event.createdAt,
        },
      });
    }

    const unsubscribe = transcriptStore.subscribe(runId, (event) => {
      if (event.seq <= afterSeq) {
        return;
      }
      afterSeq = event.seq;
      try {
        writeSseEvent(rawResponse, {
          id: event.seq,
          event: "transcript",
          data: {
            seq: event.seq,
            run_id: runId,
            role: event.role,
            section: event.section,
            chunk: event.chunk,
            created_at: event.createdAt,
          },
        });
      } catch {
        cleanup();
      }
    });

    const heartbeat = setInterval(() => {
      try {
        writeSseEvent(rawResponse, {
          event: "ping",
          data: { ts: new Date().toISOString() },
        });
      } catch {
        cleanup();
      }
    }, SSE_HEARTBEAT_MS);

    let closed = false;
    function cleanup() {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      try {
        rawResponse.end();
      } catch {
        // no-op
      }
    }

    request.raw.on("close", cleanup);
    request.raw.on("end", cleanup);
    request.raw.on("error", cleanup);
  };
}

export async function registerInternalLogsRoute(fastify, options = {}) {
  const transcriptStore = options.transcriptStore ?? createLiveTranscriptStore();
  const preflightCache = new Map();

  fastify.get("/internal/logs/stream/:runId", buildInternalLogsStreamHandler({ transcriptStore }));
  fastify.get("/internal/logs/:runId", buildInternalLogsSnapshotHandler({ transcriptStore }));
  fastify.post(
    "/internal/logs/events",
    buildInternalLogsEventIngestHandler({
      ...options,
      transcriptStore,
      preflightCache,
    }),
  );
}
