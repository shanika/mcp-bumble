import { z } from "zod";
import {
  and,
  desc,
  eq,
  gte,
  isNull,
  like,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../db/index.js";
import {
  internalTransfers,
  syncRuns,
  transactionCategories,
  transactions as transactionsTable,
} from "../db/schema.js";

export interface TransactionView {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amount: number;
  type: string;
  merchantName: string | null;
  akahuCategory: string | null;
}

export interface UncategorizedTransactionView extends TransactionView {
  akahuCategory: string | null;
}

export interface ListTransactionsArgs {
  accountId?: string;
  start?: string;
  end?: string;
  limit?: number;
  cursor?: string;
}

export interface ListTransactionsResult {
  transactions: TransactionView[];
  nextCursor?: string;
}

export interface SearchTransactionsArgs {
  query: string;
  start?: string;
  end?: string;
  limit?: number;
}

export interface SearchTransactionsResult {
  transactions: TransactionView[];
}

export interface ListUncategorizedArgs {
  start?: string;
  end?: string;
  limit?: number;
  cursor?: string;
}

export interface ListUncategorizedResult {
  transactions: UncategorizedTransactionView[];
  nextCursor?: string;
  warning?: string;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const STALE_SYNC_MS = 30 * 60 * 60 * 1000;

interface Cursor {
  date: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<Cursor>;
    if (typeof parsed.date === "string" && typeof parsed.id === "string") {
      return { date: parsed.date, id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

type TxRow = typeof transactionsTable.$inferSelect;

function toView(row: TxRow): TransactionView {
  return {
    id: row.id,
    accountId: row.accountId,
    date: row.date,
    description: row.description,
    amount: row.amount,
    type: row.type,
    merchantName: row.merchantName,
    akahuCategory: row.akahuCategory,
  };
}

function cursorCondition(cursor: Cursor): SQL {
  return or(
    sql`${transactionsTable.date} < ${cursor.date}`,
    and(
      eq(transactionsTable.date, cursor.date),
      sql`${transactionsTable.id} < ${cursor.id}`,
    ),
  ) as SQL;
}

function paginate<T extends TxRow>(
  rows: T[],
  limit: number,
): { page: T[]; nextCursor?: string } {
  if (rows.length <= limit) return { page: rows };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    page,
    nextCursor: last
      ? encodeCursor({ date: last.date, id: last.id })
      : undefined,
  };
}

/**
 * §3.2 list_transactions. Returns rows ordered by date DESC, id DESC for stable
 * cursor pagination. The cursor encodes the last seen `{date, id}` — the next
 * page is rows strictly earlier than that pair.
 */
export function listTransactions(
  db: AppDatabase,
  args: ListTransactionsArgs = {},
): ListTransactionsResult {
  const limit = clampLimit(args.limit);
  const cursor = args.cursor ? decodeCursor(args.cursor) : null;

  const conditions: SQL[] = [];
  if (args.accountId) {
    conditions.push(eq(transactionsTable.accountId, args.accountId));
  }
  if (args.start) {
    conditions.push(gte(transactionsTable.date, args.start));
  }
  if (args.end) {
    conditions.push(lte(transactionsTable.date, args.end));
  }
  if (cursor) {
    conditions.push(cursorCondition(cursor));
  }

  const rows = db
    .select()
    .from(transactionsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(transactionsTable.date), desc(transactionsTable.id))
    .limit(limit + 1)
    .all();

  const { page, nextCursor } = paginate(rows, limit);
  return {
    transactions: page.map(toView),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

/**
 * §3.2 search_transactions. Case-insensitive substring search across
 * `description` and `merchant_name`. No cursor — spec returns a single page.
 */
export function searchTransactions(
  db: AppDatabase,
  args: SearchTransactionsArgs,
): SearchTransactionsResult {
  const query = args.query.trim();
  if (query.length === 0) {
    return { transactions: [] };
  }
  const limit = clampLimit(args.limit);
  const needle = `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

  const conditions: SQL[] = [
    or(
      like(sql`lower(${transactionsTable.description})`, needle.toLowerCase()),
      like(sql`lower(${transactionsTable.merchantName})`, needle.toLowerCase()),
    ) as SQL,
  ];
  if (args.start) {
    conditions.push(gte(transactionsTable.date, args.start));
  }
  if (args.end) {
    conditions.push(lte(transactionsTable.date, args.end));
  }

  const rows = db
    .select()
    .from(transactionsTable)
    .where(and(...conditions))
    .orderBy(desc(transactionsTable.date), desc(transactionsTable.id))
    .limit(limit)
    .all();

  return { transactions: rows.map(toView) };
}

/**
 * §2.3 / §3.2 list_uncategorized. Joins transactions LEFT against
 * `transaction_categories` (exclude any with a user category) and LEFT against
 * `internal_transfers` on either debit or credit (exclude marked transfers).
 * Surfaces a warning when the most recent `sync_runs` row is failed or older
 * than 30h, per §4.1 failure handling.
 */
export function listUncategorized(
  db: AppDatabase,
  args: ListUncategorizedArgs = {},
  now: () => Date = () => new Date(),
): ListUncategorizedResult {
  const limit = clampLimit(args.limit);
  const cursor = args.cursor ? decodeCursor(args.cursor) : null;

  const conditions: SQL[] = [
    isNull(transactionCategories.transactionId),
    isNull(internalTransfers.id),
  ];
  if (args.start) {
    conditions.push(gte(transactionsTable.date, args.start));
  }
  if (args.end) {
    conditions.push(lte(transactionsTable.date, args.end));
  }
  if (cursor) {
    conditions.push(cursorCondition(cursor));
  }

  const internalJoin = or(
    eq(internalTransfers.debitTransactionId, transactionsTable.id),
    eq(internalTransfers.creditTransactionId, transactionsTable.id),
  ) as SQL;

  const rows = db
    .select({ tx: transactionsTable })
    .from(transactionsTable)
    .leftJoin(
      transactionCategories,
      eq(transactionCategories.transactionId, transactionsTable.id),
    )
    .leftJoin(internalTransfers, internalJoin)
    .where(and(...conditions))
    .orderBy(desc(transactionsTable.date), desc(transactionsTable.id))
    .limit(limit + 1)
    .all()
    .map((r) => r.tx);

  const { page, nextCursor } = paginate(rows, limit);
  const warning = buildSyncWarning(db, now());

  return {
    transactions: page.map(toView),
    ...(nextCursor ? { nextCursor } : {}),
    ...(warning ? { warning } : {}),
  };
}

function buildSyncWarning(db: AppDatabase, now: Date): string | undefined {
  const latest = db
    .select()
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(1)
    .all()[0];
  if (!latest) return undefined;

  if (latest.status === "failed") {
    const detail = latest.error?.trim();
    return detail
      ? `Last sync (${latest.startedAt}) failed: ${detail}`
      : `Last sync (${latest.startedAt}) failed.`;
  }

  const startedAt = new Date(latest.startedAt).getTime();
  if (Number.isFinite(startedAt) && now.getTime() - startedAt > STALE_SYNC_MS) {
    const hours = Math.round((now.getTime() - startedAt) / (60 * 60 * 1000));
    return `Last sync was ${hours}h ago (>30h); data may be stale.`;
  }
  return undefined;
}

const listTransactionsSchema = {
  accountId: z
    .string()
    .optional()
    .describe("Restrict to a single Akahu account id."),
  start: z
    .string()
    .optional()
    .describe("ISO date lower bound (inclusive) on transaction date."),
  end: z
    .string()
    .optional()
    .describe("ISO date upper bound (inclusive) on transaction date."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
    ),
  cursor: z
    .string()
    .optional()
    .describe("Opaque cursor returned by a previous call as `nextCursor`."),
};

const searchTransactionsSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      "Case-insensitive substring matched against description and merchant_name.",
    ),
  start: z.string().optional().describe("ISO date lower bound (inclusive)."),
  end: z.string().optional().describe("ISO date upper bound (inclusive)."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
    ),
};

const listUncategorizedSchema = {
  start: z.string().optional().describe("ISO date lower bound (inclusive)."),
  end: z.string().optional().describe("ISO date upper bound (inclusive)."),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      `Max rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
    ),
  cursor: z
    .string()
    .optional()
    .describe("Opaque cursor returned by a previous call as `nextCursor`."),
};

/** Registers `list_transactions` + `search_transactions` + `list_uncategorized`. */
export function registerTransactionTools(
  server: McpServer,
  db: AppDatabase,
  now: () => Date = () => new Date(),
): void {
  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description:
        "List transactions with optional account/date filters. Returns a cursor-paginated page ordered newest-first.",
      inputSchema: listTransactionsSchema,
    },
    (args) => {
      const result = listTransactions(db, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "search_transactions",
    {
      title: "Search transactions",
      description:
        "Case-insensitive substring search across transaction description and merchant_name.",
      inputSchema: searchTransactionsSchema,
    },
    (args) => {
      const result = searchTransactions(db, args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "list_uncategorized",
    {
      title: "List uncategorized transactions",
      description:
        "List transactions that have no user category and are not marked as internal transfers. Includes Akahu's suggested category and a warning when the last sync failed or is older than 30h.",
      inputSchema: listUncategorizedSchema,
    },
    (args) => {
      const result = listUncategorized(db, args, now);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
