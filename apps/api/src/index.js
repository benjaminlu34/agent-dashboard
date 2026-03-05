import Fastify from "fastify";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Redis from "ioredis";

import { registerInternalPreflightRoute } from "./routes/internal-preflight.js";
import { registerInternalRunRoute } from "./routes/internal-run.js";
import { registerInternalPlanApplyRoute } from "./routes/internal-plan-apply.js";
import { registerInternalSprintSealRoute } from "./routes/internal-sprint-seal.js";
import { registerInternalProjectItemUpdateFieldRoute } from "./routes/internal-project-item-update-field.js";
import { registerInternalAgentContextRoute } from "./routes/internal-agent-context.js";
import { registerInternalExecutorClaimReadyItemRoute } from "./routes/internal-executor-claim-ready-item.js";
import { registerInternalReviewerResolveLinkedPrRoute } from "./routes/internal-reviewer-resolve-linked-pr.js";
import { registerInternalStatusRoute } from "./routes/internal-status.js";
import { registerInternalMetadataRoute } from "./routes/internal-metadata.js";
import { registerInternalConfigRoute } from "./routes/internal-config.js";
import { registerInternalKickoffRoute } from "./routes/internal-kickoff.js";
import { registerInternalLogsRoute } from "./routes/internal-logs.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../");

export async function buildApp({
  repoRoot = DEFAULT_REPO_ROOT,
  logger = true,
  redisUrl = process.env.REDIS_URL || "redis://localhost:6379/0",
  redis,
  redisSub,
} = {}) {
  const app = Fastify({ logger });

  const redisClient = redis ?? new Redis(redisUrl);
  const redisSubClient = redisSub ?? new Redis(redisUrl);

  app.decorate("redis", redisClient);
  app.decorate("redisSub", redisSubClient);
  app.decorateRequest("redis", null);

  app.addHook("onRequest", async (request) => {
    request.redis = redisClient;
  });

  app.addHook("onClose", async () => {
    try {
      await redisClient.quit();
    } catch {}
    try {
      await redisSubClient.quit();
    } catch {}
  });

  const routeOptions = { repoRoot, redis: redisClient, redisSub: redisSubClient };
  await registerInternalPreflightRoute(app, routeOptions);
  await registerInternalRunRoute(app, routeOptions);
  await registerInternalPlanApplyRoute(app, routeOptions);
  await registerInternalSprintSealRoute(app, routeOptions);
  await registerInternalProjectItemUpdateFieldRoute(app, routeOptions);
  await registerInternalAgentContextRoute(app, routeOptions);
  await registerInternalExecutorClaimReadyItemRoute(app, routeOptions);
  await registerInternalReviewerResolveLinkedPrRoute(app, routeOptions);
  await registerInternalMetadataRoute(app, routeOptions);
  await registerInternalStatusRoute(app, routeOptions);
  await registerInternalConfigRoute(app, routeOptions);
  await registerInternalKickoffRoute(app, routeOptions);
  await registerInternalLogsRoute(app, routeOptions);

  await app.register(fastifyStatic, {
    root: resolve(repoRoot, "apps/web/public"),
    prefix: "/",
  });

  return app;
}

export async function startServer() {
  const app = await buildApp();
  const port = Number(process.env.PORT || 4000);
  const host = "0.0.0.0";
  await app.listen({ port, host });
  app.log.info({ host, port, env: process.env.NODE_ENV ?? "development" }, "apps/api server started");
  return app;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await startServer();
}
