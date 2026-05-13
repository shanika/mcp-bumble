import { closeDatabase, openDatabase } from "./index.js";

function main(): void {
  const db = openDatabase();
  closeDatabase(db);
  process.stdout.write("Migrations applied.\n");
}

main();
