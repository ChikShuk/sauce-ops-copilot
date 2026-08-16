import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Slice 9's tests import the API route handlers directly, and those use the
// "@/..." alias that Next resolves from tsconfig paths. Vitest does not read
// tsconfig paths, so the alias is declared once here and shared by both
// projects — without it, importing a route fails at resolve time.
const alias = {
  "@": fileURLToPath(new URL("./src", import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          setupFiles: ["tests/setup.integration.ts"],
          // One Postgres, one connection pool, shared across files — and the
          // concurrency test needs deterministic interleaving.
          fileParallelism: false,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
