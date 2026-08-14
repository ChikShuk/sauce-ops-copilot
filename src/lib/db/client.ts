import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const connection = postgres(process.env.DATABASE_URL);

export const db = drizzle(connection, { schema });

// The pool is module-level and otherwise never closed, which leaves Vitest
// hanging after the last test. Long-running processes (the app, the worker)
// never call this.
export async function closeDb(): Promise<void> {
  await connection.end();
}
