import "dotenv/config";
import { afterAll } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { closeDb } from "../src/lib/db/client";

// Fail loudly rather than skipping: an integration suite that silently
// doesn't run is a worse failure mode than a red one.
if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not set — integration tests need the dockerized Postgres (docker compose up -d db)",
  );
}

// Idempotent, so `npm test` works against a fresh container with no manual step.
const migrationConnection = postgres(process.env.DATABASE_URL, { max: 1 });
await migrate(drizzle(migrationConnection), {
  migrationsFolder: "./src/lib/db/migrations",
});
await migrationConnection.end();

afterAll(async () => {
  await closeDb();
});
