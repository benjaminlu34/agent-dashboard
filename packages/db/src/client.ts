import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema.js";

export type AgentHubDb = NodePgDatabase<typeof schema>;

export interface DbConfig {
  connectionString: string;
  maxConnections?: number;
}

export function createDbPool(config: DbConfig): Pool {
  return new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
  });
}

export function createDb(pool: Pool): AgentHubDb {
  return drizzle(pool, { schema });
}
