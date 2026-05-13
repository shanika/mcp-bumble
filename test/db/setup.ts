import {
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from "../../src/db/index.js";

/** Open a fresh in-memory SQLite DB with all migrations applied. */
export function createTestDatabase(): AppDatabase {
  return openDatabase({ url: ":memory:" });
}

/** Convenience for `using` blocks: close the database. */
export function disposeTestDatabase(db: AppDatabase): void {
  closeDatabase(db);
}
