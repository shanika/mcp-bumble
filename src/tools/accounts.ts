import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../db/index.js";
import { accounts as accountsTable } from "../db/schema.js";

export interface AccountBalance {
  available: number | null;
  current: number | null;
  currency: string;
}

export interface AccountSummary {
  id: string;
  name: string;
  type: string;
  institution: string;
  balance: AccountBalance;
}

export interface BalanceSummary {
  accountName: string;
  available: number | null;
  current: number | null;
  currency: string;
}

export interface GetBalancesArgs {
  accountNameFilter?: string;
}

const DEFAULT_CURRENCY = "NZD";

/**
 * Reads every account row from local SQLite and shapes it to the spec §3.1
 * surface. Reads only — the nightly cron (FAM-253) is responsible for keeping
 * `accounts` up to date.
 */
export function listAccounts(db: AppDatabase): AccountSummary[] {
  const rows = db.select().from(accountsTable).all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    institution: row.institution,
    balance: {
      available: row.balanceAvailable,
      current: row.balanceCurrent,
      currency: row.currency ?? DEFAULT_CURRENCY,
    },
  }));
}

/**
 * Returns balances, optionally filtered by case-insensitive substring match on
 * the account name (matches the §2.2 user story: "savings" → "ANZ Joint
 * Savings"). An empty or whitespace-only filter returns every account.
 */
export function getBalances(
  db: AppDatabase,
  options: GetBalancesArgs = {},
): BalanceSummary[] {
  const needle = options.accountNameFilter?.trim().toLowerCase() ?? "";
  const rows = db.select().from(accountsTable).all();
  const matched =
    needle.length === 0
      ? rows
      : rows.filter((row) => row.name.toLowerCase().includes(needle));

  return matched.map((row) => ({
    accountName: row.name,
    available: row.balanceAvailable,
    current: row.balanceCurrent,
    currency: row.currency ?? DEFAULT_CURRENCY,
  }));
}

/** Registers `list_accounts` + `get_balances` on the given McpServer. */
export function registerAccountTools(server: McpServer, db: AppDatabase): void {
  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "List every connected Akahu account with its latest available and current balance.",
      inputSchema: {},
    },
    () => {
      const accounts = listAccounts(db);
      return {
        content: [{ type: "text", text: JSON.stringify({ accounts }) }],
        structuredContent: { accounts },
      };
    },
  );

  server.registerTool(
    "get_balances",
    {
      title: "Get balances",
      description:
        "Return account balances, optionally filtered by a case-insensitive substring match on account name.",
      inputSchema: {
        accountNameFilter: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring; matches any account whose name contains it. Omit to return every account.",
          ),
      },
    },
    (args) => {
      const balances = getBalances(db, args);
      return {
        content: [{ type: "text", text: JSON.stringify({ balances }) }],
        structuredContent: { balances },
      };
    },
  );
}
