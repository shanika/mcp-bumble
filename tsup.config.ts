import { cpSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: true,
  shims: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // Ship the Drizzle migration files next to dist/index.js so runMigrations()
  // can find them at runtime — resolveMigrationsFolder() looks in <moduleDir>/migrations.
  onSuccess: async () => {
    cpSync(
      path.resolve("src/db/migrations"),
      path.resolve("dist/migrations"),
      { recursive: true },
    );
  },
});
