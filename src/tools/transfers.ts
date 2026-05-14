import { z } from "zod";
import { and, desc, eq, gte, inArray, lte, or, type SQL } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../db/index.js";
import {
  internalTransfers,
  internalTransferSuggestions,
  transactions as transactionsTable,
} from "../db/schema.js";
import { newTransferId } from "../lib/ids.js";
import {
  buildAccountIndexFromDb,
  findTxIdsInRange,
  runPass1,
  runPass2,
} from "../lib/transfers.js";

export type TransferDetectionMethod =
  | "auto_other_account"
  | "auto_matched"
  | "manual"
  | "amount_window";

export type TransferConfidence = "high" | "medium";

export type TransferPairStatus = "pending" | "auto_marked";

export interface TransferPair {
  pairId: string;
  debitTransactionId: string;
  creditTransactionId: string | null;
  detectionMethod: TransferDetectionMethod;
  confidence: TransferConfidence;
  status: TransferPairStatus;
  debitDate?: string;
  creditDate?: string | null;
  amount?: number;
}

export interface DetectInternalTransfersArgs {
  start?: string;
  end?: string;
}

export interface DetectInternalTransfersResult {
  pairs: TransferPair[];
}

export interface MarkInternalTransferArgs {
  transferPairs?: string[];
  transactionIds?: string[];
  reason?: string;
}

export interface MarkInternalTransferResult {
  marked: number;
}

export interface InternalTransferView {
  id: string;
  debitTransactionId: string;
  creditTransactionId: string | null;
  detectionMethod: TransferDetectionMethod;
  markedAt: string;
  debitDate: string;
  creditDate: string | null;
  amount: number;
}

export interface ListInternalTransfersArgs {
  start?: string;
  end?: string;
}

export interface ListInternalTransfersResult {
  transfers: InternalTransferView[];
}

export interface UnmarkInternalTransferArgs {
  transactionIds: string[];
}

export interface UnmarkInternalTransferResult {
  unmarked: number;
}

function pendingSuggestionConditions(args: DetectInternalTransfersArgs): SQL[] {
  const conditions: SQL[] = [
    eq(internalTransferSuggestions.status, "pending"),
  ];
  if (args.start) {
    conditions.push(gte(internalTransferSuggestions.suggestedAt, args.start));
  }
  if (args.end) {
    conditions.push(lte(internalTransferSuggestions.suggestedAt, args.end));
  }
  return conditions;
}

/**
 * §3.4 detect_internal_transfers. Always returns Pass-2 pending suggestions
 * scoped to the (optional) date range. When `start` or `end` is provided we
 * also re-run the heuristic over the matching transactions: Pass-1 auto-marks
 * any newly-resolvable pairs (e.g. a counterpart that has since synced) and
 * Pass-2 writes fresh pending suggestions for transactions the cron hadn't
 * seen yet.
 */
export function detectInternalTransfers(
  db: AppDatabase,
  args: DetectInternalTransfersArgs,
  now: () => Date = () => new Date(),
): DetectInternalTransfersResult {
  if (args.start || args.end) {
    const nowIso = now().toISOString();
    const candidateIds = findTxIdsInRange(db, args.start, args.end);
    if (candidateIds.length > 0) {
      const accountIndex = buildAccountIndexFromDb(db);
      const pass1 = runPass1(db, candidateIds, accountIndex, nowIso);
      const skipIds = new Set<string>(pass1.matchedTxIds);
      runPass2(db, candidateIds, skipIds, nowIso);
    }
  }

  const suggestionConditions = pendingSuggestionConditions(args);
  const suggestionRows = db
    .select({
      id: internalTransferSuggestions.id,
      debitTransactionId: internalTransferSuggestions.debitTransactionId,
      creditTransactionId: internalTransferSuggestions.creditTransactionId,
      detectionMethod: internalTransferSuggestions.detectionMethod,
      confidence: internalTransferSuggestions.confidence,
      debitDate: transactionsTable.date,
      amount: transactionsTable.amount,
    })
    .from(internalTransferSuggestions)
    .innerJoin(
      transactionsTable,
      eq(transactionsTable.id, internalTransferSuggestions.debitTransactionId),
    )
    .where(and(...suggestionConditions))
    .orderBy(desc(transactionsTable.date), desc(internalTransferSuggestions.id))
    .all();

  const creditDates = creditDateLookup(
    db,
    suggestionRows.map((r) => r.creditTransactionId).filter((id): id is string =>
      Boolean(id),
    ),
  );

  const pairs: TransferPair[] = suggestionRows.map((row) => ({
    pairId: row.id,
    debitTransactionId: row.debitTransactionId,
    creditTransactionId: row.creditTransactionId,
    detectionMethod: row.detectionMethod as TransferDetectionMethod,
    confidence: (row.confidence as TransferConfidence) ?? "medium",
    status: "pending",
    debitDate: row.debitDate,
    creditDate: row.creditTransactionId
      ? (creditDates.get(row.creditTransactionId) ?? null)
      : null,
    amount: Math.abs(row.amount),
  }));

  return { pairs };
}

function creditDateLookup(
  db: AppDatabase,
  ids: string[],
): Map<string, string> {
  if (ids.length === 0) return new Map();
  const rows = db
    .select({ id: transactionsTable.id, date: transactionsTable.date })
    .from(transactionsTable)
    .where(inArray(transactionsTable.id, ids))
    .all();
  return new Map(rows.map((r) => [r.id, r.date]));
}

/**
 * §3.4 mark_internal_transfer. Either confirms one or more pending Pass-2
 * suggestions by id (`transferPairs`) or marks a list of transactions as
 * internal transfers manually (`transactionIds`). At least one of the two
 * must be provided. `reason` is accepted for LLM legibility but is not
 * persisted (the schema's `detection_method` already captures provenance).
 */
export function markInternalTransfer(
  db: AppDatabase,
  args: MarkInternalTransferArgs,
  now: () => Date = () => new Date(),
): MarkInternalTransferResult {
  const transferPairs = args.transferPairs ?? [];
  const transactionIds = args.transactionIds ?? [];
  if (transferPairs.length === 0 && transactionIds.length === 0) {
    throw new Error(
      "mark_internal_transfer requires `transferPairs` or `transactionIds`",
    );
  }

  const nowIso = now().toISOString();
  let marked = 0;

  if (transferPairs.length > 0) {
    const suggestions = db
      .select()
      .from(internalTransferSuggestions)
      .where(
        and(
          inArray(internalTransferSuggestions.id, transferPairs),
          eq(internalTransferSuggestions.status, "pending"),
        ),
      )
      .all();
    const foundIds = new Set(suggestions.map((s) => s.id));
    for (const requested of transferPairs) {
      if (!foundIds.has(requested)) {
        throw new Error(`Unknown or non-pending transferPair: ${requested}`);
      }
    }
    for (const sugg of suggestions) {
      try {
        db.insert(internalTransfers)
          .values({
            id: newTransferId(),
            debitTransactionId: sugg.debitTransactionId,
            creditTransactionId: sugg.creditTransactionId,
            detectionMethod: "manual",
            markedAt: nowIso,
          })
          .run();
        marked += 1;
      } catch {
        // UNIQUE(debit_transaction_id) — debit leg already marked, skip silently.
      }
      db.update(internalTransferSuggestions)
        .set({ status: "confirmed" })
        .where(eq(internalTransferSuggestions.id, sugg.id))
        .run();
    }
  }

  if (transactionIds.length > 0) {
    const txRows = db
      .select()
      .from(transactionsTable)
      .where(inArray(transactionsTable.id, transactionIds))
      .all();
    const txById = new Map(txRows.map((row) => [row.id, row]));
    for (const id of transactionIds) {
      if (!txById.has(id)) {
        throw new Error(`Unknown transactionId: ${id}`);
      }
      try {
        db.insert(internalTransfers)
          .values({
            id: newTransferId(),
            debitTransactionId: id,
            creditTransactionId: null,
            detectionMethod: "manual",
            markedAt: nowIso,
          })
          .run();
        marked += 1;
      } catch {
        // Already marked — idempotent.
      }
    }
  }

  return { marked };
}

/**
 * §3.4 list_internal_transfers. Returns confirmed marks (auto + manual)
 * joined to their debit/credit transaction dates and amount.
 */
export function listInternalTransfers(
  db: AppDatabase,
  args: ListInternalTransfersArgs = {},
): ListInternalTransfersResult {
  const conditions: SQL[] = [];
  if (args.start) conditions.push(gte(transactionsTable.date, args.start));
  if (args.end) conditions.push(lte(transactionsTable.date, args.end));

  const rows = db
    .select({
      id: internalTransfers.id,
      debitTransactionId: internalTransfers.debitTransactionId,
      creditTransactionId: internalTransfers.creditTransactionId,
      detectionMethod: internalTransfers.detectionMethod,
      markedAt: internalTransfers.markedAt,
      debitDate: transactionsTable.date,
      amount: transactionsTable.amount,
    })
    .from(internalTransfers)
    .innerJoin(
      transactionsTable,
      eq(transactionsTable.id, internalTransfers.debitTransactionId),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(transactionsTable.date), desc(internalTransfers.id))
    .all();

  const creditDates = creditDateLookup(
    db,
    rows
      .map((r) => r.creditTransactionId)
      .filter((id): id is string => Boolean(id)),
  );

  return {
    transfers: rows.map((row) => ({
      id: row.id,
      debitTransactionId: row.debitTransactionId,
      creditTransactionId: row.creditTransactionId,
      detectionMethod: row.detectionMethod as TransferDetectionMethod,
      markedAt: row.markedAt,
      debitDate: row.debitDate,
      creditDate: row.creditTransactionId
        ? (creditDates.get(row.creditTransactionId) ?? null)
        : null,
      amount: Math.abs(row.amount),
    })),
  };
}

/**
 * §3.4 unmark_internal_transfer. Deletes any `internal_transfers` rows where
 * either leg matches the supplied transaction id and dismisses any pending
 * Pass-2 suggestions touching the same transactions (so a rejected pair
 * doesn't keep resurfacing). Returns the number of confirmed rows removed.
 */
export function unmarkInternalTransfer(
  db: AppDatabase,
  args: UnmarkInternalTransferArgs,
): UnmarkInternalTransferResult {
  if (args.transactionIds.length === 0) {
    throw new Error(
      "unmark_internal_transfer requires a non-empty transactionIds array",
    );
  }
  const result = db
    .delete(internalTransfers)
    .where(
      or(
        inArray(internalTransfers.debitTransactionId, args.transactionIds),
        inArray(
          internalTransfers.creditTransactionId,
          args.transactionIds,
        ),
      ) as SQL,
    )
    .run();

  db.update(internalTransferSuggestions)
    .set({ status: "dismissed" })
    .where(
      and(
        eq(internalTransferSuggestions.status, "pending"),
        or(
          inArray(
            internalTransferSuggestions.debitTransactionId,
            args.transactionIds,
          ),
          inArray(
            internalTransferSuggestions.creditTransactionId,
            args.transactionIds,
          ),
        ) as SQL,
      ),
    )
    .run();

  return { unmarked: Number(result.changes ?? 0) };
}

const detectInput = {
  start: z
    .string()
    .optional()
    .describe(
      "ISO date lower bound (inclusive). Provide either bound to re-run the heuristic over that window.",
    ),
  end: z.string().optional().describe("ISO date upper bound (inclusive)."),
};

const markInput = {
  transferPairs: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Suggestion ids returned by detect_internal_transfers to confirm in bulk.",
    ),
  transactionIds: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Transaction ids to mark manually as internal transfers (one-sided).",
    ),
  reason: z
    .string()
    .optional()
    .describe(
      "Optional free-text note explaining the manual mark; not persisted.",
    ),
};

const listInput = {
  start: z.string().optional().describe("ISO date lower bound (inclusive)."),
  end: z.string().optional().describe("ISO date upper bound (inclusive)."),
};

const unmarkInput = {
  transactionIds: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "Transaction ids whose internal-transfer markings should be removed.",
    ),
};

/** Registers `detect_internal_transfers`, `mark_internal_transfer`, `list_internal_transfers`, and `unmark_internal_transfer`. */
export function registerTransferTools(
  server: McpServer,
  db: AppDatabase,
  now: () => Date = () => new Date(),
): void {
  server.registerTool(
    "detect_internal_transfers",
    {
      title: "Detect internal transfers",
      description:
        "Surface pending Pass-2 internal transfer suggestions from the nightly sync. If a date range is provided, also re-runs the heuristic so freshly-resolvable pairs are picked up.",
      inputSchema: detectInput,
    },
    (args) => {
      const result = detectInternalTransfers(
        db,
        args as DetectInternalTransfersArgs,
        now,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "mark_internal_transfer",
    {
      title: "Mark internal transfer",
      description:
        "Confirm one or more pending Pass-2 transfer suggestions (transferPairs) and/or mark transactions as internal transfers manually (transactionIds).",
      inputSchema: markInput,
    },
    (args) => {
      const result = markInternalTransfer(
        db,
        args as MarkInternalTransferArgs,
        now,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "list_internal_transfers",
    {
      title: "List internal transfers",
      description:
        "List confirmed internal transfer markings (auto-marked Pass-1 + user-confirmed + manual), newest-first, optionally filtered by debit date.",
      inputSchema: listInput,
    },
    (args) => {
      const result = listInternalTransfers(
        db,
        args as ListInternalTransfersArgs,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "unmark_internal_transfer",
    {
      title: "Unmark internal transfer",
      description:
        "Remove the internal transfer mark for the listed transactions (reverses both auto-marked and manual rows) and dismisses any pending Pass-2 suggestion involving them.",
      inputSchema: unmarkInput,
    },
    (args) => {
      const result = unmarkInternalTransfer(
        db,
        args as UnmarkInternalTransferArgs,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
