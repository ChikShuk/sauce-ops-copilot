import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts"],
        },
      },
      {
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
