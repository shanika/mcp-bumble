import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "./db/index.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerRuleTools } from "./tools/rules.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerTransferTools } from "./tools/transfers.js";

const SERVER_NAME = "mcp-bumble";
const SERVER_VERSION = "1.1.0";

/** Builds a fully-wired McpServer with every Bumble tool registered. */
export function createServer(db: AppDatabase): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerAccountTools(server, db);
  registerTransactionTools(server, db);
  registerCategoryTools(server, db);
  registerRuleTools(server, db);
  registerTransferTools(server, db);
  return server;
}
