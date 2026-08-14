import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

const connection = postgres(env.DATABASE_URL);

export const db = drizzle(connection, { schema });

// The pool is module-level and otherwise never closed, which leaves Vitest
// hanging after the last test. Long-running processes (the app, the worker)
// never call this.
export async function closeDb(): Promise<void> {
  await connection.end();
}
