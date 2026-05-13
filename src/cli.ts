import { closeDatabase, openDatabase } from "./db/index.js";
import { BumbleAkahuClient } from "./akahu/client.js";
import { runSync, type SyncResult } from "./akahu/sync.js";

export interface CliEnv {
  AKAHU_APP_TOKEN?: string;
  AKAHU_USER_TOKEN?: string;
  DB_PATH?: string;
}

export interface CliDeps {
  env?: CliEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Override how the DB is opened (used by tests to inject an in-memory db). */
  openDatabase?: typeof openDatabase;
  /** Override how the Akahu client is constructed (used by tests). */
  createClient?: (env: CliEnv) => BumbleAkahuClient;
  /** Override the sync runner (used by tests). */
  runSync?: typeof runSync;
}

export interface ParsedArgs {
  command: "sync" | "help";
  immediate: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === "sync") {
    return { command: "sync", immediate: rest.includes("--now") };
  }
  return { command: "help", immediate: false };
}

function requireEnv(env: CliEnv, key: keyof CliEnv): string {
  const value = env[key];
  if (!value || value.length === 0) {
    throw new Error(`${key} is required but not set in the environment.`);
  }
  return value;
}

function formatSummary(result: SyncResult): string {
  const lines = [
    `sync ${result.status} run=${result.runId}`,
    `  fetched from: ${result.fetchedFrom}`,
    `  imported: ${result.transactionsImported}`,
    `  auto-marked transfers: ${result.transfersAutoMarked}`,
    `  pending transfer suggestions: ${result.transfersSuggested}`,
    `  auto-categorised: ${result.autoCategorized}`,
    `  residual uncategorised: ${result.residualUncategorized}`,
  ];
  if (result.error) lines.push(`  error: ${result.error}`);
  return lines.join("\n");
}

export async function runCli(
  argv: string[],
  deps: CliDeps = {},
): Promise<number> {
  const env = deps.env ?? (process.env as CliEnv);
  const stdout = deps.stdout ?? ((line) => console.log(line));
  const stderr = deps.stderr ?? ((line) => console.error(line));
  const opener = deps.openDatabase ?? openDatabase;
  const sync = deps.runSync ?? runSync;

  const parsed = parseArgs(argv);

  if (parsed.command === "help") {
    stdout("Usage: bumble sync [--now]");
    return 0;
  }

  let client: BumbleAkahuClient;
  try {
    if (deps.createClient) {
      client = deps.createClient(env);
    } else {
      const appToken = requireEnv(env, "AKAHU_APP_TOKEN");
      const userToken = requireEnv(env, "AKAHU_USER_TOKEN");
      client = new BumbleAkahuClient({
        credentials: { appToken, userToken },
      });
    }
  } catch (err) {
    stderr((err as Error).message);
    return 2;
  }

  const db = opener({ url: env.DB_PATH });
  try {
    const result = await sync({ db, client });
    stdout(formatSummary(result));
    return result.status === "ok" ? 0 : 1;
  } finally {
    closeDatabase(db);
  }
}
