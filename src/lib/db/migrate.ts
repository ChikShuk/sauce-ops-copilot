import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

async function main() {
  const connection = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const db = drizzle(connection);

  await migrate(db, { migrationsFolder: "./src/lib/db/migrations" });

  await connection.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
