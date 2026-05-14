import { runCli } from "./cli.js";
import { runHttp } from "./transport/http.js";
import { runStdio } from "./transport/stdio.js";

const subcommand = process.argv[2];

if (subcommand === "sync") {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
} else if (process.env.BUMBLE_TRANSPORT === "http") {
  await runHttp();
} else {
  await runStdio();
}
