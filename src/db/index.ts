import { fileURLToPath } from "node:url";
import path from "node:path";

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "./schema.js";

export type AppDatabase = BetterSQLite3Database<typeof schema> & {
  $client: DatabaseType;
};

export interface OpenDatabaseOptions {
  /** Path to the SQLite file. `":memory:"` opens an in-memory database. Defaults to `process.env.DB_PATH` or `./bumble.db`. */
  url?: string;
  /** When true, runs migrations immediately after opening. Defaults to true. */
  runMigrations?: boolean;
  /** Override the migrations folder location. Defaults to `<package>/src/db/migrations`. */
  migrationsFolder?: string;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function resolveMigrationsFolder(): string {
  // Works for both source (src/db) and bundled (dist) layouts: migrations sit next to this file.
  return path.join(moduleDir, "migrations");
}

export function openDatabase(options: OpenDatabaseOptions = {}): AppDatabase {
  const url = options.url ?? process.env.DB_PATH ?? "./bumble.db";
  const sqlite = new Database(url);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema }) as AppDatabase;

  if (options.runMigrations !== false) {
    runMigrations(db, options.migrationsFolder);
  }

  return db;
}

export function runMigrations(db: AppDatabase, migrationsFolder?: string): void {
  migrate(db, { migrationsFolder: migrationsFolder ?? resolveMigrationsFolder() });
}

export function closeDatabase(db: AppDatabase): void {
  db.$client.close();
}

export { schema };
