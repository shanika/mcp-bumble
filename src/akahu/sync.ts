import { and, eq, inArray, sql } from "drizzle-orm";
import type { Account, Transaction as AkahuTransaction } from "akahu";

import type { AppDatabase } from "../db/index.js";
import {
  accounts as accountsTable,
  categorizationRules,
  internalTransfers,
  internalTransferSuggestions,
  syncRuns,
  syncState,
  transactionCategories,
  transactions as transactionsTable,
  type NewInternalTransfer,
  type NewInternalTransferSuggestion,
  type NewTransactionCategory,
  type Transaction as DbTransaction,
} from "../db/schema.js";
import { newSuggestionId, newSyncRunId, newTransferId } from "../lib/ids.js";
import { BumbleAkahuClient } from "./client.js";

const TRANSACTIONS_STATE_KEY = "transactions";
const TRANSFER_TYPES = new Set([
  "TRANSFER",
  "PAYMENT",
  "DIRECT CREDIT",
  "DIRECT DEBIT",
]);
const PASS2_WINDOW_MS = 48 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface RunSyncOptions {
  db: AppDatabase;
  client: BumbleAkahuClient;
  /** Override the current time. Defaults to () => new Date(). */
  now?: () => Date;
}

export interface SyncCounts {
  transactionsImported: number;
  transfersAutoMarked: number;
  transfersSuggested: number;
  autoCategorized: number;
  residualUncategorized: number;
}

export interface SyncResult extends SyncCounts {
  runId: string;
  status: "ok" | "failed";
  startedAt: string;
  finishedAt: string;
  /** Watermark used as the lower bound for the fetch. */
  fetchedFrom: string;
  error?: string;
}

interface EnrichedTxFields {
  merchantName: string | null;
  akahuCategory: string | null;
  metaOtherAccount: string | null;
}

function extractEnriched(tx: AkahuTransaction): EnrichedTxFields {
  const enriched = tx as Partial<{
    merchant: { name: string };
    category: { name: string };
    meta: { other_account?: string };
  }>;
  return {
    merchantName: enriched.merchant?.name ?? null,
    akahuCategory: enriched.category?.name ?? null,
    metaOtherAccount: enriched.meta?.other_account ?? null,
  };
}

/** Normalised merchant key for rule matching, mirroring spec §2.7. */
export function deriveMerchantKey(
  merchantName: string | null | undefined,
  description: string,
): string {
  if (merchantName && merchantName.trim().length > 0) {
    return merchantName.trim().toUpperCase();
  }
  const words = description.trim().split(/\s+/).slice(0, 2).join(" ");
  return words.toUpperCase();
}

function upsertAccount(
  db: AppDatabase,
  account: Account,
  syncedAt: string,
): void {
  db.insert(accountsTable)
    .values({
      id: account._id,
      name: account.name,
      type: account.type,
      institution: account.connection?.name ?? "Unknown",
      balanceAvailable: account.balance?.available ?? null,
      balanceCurrent: account.balance?.current ?? null,
      currency: account.balance?.currency ?? "NZD",
      rawJson: JSON.stringify(account),
      syncedAt,
    })
    .onConflictDoUpdate({
      target: accountsTable.id,
      set: {
        name: account.name,
        type: account.type,
        institution: account.connection?.name ?? "Unknown",
        balanceAvailable: account.balance?.available ?? null,
        balanceCurrent: account.balance?.current ?? null,
        currency: account.balance?.currency ?? "NZD",
        rawJson: JSON.stringify(account),
        syncedAt,
      },
    })
    .run();
}

interface UpsertTxResult {
  inserted: number;
  rowIds: string[];
}

function upsertTransactions(
  db: AppDatabase,
  txs: AkahuTransaction[],
  syncedAt: string,
): UpsertTxResult {
  if (txs.length === 0) return { inserted: 0, rowIds: [] };

  const existingIds = new Set(
    db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        inArray(
          transactionsTable.id,
          txs.map((t) => t._id),
        ),
      )
      .all()
      .map((r) => r.id),
  );

  let inserted = 0;
  for (const tx of txs) {
    const enriched = extractEnriched(tx);
    db.insert(transactionsTable)
      .values({
        id: tx._id,
        accountId: tx._account,
        date: tx.date,
        description: tx.description,
        amount: tx.amount,
        type: tx.type,
        merchantName: enriched.merchantName,
        akahuCategory: enriched.akahuCategory,
        metaOtherAccount: enriched.metaOtherAccount,
        rawJson: JSON.stringify(tx),
        syncedAt,
      })
      .onConflictDoUpdate({
        target: transactionsTable.id,
        set: {
          accountId: tx._account,
          date: tx.date,
          description: tx.description,
          amount: tx.amount,
          type: tx.type,
          merchantName: enriched.merchantName,
          akahuCategory: enriched.akahuCategory,
          metaOtherAccount: enriched.metaOtherAccount,
          rawJson: JSON.stringify(tx),
          syncedAt,
        },
      })
      .run();
    if (!existingIds.has(tx._id)) inserted += 1;
  }

  return { inserted, rowIds: txs.map((t) => t._id) };
}

function isAlreadyMarkedInternal(db: AppDatabase, txId: string): boolean {
  const debitRow = db
    .select({ id: internalTransfers.id })
    .from(internalTransfers)
    .where(eq(internalTransfers.debitTransactionId, txId))
    .all();
  if (debitRow.length > 0) return true;
  const creditRow = db
    .select({ id: internalTransfers.id })
    .from(internalTransfers)
    .where(eq(internalTransfers.creditTransactionId, txId))
    .all();
  return creditRow.length > 0;
}

function hasPendingSuggestion(db: AppDatabase, txId: string): boolean {
  const rows = db
    .select({ id: internalTransferSuggestions.id })
    .from(internalTransferSuggestions)
    .where(
      sql`(${internalTransferSuggestions.debitTransactionId} = ${txId} OR ${internalTransferSuggestions.creditTransactionId} = ${txId}) AND ${internalTransferSuggestions.status} = 'pending'`,
    )
    .all();
  return rows.length > 0;
}

interface AccountIndex {
  byId: Map<string, Account>;
  byFormatted: Map<string, Account>;
}

function indexAccounts(accs: Account[]): AccountIndex {
  const byId = new Map<string, Account>();
  const byFormatted = new Map<string, Account>();
  for (const acc of accs) {
    byId.set(acc._id, acc);
    if (acc.formatted_account) {
      byFormatted.set(acc.formatted_account, acc);
    }
  }
  return { byId, byFormatted };
}

interface RunPass1Result {
  marked: number;
  matchedTxIds: Set<string>;
}

/**
 * Pass 1 (spec §7): meta.other_account → known formatted_account in our
 * account index. Auto-marks into `internal_transfers`.
 */
function runPass1(
  db: AppDatabase,
  newTxIds: string[],
  accountIndex: AccountIndex,
  now: string,
): RunPass1Result {
  if (newTxIds.length === 0) return { marked: 0, matchedTxIds: new Set() };
  const candidates = db
    .select()
    .from(transactionsTable)
    .where(inArray(transactionsTable.id, newTxIds))
    .all() as DbTransaction[];

  let marked = 0;
  const matchedTxIds = new Set<string>();

  for (const tx of candidates) {
    if (matchedTxIds.has(tx.id)) continue;
    if (!TRANSFER_TYPES.has(tx.type)) continue;
    if (!tx.metaOtherAccount) continue;

    const otherAccount = accountIndex.byFormatted.get(tx.metaOtherAccount);
    if (!otherAccount) continue;
    if (otherAccount._id === tx.accountId) continue;
    if (isAlreadyMarkedInternal(db, tx.id)) continue;

    // Find opposite-sign counterpart in that account.
    const counterpart = db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.accountId, otherAccount._id),
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
      // UNIQUE on debit_transaction_id — already marked, skip silently.
    }
  }

  return { marked, matchedTxIds };
}

/**
 * Pass 2 (spec §7): amount + 48h window. Writes pending rows to
 * `internal_transfer_suggestions` for the user to confirm later.
 */
function runPass2(
  db: AppDatabase,
  newTxIds: string[],
  skipIds: Set<string>,
  now: string,
): number {
  if (newTxIds.length === 0) return 0;
  const candidates = db
    .select()
    .from(transactionsTable)
    .where(inArray(transactionsTable.id, newTxIds))
    .all() as DbTransaction[];

  let suggested = 0;
  const localMatched = new Set<string>();

  for (const tx of candidates) {
    if (skipIds.has(tx.id) || localMatched.has(tx.id)) continue;
    if (!TRANSFER_TYPES.has(tx.type)) continue;
    if (isAlreadyMarkedInternal(db, tx.id)) continue;
    if (hasPendingSuggestion(db, tx.id)) continue;

    // Find candidate counterpart anywhere in DB with opposite sign and 48h window.
    const others = db
      .select()
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.amount, -tx.amount),
          sql`${transactionsTable.accountId} != ${tx.accountId}`,
        ),
      )
      .all() as DbTransaction[];

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
      // UNIQUE(debit, credit) — already a suggestion, skip.
    }
  }

  return suggested;
}

/**
 * Step 3: Apply existing categorization rules to transactions that aren't
 * internal (confirmed or suggested). Case-insensitive prefix match on the
 * normalised merchant key, per spec §2.7.
 */
function applyRules(
  db: AppDatabase,
  newTxIds: string[],
  skipIds: Set<string>,
  now: string,
): number {
  if (newTxIds.length === 0) return 0;
  const candidates = db
    .select()
    .from(transactionsTable)
    .where(inArray(transactionsTable.id, newTxIds))
    .all() as DbTransaction[];

  const rules = db.select().from(categorizationRules).all();
  if (rules.length === 0) return 0;

  // Sort rules longest-pattern-first so more specific patterns win.
  const sortedRules = [...rules].sort(
    (a, b) => b.merchantPattern.length - a.merchantPattern.length,
  );

  let categorized = 0;

  for (const tx of candidates) {
    if (skipIds.has(tx.id)) continue;
    if (isAlreadyMarkedInternal(db, tx.id)) continue;
    if (hasPendingSuggestion(db, tx.id)) continue;

    const existing = db
      .select({ txId: transactionCategories.transactionId })
      .from(transactionCategories)
      .where(eq(transactionCategories.transactionId, tx.id))
      .all();
    if (existing.length > 0) continue;

    const merchantKey = deriveMerchantKey(tx.merchantName, tx.description);
    if (!merchantKey) continue;

    const match = sortedRules.find((rule) =>
      merchantKey.startsWith(rule.merchantPattern.toUpperCase()),
    );
    if (!match) continue;

    const assignment: NewTransactionCategory = {
      transactionId: tx.id,
      categoryId: match.categoryId,
      source: "auto_rule",
      assignedAt: now,
    };
    db.insert(transactionCategories).values(assignment).run();
    db.update(categorizationRules)
      .set({
        matchCount: sql`${categorizationRules.matchCount} + 1`,
        updatedAt: now,
      })
      .where(eq(categorizationRules.id, match.id))
      .run();

    categorized += 1;
  }

  return categorized;
}

function countResidualUncategorized(
  db: AppDatabase,
  newTxIds: string[],
): number {
  if (newTxIds.length === 0) return 0;
  const candidates = db
    .select({ id: transactionsTable.id })
    .from(transactionsTable)
    .where(inArray(transactionsTable.id, newTxIds))
    .all();

  let residual = 0;
  for (const { id } of candidates) {
    if (isAlreadyMarkedInternal(db, id)) continue;
    if (hasPendingSuggestion(db, id)) continue;
    const cat = db
      .select({ id: transactionCategories.transactionId })
      .from(transactionCategories)
      .where(eq(transactionCategories.transactionId, id))
      .all();
    if (cat.length === 0) residual += 1;
  }
  return residual;
}

function readWatermark(db: AppDatabase, now: Date): string {
  const row = db
    .select()
    .from(syncState)
    .where(eq(syncState.key, TRANSACTIONS_STATE_KEY))
    .all();
  if (row.length === 0) {
    return new Date(now.getTime() - ONE_DAY_MS).toISOString();
  }
  return row[0]!.lastSyncedAt;
}

function advanceWatermark(db: AppDatabase, now: string): void {
  db.insert(syncState)
    .values({
      key: TRANSACTIONS_STATE_KEY,
      lastSyncedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: syncState.key,
      set: { lastSyncedAt: now, updatedAt: now },
    })
    .run();
}

export async function runSync(options: RunSyncOptions): Promise<SyncResult> {
  const { db, client } = options;
  const now = options.now ?? (() => new Date());
  const start = now();
  const startedAt = start.toISOString();

  const runId = newSyncRunId();
  db.insert(syncRuns).values({ id: runId, startedAt, status: "running" }).run();

  const watermark = readWatermark(db, start);

  try {
    const accountsList = await client.listAccounts({ force: true });
    for (const acc of accountsList) {
      upsertAccount(db, acc, startedAt);
    }

    const txs = await client.listAllTransactions({ start: watermark });
    const { inserted, rowIds } = upsertTransactions(db, txs, startedAt);

    const accountIndex = indexAccounts(accountsList);
    const pass1 = runPass1(db, rowIds, accountIndex, startedAt);
    const transfersSuggested = runPass2(
      db,
      rowIds,
      pass1.matchedTxIds,
      startedAt,
    );

    const skip = new Set<string>(pass1.matchedTxIds);
    const autoCategorized = applyRules(db, rowIds, skip, startedAt);
    const residualUncategorized = countResidualUncategorized(db, rowIds);

    const finished = now();
    const finishedAt = finished.toISOString();

    advanceWatermark(db, finishedAt);
    db.update(syncRuns)
      .set({
        status: "ok",
        finishedAt,
        transactionsImported: inserted,
        transfersAutoMarked: pass1.marked,
        transfersSuggested,
        autoCategorized,
        residualUncategorized,
      })
      .where(eq(syncRuns.id, runId))
      .run();

    return {
      runId,
      status: "ok",
      startedAt,
      finishedAt,
      fetchedFrom: watermark,
      transactionsImported: inserted,
      transfersAutoMarked: pass1.marked,
      transfersSuggested,
      autoCategorized,
      residualUncategorized,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const finishedAt = now().toISOString();
    db.update(syncRuns)
      .set({ status: "failed", finishedAt, error: message })
      .where(eq(syncRuns.id, runId))
      .run();
    return {
      runId,
      status: "failed",
      startedAt,
      finishedAt,
      fetchedFrom: watermark,
      transactionsImported: 0,
      transfersAutoMarked: 0,
      transfersSuggested: 0,
      autoCategorized: 0,
      residualUncategorized: 0,
      error: message,
    };
  }
}
