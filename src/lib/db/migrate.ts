import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "../env";

// Resolved against this module's own location, never the working directory.
// The same file runs two ways — `tsx src/lib/db/migrate.ts` in development and
// `node dist/lib/db/migrate.js` in the container — and a CWD-relative path
// would silently mean a different folder in each. The Dockerfile copies the
// migrations next to the compiled output so this holds in both.
const MIGRATIONS_FOLDER = path.join(__dirname, "migrations");

async function main() {
  const connection = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(connection);

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  await connection.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
