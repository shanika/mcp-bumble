import { runCli } from "./cli.js";
import { runServer } from "./server.js";

const subcommand = process.argv[2];

if (subcommand === "sync") {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
} else {
  await runServer();
}
