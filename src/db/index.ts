import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as dbSchema from "./schema";

declare global {
  var __escortChartPool: Pool | undefined;
}

function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and point it at a Postgres database.",
    );
  }
  // Reuse a single pool across hot reloads / server-action invocations in
  // dev; a fresh module load in each serverless invocation in production is
  // fine since the pool is small and short-lived there anyway.
  if (!global.__escortChartPool) {
    global.__escortChartPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: process.env.NODE_ENV === "production" ? 5 : 10,
      ssl:
        process.env.DATABASE_SSL === "false"
          ? false
          : process.env.DATABASE_SSL === "true"
            ? { rejectUnauthorized: false }
            : undefined,
    });
  }
  return global.__escortChartPool;
}

export const db = drizzle(getPool(), { schema: dbSchema });
export * as schema from "./schema";
