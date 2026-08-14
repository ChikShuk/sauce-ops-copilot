import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { env } from "../env";

async function main() {
  const connection = postgres(env.DATABASE_URL, { max: 1 });
  const db = drizzle(connection);

  await migrate(db, { migrationsFolder: "./src/lib/db/migrations" });

  await connection.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
