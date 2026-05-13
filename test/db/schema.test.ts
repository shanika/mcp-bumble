import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  newCategoryId,
  newRuleId,
  newSuggestionId,
  newSyncRunId,
  newTransferId,
} from "../../src/lib/ids.js";
import { schema, type AppDatabase } from "../../src/db/index.js";
import { createTestDatabase, disposeTestDatabase } from "./setup.js";

const NOW = "2026-05-14T00:00:00.000Z";

describe("schema migrations", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    disposeTestDatabase(db);
  });

  it("creates all 9 tables", () => {
    const rows = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
      )
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toEqual([
      "accounts",
      "categories",
      "categorization_rules",
      "internal_transfer_suggestions",
      "internal_transfers",
      "sync_runs",
      "sync_state",
      "transaction_categories",
      "transactions",
    ]);
  });

  it("creates all spec indexes from §5", () => {
    const rows = db.$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name",
      )
      .all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual([
      "idx_categorization_rules_merchant",
      "idx_sync_runs_started",
      "idx_transaction_categories_category",
      "idx_transactions_account",
      "idx_transactions_akahu_cat",
      "idx_transactions_date",
      "idx_transactions_type",
      "idx_transfer_suggestions_status",
    ]);
  });

  it("enforces foreign keys (transactions → accounts)", () => {
    expect(() =>
      db
        .insert(schema.transactions)
        .values({
          id: "trans_orphan",
          accountId: "acc_missing",
          date: NOW,
          description: "x",
          amount: -1,
          type: "DEBIT",
          syncedAt: NOW,
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("supports CRUD on accounts", () => {
    db.insert(schema.accounts)
      .values({
        id: "acc_1",
        name: "Checking",
        type: "CHECKING",
        institution: "ANZ",
        balanceAvailable: 100,
        balanceCurrent: 150,
        syncedAt: NOW,
      })
      .run();

    const all = db.select().from(schema.accounts).all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: "acc_1",
      currency: "NZD",
      balanceAvailable: 100,
    });
  });

  it("supports CRUD on transactions with index hits", () => {
    db.insert(schema.accounts)
      .values({
        id: "acc_1",
        name: "A",
        type: "CHECKING",
        institution: "ANZ",
        syncedAt: NOW,
      })
      .run();

    db.insert(schema.transactions)
      .values([
        {
          id: "trans_1",
          accountId: "acc_1",
          date: "2026-05-01",
          description: "Countdown",
          amount: -42.5,
          type: "DEBIT",
          merchantName: "COUNTDOWN",
          akahuCategory: "Groceries",
          syncedAt: NOW,
        },
        {
          id: "trans_2",
          accountId: "acc_1",
          date: "2026-05-02",
          description: "Pay",
          amount: 1000,
          type: "CREDIT",
          syncedAt: NOW,
        },
      ])
      .run();

    const byDate = db
      .select()
      .from(schema.transactions)
      .where(sql`${schema.transactions.date} >= '2026-05-02'`)
      .all();
    expect(byDate).toHaveLength(1);
    expect(byDate[0]!.id).toBe("trans_2");
  });

  it("supports CRUD on categories with unique name", () => {
    db.insert(schema.categories)
      .values({ id: newCategoryId(), name: "Groceries", createdAt: NOW })
      .run();

    expect(() =>
      db
        .insert(schema.categories)
        .values({ id: newCategoryId(), name: "Groceries", createdAt: NOW })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("supports CRUD on transaction_categories (one per transaction)", () => {
    const catId = newCategoryId();
    db.insert(schema.accounts)
      .values({
        id: "acc_1",
        name: "A",
        type: "CHECKING",
        institution: "ANZ",
        syncedAt: NOW,
      })
      .run();
    db.insert(schema.transactions)
      .values({
        id: "trans_1",
        accountId: "acc_1",
        date: NOW,
        description: "x",
        amount: -1,
        type: "DEBIT",
        syncedAt: NOW,
      })
      .run();
    db.insert(schema.categories)
      .values({ id: catId, name: "Cat", createdAt: NOW })
      .run();
    db.insert(schema.transactionCategories)
      .values({
        transactionId: "trans_1",
        categoryId: catId,
        source: "user_override",
        assignedAt: NOW,
      })
      .run();

    expect(() =>
      db
        .insert(schema.transactionCategories)
        .values({
          transactionId: "trans_1",
          categoryId: catId,
          source: "user_override",
          assignedAt: NOW,
        })
        .run(),
    ).toThrow(/PRIMARY KEY|UNIQUE/i);
  });

  it("supports CRUD on categorization_rules with unique merchant_pattern", () => {
    const catId = newCategoryId();
    db.insert(schema.categories)
      .values({ id: catId, name: "Cat", createdAt: NOW })
      .run();

    db.insert(schema.categorizationRules)
      .values({
        id: newRuleId(),
        merchantPattern: "COUNTDOWN",
        categoryId: catId,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();

    expect(() =>
      db
        .insert(schema.categorizationRules)
        .values({
          id: newRuleId(),
          merchantPattern: "COUNTDOWN",
          categoryId: catId,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("supports CRUD on internal_transfers with unique debit", () => {
    db.insert(schema.accounts)
      .values({
        id: "acc_1",
        name: "A",
        type: "CHECKING",
        institution: "ANZ",
        syncedAt: NOW,
      })
      .run();
    db.insert(schema.transactions)
      .values({
        id: "trans_d",
        accountId: "acc_1",
        date: NOW,
        description: "x",
        amount: -100,
        type: "TRANSFER",
        syncedAt: NOW,
      })
      .run();

    db.insert(schema.internalTransfers)
      .values({
        id: newTransferId(),
        debitTransactionId: "trans_d",
        detectionMethod: "manual",
        markedAt: NOW,
      })
      .run();

    expect(() =>
      db
        .insert(schema.internalTransfers)
        .values({
          id: newTransferId(),
          debitTransactionId: "trans_d",
          detectionMethod: "manual",
          markedAt: NOW,
        })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("supports CRUD on internal_transfer_suggestions with pair uniqueness", () => {
    db.insert(schema.accounts)
      .values({
        id: "acc_1",
        name: "A",
        type: "CHECKING",
        institution: "ANZ",
        syncedAt: NOW,
      })
      .run();
    db.insert(schema.transactions)
      .values([
        {
          id: "trans_d",
          accountId: "acc_1",
          date: NOW,
          description: "x",
          amount: -100,
          type: "TRANSFER",
          syncedAt: NOW,
        },
        {
          id: "trans_c",
          accountId: "acc_1",
          date: NOW,
          description: "y",
          amount: 100,
          type: "TRANSFER",
          syncedAt: NOW,
        },
      ])
      .run();

    db.insert(schema.internalTransferSuggestions)
      .values({
        id: newSuggestionId(),
        debitTransactionId: "trans_d",
        creditTransactionId: "trans_c",
        detectionMethod: "amount_window",
        confidence: "medium",
        suggestedAt: NOW,
      })
      .run();

    const rows = db.select().from(schema.internalTransferSuggestions).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");

    expect(() =>
      db
        .insert(schema.internalTransferSuggestions)
        .values({
          id: newSuggestionId(),
          debitTransactionId: "trans_d",
          creditTransactionId: "trans_c",
          detectionMethod: "amount_window",
          confidence: "medium",
          suggestedAt: NOW,
        })
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it("supports CRUD on sync_state", () => {
    db.insert(schema.syncState)
      .values({ key: "transactions", lastSyncedAt: NOW, updatedAt: NOW })
      .run();
    const rows = db.select().from(schema.syncState).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("transactions");
  });

  it("supports CRUD on sync_runs with default counters", () => {
    db.insert(schema.syncRuns)
      .values({ id: newSyncRunId(), startedAt: NOW, status: "ok" })
      .run();
    const rows = db.select().from(schema.syncRuns).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "ok",
      transactionsImported: 0,
      transfersAutoMarked: 0,
      transfersSuggested: 0,
      autoCategorized: 0,
      residualUncategorized: 0,
    });
  });
});
