import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../db/index.js";
import type { BumbleAkahuClient } from "../akahu/client.js";
import { runSync, type SyncResult } from "../akahu/sync.js";

const NO_CLIENT_MESSAGE =
  "Akahu credentials not configured. Set AKAHU_APP_TOKEN and AKAHU_USER_TOKEN.";

export interface RefreshArgs {
  accountId?: string;
}

export type RefreshStatus = "ok" | "cooldown";

export interface RefreshResult {
  status: RefreshStatus;
  /** Seconds remaining on the Akahu refresh cooldown, when status is `cooldown` and a `Retry-After` header was provided. */
  cooldownRemaining?: number;
}

export interface SyncToolResult {
  status: "ok" | "failed";
  runId: string;
  imported: number;
  autoMarkedTransfers: number;
  pendingSuggestions: number;
  autoCategorised: number;
  residualUncategorised: number;
  error?: string;
}

interface MaybeAkahuError {
  status?: number;
  isAkahuError?: boolean;
  response?: { headers?: Record<string, unknown> };
}

function asMaybeAkahuError(err: unknown): MaybeAkahuError {
  return typeof err === "object" && err !== null ? (err as MaybeAkahuError) : {};
}

function isCooldownError(err: unknown): boolean {
  return asMaybeAkahuError(err).status === 429;
}

function extractRetryAfterSeconds(err: unknown): number | undefined {
  const headers = asMaybeAkahuError(err).response?.headers;
  if (!headers) return undefined;
  const raw = headers["retry-after"];
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

export async function refreshAccounts(
  client: BumbleAkahuClient,
  args: RefreshArgs = {},
): Promise<RefreshResult> {
  try {
    await client.refresh(
      args.accountId ? { accountId: args.accountId } : {},
    );
    return { status: "ok" };
  } catch (err) {
    if (isCooldownError(err)) {
      const remaining = extractRetryAfterSeconds(err);
      return remaining !== undefined
        ? { status: "cooldown", cooldownRemaining: remaining }
        : { status: "cooldown" };
    }
    throw err;
  }
}

export function summariseSync(result: SyncResult): SyncToolResult {
  return {
    status: result.status,
    runId: result.runId,
    imported: result.transactionsImported,
    autoMarkedTransfers: result.transfersAutoMarked,
    pendingSuggestions: result.transfersSuggested,
    autoCategorised: result.autoCategorized,
    residualUncategorised: result.residualUncategorized,
    ...(result.error ? { error: result.error } : {}),
  };
}

const refreshSchema = {
  accountId: z
    .string()
    .optional()
    .describe(
      "Restrict the refresh to a single Akahu account id (e.g. `acc_…`). Omit to refresh every linked account.",
    ),
};

interface SyncToolDeps {
  /** Override the runSync implementation (tests). */
  runSync?: typeof runSync;
}

/** Registers `refresh` and `sync` MCP tools. */
export function registerSyncTools(
  server: McpServer,
  db: AppDatabase,
  client: BumbleAkahuClient | undefined,
  deps: SyncToolDeps = {},
): void {
  const sync = deps.runSync ?? runSync;

  server.registerTool(
    "refresh",
    {
      title: "Refresh Akahu accounts",
      description:
        "Ask Akahu to repull data from the bank for the linked accounts. Subject to a 15-minute cooldown — when throttled, returns `{ status: 'cooldown', cooldownRemaining }` instead of throwing.",
      inputSchema: refreshSchema,
    },
    async (args) => {
      if (!client) {
        return {
          isError: true,
          content: [{ type: "text", text: NO_CLIENT_MESSAGE }],
        };
      }
      const result = await refreshAccounts(client, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "sync",
    {
      title: "Run Bumble sync",
      description:
        "Run the full nightly sync pipeline now: fetch new transactions from Akahu, auto-mark internal transfers, apply categorization rules. Same code path as `bumble sync --now`. Returns the one-screen summary printed by the CLI.",
      inputSchema: {},
    },
    async () => {
      if (!client) {
        return {
          isError: true,
          content: [{ type: "text", text: NO_CLIENT_MESSAGE }],
        };
      }
      const summary = summariseSync(await sync({ db, client }));
      return {
        content: [{ type: "text", text: JSON.stringify(summary) }],
        structuredContent: summary as unknown as Record<string, unknown>,
      };
    },
  );
}
