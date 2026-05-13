import { runCli } from "./cli.js";
import { runServer } from "./server.js";

const subcommand = process.argv[2];

if (subcommand === "sync") {
  await runCli(process.argv.slice(2));
} else {
  await runServer();
}
