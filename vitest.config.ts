import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      // Stub modules listed below are placeholders filled in by FAM-253 → FAM-257.
      // Each downstream task should remove its own entry from this list as it
      // adds coverage for the module.
      exclude: [
        "src/**/*.d.ts",
        "src/index.ts",
        "src/cli.ts",
        "src/server.ts",
        "src/db/migrate.ts",
        "src/akahu/client.ts",
        "src/akahu/sync.ts",
        "src/lib/cache.ts",
        "src/lib/rules.ts",
        "src/lib/transfers.ts",
        "src/tools/accounts.ts",
        "src/tools/categories.ts",
        "src/tools/rules.ts",
        "src/tools/transactions.ts",
        "src/tools/transfers.ts",
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});
