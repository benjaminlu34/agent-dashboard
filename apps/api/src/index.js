import Fastify from "fastify";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { registerInternalPreflightRoute } from "./routes/internal-preflight.js";
import { registerInternalRunRoute } from "./routes/internal-run.js";
import { registerInternalPlanApplyRoute } from "./routes/internal-plan-apply.js";
import { registerInternalProjectItemUpdateFieldRoute } from "./routes/internal-project-item-update-field.js";
import { registerInternalAgentContextRoute } from "./routes/internal-agent-context.js";
import { registerInternalExecutorClaimReadyItemRoute } from "./routes/internal-executor-claim-ready-item.js";

const MODULE_DIRNAME = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(MODULE_DIRNAME, "../../../");

export async function buildApp({ repoRoot = DEFAULT_REPO_ROOT, logger = true } = {}) {
  const app = Fastify({ logger });

  const routeOptions = { repoRoot };
  await registerInternalPreflightRoute(app, routeOptions);
  await registerInternalRunRoute(app, routeOptions);
  await registerInternalPlanApplyRoute(app, routeOptions);
  await registerInternalProjectItemUpdateFieldRoute(app, routeOptions);
  await registerInternalAgentContextRoute(app, routeOptions);
  await registerInternalExecutorClaimReadyItemRoute(app, routeOptions);

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
