import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { BumbleAkahuClient } from "./akahu/client.js";
import type { AppDatabase } from "./db/index.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerRuleTools } from "./tools/rules.js";
import { registerSyncTools } from "./tools/sync.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerTransferTools } from "./tools/transfers.js";

const SERVER_NAME = "mcp-bumble";
const SERVER_VERSION = "1.2.0";

export interface CreateServerOptions {
  /**
   * Akahu client used by the `refresh` and `sync` tools. When omitted (e.g.
   * read-only deployments without Akahu credentials in the env), those tools
   * still register but return a clear "credentials not configured" error when
   * invoked.
   */
  akahuClient?: BumbleAkahuClient;
}

/** Builds a fully-wired McpServer with every Bumble tool registered. */
export function createServer(
  db: AppDatabase,
  options: CreateServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerAccountTools(server, db);
  registerTransactionTools(server, db);
  registerCategoryTools(server, db);
  registerRuleTools(server, db);
  registerTransferTools(server, db);
  registerSyncTools(server, db, options.akahuClient);
  return server;
}
