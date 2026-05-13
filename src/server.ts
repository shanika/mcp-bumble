import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { closeDatabase, openDatabase } from "./db/index.js";
import type { AppDatabase } from "./db/index.js";
import { registerAccountTools } from "./tools/accounts.js";

const SERVER_NAME = "mcp-bumble";
const SERVER_VERSION = "0.0.0";

/** Builds a fully-wired McpServer with every Bumble tool registered. */
export function createServer(db: AppDatabase): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  registerAccountTools(server, db);
  return server;
}

/** Boots the MCP server over STDIO. Used by the `mcp-bumble` entrypoint. */
export async function runServer(): Promise<void> {
  const db = openDatabase({ url: process.env.DB_PATH });
  const server = createServer(db);
  const transport = new StdioServerTransport();

  const close = (): void => {
    closeDatabase(db);
  };
  transport.onclose = close;
  process.once("SIGINT", () => {
    close();
    process.exit(0);
  });

  await server.connect(transport);
}
