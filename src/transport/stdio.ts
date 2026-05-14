import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { closeDatabase, openDatabase } from "../db/index.js";
import { createServer } from "../server.js";

/** Boots the MCP server over STDIO. Used by `npx mcp-bumble` / Claude Desktop. */
export async function runStdio(): Promise<void> {
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
