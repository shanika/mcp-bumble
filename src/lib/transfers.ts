import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";

import type { AppDatabase } from "../db/index.js";
import {
  accounts as accountsTable,
  internalTransfers,
  internalTransferSuggestions,
  transactions as transactionsTable,
  type NewInternalTransfer,
  type NewInternalTransferSuggestion,
  type Transaction,
} from "../db/schema.js";
import { newSuggestionId, newTransferId } from "./ids.js";

export const TRANSFER_TYPES = new Set([
  "TRANSFER",
  "PAYMENT",
  "DIRECT CREDIT",
  "DIRECT DEBIT",
]);

export const PASS2_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Map of `formatted_account` (e.g. "01-1234-1234567-00") → local account id. */
export type AccountIndex = Map<string, string>;

interface RawAccountShape {
  formatted_account?: string;
}

/** Build an account index from rows already upserted into the local DB. */
export function buildAccountIndexFromDb(db: AppDatabase): AccountIndex {
  const rows = db.select().from(accountsTable).all();
  const index: AccountIndex = new Map();
  for (const row of rows) {
    if (!row.rawJson) continue;
    try {
      const parsed = JSON.parse(row.rawJson) as RawAccountShape;
      if (parsed.formatted_account) {
        index.set(parsed.formatted_account, row.id);
      }
    } catch {
      // Skip malformed rows — formatted_account is only present on Akahu rows.
    }
  }
  return index;
}

/** Build an account index from any caller-supplied list (e.g. fresh Akahu sync). */
export function buildAccountIndex(
  accounts: Array<{ id: string; formattedAccount?: string | null }>,
): AccountIndex {
  const index: AccountIndex = new Map();
  for (const acc of accounts) {
    if (acc.formattedAccount) index.set(acc.formattedAccount, acc.id);
  }
  return index;
}

export function isAlreadyMarkedInternal(
  db: AppDatabase,
  txId: string,
): boolean {
  const debit = db
    .select({ id: internalTransfers.id })
    .from(internalTransfers)
    .where(eq(internalTransfers.debitTransactionId, txId))
    .all();
  if (debit.length > 0) return true;
  const credit = db
    .select({ id: internalTransfers.id })
    .from(internalTransfers)
    .where(eq(internalTransfers.creditTransactionId, txId))
    .all();
  return credit.length > 0;
}

export function hasPendingSuggestion(db: AppDatabase, txId: string): boolean {
  const rows = db
    .select({ id: internalTransferSuggestions.id })
    .from(internalTransferSuggestions)
    .where(
      sql`(${internalTransferSuggestions.debitTransactionId} = ${txId} OR ${internalTransferSuggestions.creditTransactionId} = ${txId}) AND ${internalTransferSuggestions.status} = 'pending'`,
    )
    .all();
  return rows.length > 0;
}

/** Transaction ids in [start, end] inclusive (ISO date strings). Omit either side to skip a bound. */
export function findTxIdsInRange(
  db: AppDatabase,
  start?: string,
  end?: string,
): string[] {
  const conditions = [];
  if (start) conditions.push(gte(transactionsTable.date, start));
  if (end) conditions.push(lte(transactionsTable.date, end));
  const rows = db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .all();
  return rows.map((r) => r.id);
}

export interface RunPass1Result {
  marked: number;
  matchedTxIds: Set<string>;
}

/**
 * Spec §7 Pass 1 — `meta.other_account` matches a known local account.
 * High confidence; writes directly into `internal_transfers`.
 *
 * `candidateTxIds` scopes the work to transactions the caller just imported
 * (sync) or a chosen date range (tool). Already-marked rows are skipped.
 */
export function runPass1(
  db: AppDatabase,
  candidateTxIds: string[],
  accountIndex: AccountIndex,
  now: string,
): RunPass1Result {
  if (candidateTxIds.length === 0) {
    return { marked: 0, matchedTxIds: new Set() };
  }
  const candidates = db
    .select()
    .from(transactionsTable)
    .where(inArray(transactionsTable.id, candidateTxIds))
    .all() as Transaction[];

  let marked = 0;
  const matchedTxIds = new Set<string>();

  for (const tx of candidates) {
    if (matchedTxIds.has(tx.id)) continue;
    if (!TRANSFER_TYPES.has(tx.type)) continue;
    if (!tx.metaOtherAccount) continue;

    const otherAccountId = accountIndex.get(tx.metaOtherAccount);
    if (!otherAccountId) continue;
    if (otherAccountId === tx.accountId) continue;
    if (isAlreadyMarkedInternal(db, tx.id)) continue;

    const counterpart = db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.accountId, otherAccountId),
          eq(transactionsTable.amount, -tx.amount),
        ),
      )
      .all()
      .find(
        (c) =>
          !matchedTxIds.has(c.id) &&
          Math.abs(new Date(c.date).getTime() - new Date(tx.date).getTime()) <=
            PASS2_WINDOW_MS &&
          !isAlreadyMarkedInternal(db, c.id),
      );

    const debit = tx.amount < 0 ? tx : counterpart;
    const credit = tx.amount < 0 ? counterpart : tx;

    if (!debit) continue;

    const insert: NewInternalTransfer = {
      id: newTransferId(),
      debitTransactionId: debit.id,
      creditTransactionId: credit?.id ?? null,
      detectionMethod: counterpart ? "auto_matched" : "auto_other_account",
      markedAt: now,
    };
    try {
      db.insert(internalTransfers).values(insert).run();
      marked += 1;
      matchedTxIds.add(debit.id);
      if (credit) matchedTxIds.add(credit.id);
    } catch {
      // UNIQUE on debit_transaction_id — already marked by a concurrent pass.
    }
  }

  return { marked, matchedTxIds };
}

/**
 * Spec §7 Pass 2 — amount + 48h window matching. Persists pending rows in
 * `internal_transfer_suggestions` for later user confirmation.
 */
export function runPass2(
  db: AppDatabase,
  candidateTxIds: string[],
  skipIds: Set<string>,
  now: string,
): number {
  if (candidateTxIds.length === 0) return 0;
  const candidates = db
    .select()
    .from(transactionsTable)
    .where(inArray(transactionsTable.id, candidateTxIds))
    .all() as Transaction[];

  let suggested = 0;
  const localMatched = new Set<string>();

  for (const tx of candidates) {
    if (skipIds.has(tx.id) || localMatched.has(tx.id)) continue;
    if (!TRANSFER_TYPES.has(tx.type)) continue;
    if (isAlreadyMarkedInternal(db, tx.id)) continue;
    if (hasPendingSuggestion(db, tx.id)) continue;

    const others = db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.amount, -tx.amount),
          sql`${transactionsTable.accountId} != ${tx.accountId}`,
        ),
      )
      .all() as Transaction[];

    const counterpart = others.find(
      (c) =>
        !skipIds.has(c.id) &&
        !localMatched.has(c.id) &&
        TRANSFER_TYPES.has(c.type) &&
        Math.abs(new Date(c.date).getTime() - new Date(tx.date).getTime()) <=
          PASS2_WINDOW_MS &&
        !isAlreadyMarkedInternal(db, c.id) &&
        !hasPendingSuggestion(db, c.id),
    );
    if (!counterpart) continue;

    const debit = tx.amount < 0 ? tx : counterpart;
    const credit = tx.amount < 0 ? counterpart : tx;

    const insert: NewInternalTransferSuggestion = {
      id: newSuggestionId(),
      debitTransactionId: debit.id,
      creditTransactionId: credit.id,
      detectionMethod: "amount_window",
      confidence: "medium",
      suggestedAt: now,
      status: "pending",
    };
    try {
      db.insert(internalTransferSuggestions).values(insert).run();
      suggested += 1;
      localMatched.add(debit.id);
      localMatched.add(credit.id);
    } catch {
      // UNIQUE(debit, credit) — already suggested.
    }
  }

  return suggested;
}
