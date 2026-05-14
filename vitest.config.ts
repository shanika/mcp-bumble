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
        "src/server.ts",
        "src/db/migrate.ts",
        "src/lib/rules.ts",
        "src/tools/categories.ts",
        "src/tools/rules.ts",
        "src/transport/stdio.ts",
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
