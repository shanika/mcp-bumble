import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import express from "express";
import type { Request, Response } from "express";

import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { closeDatabase, openDatabase } from "../db/index.js";
import type { AppDatabase } from "../db/index.js";
import { BumbleOAuthProvider } from "../oauth/provider.js";
import { OAuthStore } from "../oauth/storage.js";
import { createServer } from "../server.js";

export interface HttpTransportConfig {
  /** Canonical issuer URL — e.g. `https://bumble.heycasper.uk`. */
  issuer: string;
  /** Admin password for the consent page. */
  adminPassword: string;
  /** Local port to bind. */
  port: number;
  /** Path to the OAuth state file (or undefined for in-memory). */
  oauthDataFile?: string;
  /** Override the database opener (for tests). */
  openDatabase?: typeof openDatabase;
  /** Host to bind. Defaults to `127.0.0.1`. */
  host?: string;
  /** Optional list of allowed Host header values (DNS rebinding protection). */
  allowedHosts?: string[];
}

export interface RunningHttpTransport {
  server: HttpServer;
  port: number;
  close: () => Promise<void>;
}

/** Required env vars for HTTP transport. Throws if any are missing. */
export function parseHttpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpTransportConfig {
  const issuer = env.OAUTH_ISSUER;
  if (!issuer) throw new Error("OAUTH_ISSUER is required for HTTP transport");
  const adminPassword = env.OAUTH_ADMIN_PASSWORD;
  if (!adminPassword) {
    throw new Error("OAUTH_ADMIN_PASSWORD is required for HTTP transport");
  }
  const port = env.BUMBLE_HTTP_PORT
    ? Number.parseInt(env.BUMBLE_HTTP_PORT, 10)
    : 3001;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(
      `BUMBLE_HTTP_PORT is not a valid port: ${env.BUMBLE_HTTP_PORT}`,
    );
  }
  const config: HttpTransportConfig = {
    issuer,
    adminPassword,
    port,
  };
  if (env.OAUTH_DATA_FILE) config.oauthDataFile = env.OAUTH_DATA_FILE;
  if (env.BUMBLE_HTTP_HOST) config.host = env.BUMBLE_HTTP_HOST;
  if (env.BUMBLE_HTTP_ALLOWED_HOSTS) {
    config.allowedHosts = env.BUMBLE_HTTP_ALLOWED_HOSTS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return config;
}

/**
 * Builds the Express app (no `listen()`). Exported for tests so they can hit
 * it directly without binding a port.
 */
export function createHttpApp(
  config: HttpTransportConfig,
  db: AppDatabase,
): { app: express.Express; close: () => void } {
  const issuerUrl = new URL(config.issuer);
  const resource = config.issuer.replace(/\/$/, "");

  const store = new OAuthStore({
    ...(config.oauthDataFile !== undefined
      ? { filePath: config.oauthDataFile }
      : {}),
  });
  const provider = new BumbleOAuthProvider({
    store,
    resource,
    adminPassword: config.adminPassword,
  });

  const appOptions: { host?: string; allowedHosts?: string[] } = {
    host: config.host ?? "127.0.0.1",
  };
  if (config.allowedHosts) appOptions.allowedHosts = config.allowedHosts;
  const app = createMcpExpressApp(appOptions);

  // Body parsing for non-MCP routes (the OAuth router mounts its own parsers
  // per-handler, but consent POST + introspection style handlers need urlencoded).
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // OAuth endpoints: /register, /authorize, /token, /revoke,
  // /.well-known/oauth-authorization-server, /.well-known/oauth-protected-resource.
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      scopesSupported: ["mcp"],
      resourceName: "Bumble MCP",
    }),
  );

  // Per-session transport map.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const mcpServerUrl = new URL("/mcp", config.issuer);
  const authMiddleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: ["mcp"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
  });

  const postHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport!);
          },
        });
        // onclose only removes from the map. Do NOT call transport.close()
        // again here — that re-enters onclose and recurses infinitely.
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) transports.delete(sid);
        };
        const server = createServer(db);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      if (!transport) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
      console.error("MCP request error:", err);
    }
  };

  const getHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  };

  const deleteHandler = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.post("/mcp", authMiddleware, postHandler);
  app.get("/mcp", authMiddleware, getHandler);
  app.delete("/mcp", authMiddleware, deleteHandler);

  const close = (): void => {
    for (const transport of [...transports.values()]) {
      void transport.close();
    }
    transports.clear();
  };

  return { app, close };
}

/** Boots the HTTP transport. Used by `BUMBLE_TRANSPORT=http`. */
export async function runHttp(
  config: HttpTransportConfig = parseHttpConfigFromEnv(),
): Promise<RunningHttpTransport> {
  const opener = config.openDatabase ?? openDatabase;
  const db = opener({ url: process.env.DB_PATH });
  const { app, close: closeApp } = createHttpApp(config, db);

  const server = await new Promise<HttpServer>((resolve, reject) => {
    const s = app.listen(config.port, (err?: Error) => {
      if (err) reject(err);
      else resolve(s);
    });
  });

  const close = async (): Promise<void> => {
    closeApp();
    closeDatabase(db);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });

  console.log(`Bumble HTTP transport listening on port ${config.port}`);

  return { server, port: config.port, close };
}
