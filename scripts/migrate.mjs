// Runs pending SQL migrations against DATABASE_URL, then exits. Deliberately
// plain JS with no TypeScript/drizzle-kit dependency: drizzle-kit is a dev
// dependency and isn't present in the standalone Docker image, but this
// script only needs `pg` and `drizzle-orm`, which are production
// dependencies bundled into the image. Run this once before starting the
// server against a fresh database (the Docker entrypoint does this
// automatically — see docker-entrypoint.sh).
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set — can't run migrations.");
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });
  // In Docker Compose, Postgres and the app start together — the
  // healthcheck usually means Postgres is ready by the time we get here,
  // but retry a bit anyway in case this runs before that (e.g. `docker run`
  // without Compose's `depends_on: condition: service_healthy`).
  const maxAttempts = 30;
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("select 1");
      break;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      console.log(`Database not ready yet (attempt ${attempt}/${maxAttempts}) — retrying in 2s…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const db = drizzle(pool);
  console.log("Running migrations…");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations up to date.");
  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
