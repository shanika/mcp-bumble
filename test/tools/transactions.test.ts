import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase } from "../../src/db/index.js";
import {
  accounts as accountsTable,
  internalTransfers,
  syncRuns,
  transactionCategories,
  categories as categoriesTable,
  transactions as transactionsTable,
} from "../../src/db/schema.js";
import {
  listTransactions,
  listUncategorized,
  searchTransactions,
} from "../../src/tools/transactions.js";
import { createTestDatabase, disposeTestDatabase } from "../db/setup.js";

const SYNCED_AT = "2026-05-14T02:00:00.000Z";

interface SeedTx {
  id: string;
  accountId: string;
  date: string;
  description: string;
  amount: number;
  type?: string;
  merchantName?: string | null;
  akahuCategory?: string | null;
  metaOtherAccount?: string | null;
}

function seedAccount(db: AppDatabase, id: string, name = id): void {
  db.insert(accountsTable)
    .values({
      id,
      name,
      type: "CHECKING",
      institution: "ANZ",
      balanceAvailable: 0,
      balanceCurrent: 0,
      currency: "NZD",
      syncedAt: SYNCED_AT,
    })
    .run();
}

function seedTx(db: AppDatabase, tx: SeedTx): void {
  db.insert(transactionsTable)
    .values({
      id: tx.id,
      accountId: tx.accountId,
      date: tx.date,
      description: tx.description,
      amount: tx.amount,
      type: tx.type ?? "DEBIT",
      merchantName: tx.merchantName ?? null,
      akahuCategory: tx.akahuCategory ?? null,
      metaOtherAccount: tx.metaOtherAccount ?? null,
      syncedAt: SYNCED_AT,
    })
    .run();
}

function seedCategoryAssignment(
  db: AppDatabase,
  transactionId: string,
  categoryName = "Groceries",
): void {
  const catId = `cat_${categoryName.toLowerCase()}`;
  const existing = db
    .select({ id: categoriesTable.id })
    .from(categoriesTable)
    .all();
  if (!existing.some((r) => r.id === catId)) {
    db.insert(categoriesTable)
      .values({
        id: catId,
        name: categoryName,
        source: "user",
        createdAt: SYNCED_AT,
      })
      .run();
  }
  db.insert(transactionCategories)
    .values({
      transactionId,
      categoryId: catId,
      source: "user_override",
      assignedAt: SYNCED_AT,
    })
    .run();
}

function markInternalTransfer(
  db: AppDatabase,
  debitId: string,
  creditId: string | null = null,
): void {
  db.insert(internalTransfers)
    .values({
      id: `xfer_${debitId}`,
      debitTransactionId: debitId,
      creditTransactionId: creditId,
      detectionMethod: "auto_matched",
      markedAt: SYNCED_AT,
    })
    .run();
}

function seedFiveTransactions(db: AppDatabase): void {
  seedAccount(db, "acc_a");
  seedAccount(db, "acc_b");
  seedTx(db, {
    id: "tx_1",
    accountId: "acc_a",
    date: "2026-05-01",
    description: "COUNTDOWN RICCARTON",
    amount: -42.5,
    merchantName: "COUNTDOWN",
    akahuCategory: "Groceries & Supermarkets",
  });
  seedTx(db, {
    id: "tx_2",
    accountId: "acc_a",
    date: "2026-05-03",
    description: "Z ENERGY GLEN INNES",
    amount: -68.0,
    merchantName: "Z ENERGY",
    akahuCategory: "Vehicles & Transport",
  });
  seedTx(db, {
    id: "tx_3",
    accountId: "acc_b",
    date: "2026-05-05",
    description: "MERCURY NZ DD",
    amount: -185.42,
    merchantName: "MERCURY NZ",
    akahuCategory: "Utilities",
  });
  seedTx(db, {
    id: "tx_4",
    accountId: "acc_a",
    date: "2026-05-07",
    description: "LITTLE BIRD ORGANICS",
    amount: -42.5,
    merchantName: "LITTLE BIRD",
    akahuCategory: "Groceries & Supermarkets",
  });
  seedTx(db, {
    id: "tx_5",
    accountId: "acc_b",
    date: "2026-05-07",
    description: "NOEL LEEMING HENDERSON",
    amount: -189.0,
    merchantName: "NOEL LEEMING",
    akahuCategory: "Electronics & Appliances",
  });
}

describe("listTransactions", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });
  afterEach(() => {
    disposeTestDatabase(db);
  });

  it("returns an empty page when no transactions exist", () => {
    expect(listTransactions(db)).toEqual({ transactions: [] });
  });

  it("returns rows newest-first with no nextCursor when below limit", () => {
    seedFiveTransactions(db);
    const result = listTransactions(db, { limit: 10 });
    expect(result.nextCursor).toBeUndefined();
    expect(result.transactions.map((t) => t.id)).toEqual([
      "tx_5",
      "tx_4",
      "tx_3",
      "tx_2",
      "tx_1",
    ]);
    expect(result.transactions[0]).toMatchObject({
      id: "tx_5",
      accountId: "acc_b",
      date: "2026-05-07",
      description: "NOEL LEEMING HENDERSON",
      amount: -189,
      merchantName: "NOEL LEEMING",
      akahuCategory: "Electronics & Appliances",
    });
  });

  it("filters by accountId", () => {
    seedFiveTransactions(db);
    const result = listTransactions(db, { accountId: "acc_b" });
    expect(result.transactions.map((t) => t.id)).toEqual(["tx_5", "tx_3"]);
  });

  it("filters by start/end (inclusive)", () => {
    seedFiveTransactions(db);
    const result = listTransactions(db, {
      start: "2026-05-03",
      end: "2026-05-05",
    });
    expect(result.transactions.map((t) => t.id)).toEqual(["tx_3", "tx_2"]);
  });

  it("paginates with a cursor that walks all rows exactly once", () => {
    seedFiveTransactions(db);
    const page1 = listTransactions(db, { limit: 2 });
    expect(page1.transactions.map((t) => t.id)).toEqual(["tx_5", "tx_4"]);
    expect(page1.nextCursor).toBeDefined();

    const page2 = listTransactions(db, { limit: 2, cursor: page1.nextCursor });
    expect(page2.transactions.map((t) => t.id)).toEqual(["tx_3", "tx_2"]);
    expect(page2.nextCursor).toBeDefined();

    const page3 = listTransactions(db, { limit: 2, cursor: page2.nextCursor });
    expect(page3.transactions.map((t) => t.id)).toEqual(["tx_1"]);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("disambiguates same-date rows by id in the cursor", () => {
    seedFiveTransactions(db);
    const page1 = listTransactions(db, { limit: 1 });
    expect(page1.transactions.map((t) => t.id)).toEqual(["tx_5"]);

    const page2 = listTransactions(db, { limit: 1, cursor: page1.nextCursor });
    expect(page2.transactions.map((t) => t.id)).toEqual(["tx_4"]);
  });

  it("treats an unparseable cursor as no cursor", () => {
    seedFiveTransactions(db);
    const result = listTransactions(db, { cursor: "not-a-cursor" });
    expect(result.transactions).toHaveLength(5);
  });

  it("clamps non-positive or non-finite limits to the default", () => {
    seedFiveTransactions(db);
    const zero = listTransactions(db, { limit: 0 });
    const negative = listTransactions(db, { limit: -3 });
    const nan = listTransactions(db, { limit: Number.NaN });
    expect(zero.transactions).toHaveLength(5);
    expect(negative.transactions).toHaveLength(5);
    expect(nan.transactions).toHaveLength(5);
  });

  it("caps very large limits", () => {
    seedFiveTransactions(db);
    const result = listTransactions(db, { limit: 1_000_000 });
    expect(result.transactions).toHaveLength(5);
    expect(result.nextCursor).toBeUndefined();
  });
});

describe("searchTransactions", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });
  afterEach(() => {
    disposeTestDatabase(db);
  });

  it("returns an empty array when no transactions match", () => {
    seedFiveTransactions(db);
    expect(searchTransactions(db, { query: "WESTPAC" })).toEqual({
      transactions: [],
    });
  });

  it("matches case-insensitively against description", () => {
    seedFiveTransactions(db);
    const result = searchTransactions(db, { query: "henderson" });
    expect(result.transactions.map((t) => t.id)).toEqual(["tx_5"]);
  });

  it("matches against merchantName as well as description", () => {
    seedFiveTransactions(db);
    seedTx(db, {
      id: "tx_merchant_only",
      accountId: "acc_a",
      date: "2026-04-30",
      description: "POS PURCHASE",
      amount: -10,
      merchantName: "COUNTDOWN ONLINE",
    });
    const result = searchTransactions(db, { query: "countdown" });
    expect(result.transactions.map((t) => t.id).sort()).toEqual([
      "tx_1",
      "tx_merchant_only",
    ]);
  });

  it("respects start/end date bounds", () => {
    seedFiveTransactions(db);
    const result = searchTransactions(db, {
      query: "z energy",
      start: "2026-05-04",
      end: "2026-05-10",
    });
    expect(result.transactions).toHaveLength(0);
  });

  it("returns an empty array for an empty or whitespace query", () => {
    seedFiveTransactions(db);
    expect(searchTransactions(db, { query: "" })).toEqual({ transactions: [] });
    expect(searchTransactions(db, { query: "   " })).toEqual({
      transactions: [],
    });
  });

  it("does not let LIKE metacharacters in the query bypass intent", () => {
    seedFiveTransactions(db);
    // `%` and `_` should be treated as literals, not wildcards.
    expect(searchTransactions(db, { query: "%" }).transactions).toEqual([]);
    expect(searchTransactions(db, { query: "_" }).transactions).toEqual([]);
  });

  it("orders results newest-first and honours limit", () => {
    seedFiveTransactions(db);
    seedTx(db, {
      id: "tx_old_countdown",
      accountId: "acc_a",
      date: "2026-04-10",
      description: "COUNTDOWN MOORHOUSE",
      amount: -55,
      merchantName: "COUNTDOWN",
    });
    const result = searchTransactions(db, { query: "countdown", limit: 1 });
    expect(result.transactions.map((t) => t.id)).toEqual(["tx_1"]);
  });
});

describe("listUncategorized", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });
  afterEach(() => {
    disposeTestDatabase(db);
  });

  it("returns an empty result when no transactions exist", () => {
    expect(listUncategorized(db)).toEqual({ transactions: [] });
  });

  it("excludes categorized transactions and internal transfers", () => {
    seedFiveTransactions(db);
    // tx_1 is categorised → must be excluded.
    seedCategoryAssignment(db, "tx_1");
    // tx_3 is auto-marked as an internal transfer (debit leg) → excluded.
    seedTx(db, {
      id: "tx_3_pair",
      accountId: "acc_a",
      date: "2026-05-05",
      description: "TRANSFER IN",
      amount: 185.42,
      type: "TRANSFER",
    });
    markInternalTransfer(db, "tx_3", "tx_3_pair");

    const result = listUncategorized(db, { limit: 50 });
    const ids = result.transactions.map((t) => t.id);
    expect(ids).not.toContain("tx_1");
    expect(ids).not.toContain("tx_3");
    expect(ids).not.toContain("tx_3_pair"); // credit leg of the transfer
    expect(ids.sort()).toEqual(["tx_2", "tx_4", "tx_5"]);
  });

  it("surfaces akahu_category in each row so the LLM can propose it", () => {
    seedFiveTransactions(db);
    const result = listUncategorized(db);
    const tx4 = result.transactions.find((t) => t.id === "tx_4");
    expect(tx4?.akahuCategory).toBe("Groceries & Supermarkets");
  });

  it("excludes a transaction marked as the credit leg only", () => {
    seedAccount(db, "acc_a");
    seedAccount(db, "acc_b");
    seedTx(db, {
      id: "debit_only",
      accountId: "acc_a",
      date: "2026-05-01",
      description: "TRANSFER OUT",
      amount: -500,
      type: "TRANSFER",
    });
    seedTx(db, {
      id: "credit_only",
      accountId: "acc_b",
      date: "2026-05-01",
      description: "TRANSFER IN",
      amount: 500,
      type: "TRANSFER",
    });
    markInternalTransfer(db, "debit_only", "credit_only");
    expect(listUncategorized(db).transactions).toEqual([]);
  });

  it("filters by start/end (inclusive)", () => {
    seedFiveTransactions(db);
    const result = listUncategorized(db, {
      start: "2026-05-03",
      end: "2026-05-05",
    });
    expect(result.transactions.map((t) => t.id).sort()).toEqual([
      "tx_2",
      "tx_3",
    ]);
  });

  it("paginates with a cursor", () => {
    seedFiveTransactions(db);
    const page1 = listUncategorized(db, { limit: 2 });
    expect(page1.transactions.map((t) => t.id)).toEqual(["tx_5", "tx_4"]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = listUncategorized(db, { limit: 2, cursor: page1.nextCursor });
    expect(page2.transactions.map((t) => t.id)).toEqual(["tx_3", "tx_2"]);
    const page3 = listUncategorized(db, { limit: 2, cursor: page2.nextCursor });
    expect(page3.transactions.map((t) => t.id)).toEqual(["tx_1"]);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("emits no warning when there are no sync runs", () => {
    seedFiveTransactions(db);
    expect(listUncategorized(db).warning).toBeUndefined();
  });

  it("emits no warning when the latest run is ok and recent", () => {
    seedFiveTransactions(db);
    const now = new Date("2026-05-14T03:00:00.000Z");
    db.insert(syncRuns)
      .values({
        id: "run_ok",
        startedAt: "2026-05-14T02:00:00.000Z",
        finishedAt: "2026-05-14T02:01:00.000Z",
        status: "ok",
      })
      .run();
    expect(listUncategorized(db, {}, () => now).warning).toBeUndefined();
  });

  it("emits a failure warning when the latest run failed (including the error)", () => {
    seedFiveTransactions(db);
    db.insert(syncRuns)
      .values({
        id: "run_failed",
        startedAt: "2026-05-14T02:00:00.000Z",
        status: "failed",
        error: "Akahu 502 Bad Gateway",
      })
      .run();
    const result = listUncategorized(
      db,
      {},
      () => new Date("2026-05-14T03:00:00.000Z"),
    );
    expect(result.warning).toContain("failed");
    expect(result.warning).toContain("Akahu 502 Bad Gateway");
  });

  it("emits a stale warning when the latest ok run is >30h old", () => {
    seedFiveTransactions(db);
    db.insert(syncRuns)
      .values({
        id: "run_old",
        startedAt: "2026-05-12T02:00:00.000Z",
        finishedAt: "2026-05-12T02:01:00.000Z",
        status: "ok",
      })
      .run();
    const result = listUncategorized(
      db,
      {},
      () => new Date("2026-05-14T03:00:00.000Z"),
    );
    expect(result.warning).toMatch(/^Last sync was \d+h ago/);
  });

  it("falls back to a no-detail message when a failed run has no error string", () => {
    seedFiveTransactions(db);
    db.insert(syncRuns)
      .values({
        id: "run_failed_blank",
        startedAt: "2026-05-14T02:00:00.000Z",
        status: "failed",
        error: "   ",
      })
      .run();
    const result = listUncategorized(
      db,
      {},
      () => new Date("2026-05-14T03:00:00.000Z"),
    );
    expect(result.warning).toBe("Last sync (2026-05-14T02:00:00.000Z) failed.");
  });

  it("uses the most recent run (not any run) when deciding to warn", () => {
    seedFiveTransactions(db);
    db.insert(syncRuns)
      .values([
        {
          id: "run_old_fail",
          startedAt: "2026-05-10T02:00:00.000Z",
          status: "failed",
          error: "old failure",
        },
        {
          id: "run_recent_ok",
          startedAt: "2026-05-14T02:00:00.000Z",
          finishedAt: "2026-05-14T02:01:00.000Z",
          status: "ok",
        },
      ])
      .run();
    const result = listUncategorized(
      db,
      {},
      () => new Date("2026-05-14T03:00:00.000Z"),
    );
    expect(result.warning).toBeUndefined();
  });
});
