import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { BumbleAkahuClient } from "../../src/akahu/client.js";
import { deriveMerchantKey, runSync } from "../../src/akahu/sync.js";
import type { AppDatabase } from "../../src/db/index.js";
import {
  categorizationRules,
  categories,
  internalTransfers,
  internalTransferSuggestions,
  syncRuns,
  syncState,
  transactionCategories,
  transactions as transactionsTable,
} from "../../src/db/schema.js";
import { newCategoryId, newRuleId } from "../../src/lib/ids.js";
import { createTestDatabase, disposeTestDatabase } from "../db/setup.js";
import { createStubAkahu, makeTx } from "../fixtures/akahu.js";

function buildClient(
  stub: ReturnType<typeof createStubAkahu>,
): BumbleAkahuClient {
  return new BumbleAkahuClient({
    credentials: { appToken: "a", userToken: "u" },
    client: stub,
  });
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

describe("runSync", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    disposeTestDatabase(db);
  });

  it("uses today - 1 day as the watermark on first run", async () => {
    const stub = createStubAkahu({ transactionPages: [[]] });
    const client = buildClient(stub);

    const result = await runSync({
      db,
      client,
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });

    expect(result.status).toBe("ok");
    const startQuery = stub.calls.transactions[0]?.start;
    expect(startQuery).toBeDefined();
    // 24h prior to fixed now
    expect(new Date(startQuery!).toISOString()).toBe(
      "2026-05-13T10:00:00.000Z",
    );
  });

  it("upserts accounts and transactions, then advances the watermark", async () => {
    const tx = makeTx({
      id: "trans_a",
      account: "acc_anz_go",
      date: "2026-05-13T12:00:00Z",
      amount: -10,
      type: "DEBIT",
      description: "Countdown",
      merchantName: "COUNTDOWN",
      akahuCategory: "Groceries & Supermarkets",
    });
    const stub = createStubAkahu({ transactionPages: [[tx]] });
    const client = buildClient(stub);

    const result = await runSync({
      db,
      client,
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });

    expect(result.transactionsImported).toBe(1);
    const accs = db.select().from(transactionsTable).all();
    expect(accs).toHaveLength(1);
    expect(accs[0]).toMatchObject({
      id: "trans_a",
      accountId: "acc_anz_go",
      merchantName: "COUNTDOWN",
      akahuCategory: "Groceries & Supermarkets",
    });

    const watermark = db.select().from(syncState).all();
    expect(watermark).toHaveLength(1);
    expect(watermark[0]!.lastSyncedAt).toBe("2026-05-14T10:00:00.000Z");
  });

  it("auto-marks high-confidence Pass-1 internal transfers (meta.other_account match)", async () => {
    const debit = makeTx({
      id: "trans_debit",
      account: "acc_anz_go",
      date: "2026-05-12T10:00:00Z",
      amount: -500,
      type: "TRANSFER",
      description: "Transfer to savings",
      metaOtherAccount: "01-1234-9876543-00", // ANZ Joint Savings
    });
    const credit = makeTx({
      id: "trans_credit",
      account: "acc_anz_savings",
      date: "2026-05-12T10:05:00Z",
      amount: 500,
      type: "TRANSFER",
      description: "Transfer from go",
    });

    const stub = createStubAkahu({ transactionPages: [[debit, credit]] });
    const client = buildClient(stub);

    const result = await runSync({
      db,
      client,
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });

    expect(result.transfersAutoMarked).toBe(1);
    expect(result.residualUncategorized).toBe(0);

    const rows = db.select().from(internalTransfers).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      debitTransactionId: "trans_debit",
      creditTransactionId: "trans_credit",
      detectionMethod: "auto_matched",
    });
  });

  it("falls back to auto_other_account when only one leg is in our DB", async () => {
    const debit = makeTx({
      id: "trans_debit_only",
      account: "acc_anz_go",
      date: "2026-05-12T10:00:00Z",
      amount: -200,
      type: "TRANSFER",
      description: "Pay mortgage",
      metaOtherAccount: "38-9000-0000001-00", // Kiwibank mortgage account
    });
    // No matching credit in Kiwibank (loan accounts often have no transaction feed)

    const stub = createStubAkahu({ transactionPages: [[debit]] });
    const client = buildClient(stub);

    const result = await runSync({
      db,
      client,
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });

    expect(result.transfersAutoMarked).toBe(1);
    const rows = db.select().from(internalTransfers).all();
    expect(rows[0]!.detectionMethod).toBe("auto_other_account");
    expect(rows[0]!.creditTransactionId).toBeNull();
  });

  it("writes Pass-2 amount+window matches to internal_transfer_suggestions as pending", async () => {
    const debit = makeTx({
      id: "p2_debit",
      account: "acc_anz_go",
      date: "2026-05-12T08:00:00Z",
      amount: -200,
      type: "TRANSFER",
      description: "Internal sweep",
    });
    const credit = makeTx({
      id: "p2_credit",
      account: "acc_anz_savings",
      date: "2026-05-12T08:01:00Z",
      amount: 200,
      type: "TRANSFER",
      description: "Internal sweep",
    });

    const stub = createStubAkahu({ transactionPages: [[debit, credit]] });
    const client = buildClient(stub);

    const result = await runSync({
      db,
      client,
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });

    expect(result.transfersAutoMarked).toBe(0);
    expect(result.transfersSuggested).toBe(1);
    const suggestions = db.select().from(internalTransferSuggestions).all();
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      debitTransactionId: "p2_debit",
      creditTransactionId: "p2_credit",
      detectionMethod: "amount_window",
      confidence: "medium",
      status: "pending",
    });
    expect(db.select().from(internalTransfers).all()).toHaveLength(0);
  });

  it("does not match Pass-2 pairs outside the 48h window", async () => {
    const a = makeTx({
      id: "far_a",
      account: "acc_anz_go",
      date: "2026-05-01T00:00:00Z",
      amount: -100,
      type: "TRANSFER",
      description: "x",
    });
    const b = makeTx({
      id: "far_b",
      account: "acc_anz_savings",
      date: "2026-05-05T00:00:00Z", // 4 days later — outside window
      amount: 100,
      type: "TRANSFER",
      description: "x",
    });
    const stub = createStubAkahu({ transactionPages: [[a, b]] });
    const result = await runSync({
      db,
      client: buildClient(stub),
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });
    expect(result.transfersAutoMarked).toBe(0);
    expect(result.transfersSuggested).toBe(0);
  });

  it("skips non-transfer types in Pass-2 even with matching amounts", async () => {
    const a = makeTx({
      id: "card_a",
      account: "acc_anz_go",
      date: "2026-05-12T00:00:00Z",
      amount: -50,
      type: "EFTPOS",
      description: "Cafe",
    });
    const b = makeTx({
      id: "card_b",
      account: "acc_anz_savings",
      date: "2026-05-12T00:00:00Z",
      amount: 50,
      type: "EFTPOS",
      description: "Refund",
    });
    const stub = createStubAkahu({ transactionPages: [[a, b]] });
    const result = await runSync({
      db,
      client: buildClient(stub),
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });
    expect(result.transfersSuggested).toBe(0);
  });

  it("auto-categorises transactions matching an existing rule", async () => {
    const catId = newCategoryId();
    db.insert(categories)
      .values({
        id: catId,
        name: "Groceries & Supermarkets",
        createdAt: "2026-05-10T00:00:00Z",
      })
      .run();
    db.insert(categorizationRules)
      .values({
        id: newRuleId(),
        merchantPattern: "COUNTDOWN",
        categoryId: catId,
        createdAt: "2026-05-10T00:00:00Z",
        updatedAt: "2026-05-10T00:00:00Z",
      })
      .run();

    const tx = makeTx({
      id: "trans_count",
      account: "acc_anz_go",
      date: "2026-05-12T12:00:00Z",
      amount: -42.5,
      type: "EFTPOS",
      description: "COUNTDOWN RICCARTON",
      merchantName: "COUNTDOWN RICCARTON",
    });

    const stub = createStubAkahu({ transactionPages: [[tx]] });
    const client = buildClient(stub);
    const result = await runSync({
      db,
      client,
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });

    expect(result.autoCategorized).toBe(1);
    expect(result.residualUncategorized).toBe(0);
    const tcRows = db
      .select()
      .from(transactionCategories)
      .where(eq(transactionCategories.transactionId, "trans_count"))
      .all();
    expect(tcRows[0]).toMatchObject({ categoryId: catId, source: "auto_rule" });

    const updatedRule = db.select().from(categorizationRules).all();
    expect(updatedRule[0]!.matchCount).toBe(1);
  });

  it("counts residual uncategorised when no rule matches and no transfer detected", async () => {
    const tx = makeTx({
      id: "trans_solo",
      account: "acc_anz_go",
      date: "2026-05-12T12:00:00Z",
      amount: -42,
      type: "EFTPOS",
      description: "NEW MERCHANT",
      merchantName: "NEW MERCHANT",
    });
    const stub = createStubAkahu({ transactionPages: [[tx]] });
    const result = await runSync({
      db,
      client: buildClient(stub),
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });
    expect(result.autoCategorized).toBe(0);
    expect(result.residualUncategorized).toBe(1);
  });

  it("does not advance the watermark when the Akahu call fails", async () => {
    const stub = createStubAkahu();
    stub.transactions.list = async () => {
      throw new Error("akahu 503");
    };
    const client = buildClient(stub);

    const result = await runSync({
      db,
      client,
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("akahu 503");
    expect(db.select().from(syncState).all()).toHaveLength(0);
    const runs = db.select().from(syncRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed" });
    expect(runs[0]!.error).toContain("akahu 503");
  });

  it("is idempotent — re-running the same sync does not duplicate marks or categorisations", async () => {
    const debit = makeTx({
      id: "dup_debit",
      account: "acc_anz_go",
      date: "2026-05-12T10:00:00Z",
      amount: -500,
      type: "TRANSFER",
      description: "to savings",
      metaOtherAccount: "01-1234-9876543-00",
    });
    const credit = makeTx({
      id: "dup_credit",
      account: "acc_anz_savings",
      date: "2026-05-12T10:05:00Z",
      amount: 500,
      type: "TRANSFER",
      description: "from go",
    });
    const stub = createStubAkahu({ transactionPages: [[debit, credit]] });
    const client = buildClient(stub);

    await runSync({
      db,
      client,
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });
    // Reset stub pages to return the same batch again.
    const stub2 = createStubAkahu({ transactionPages: [[debit, credit]] });
    const client2 = buildClient(stub2);
    const second = await runSync({
      db,
      client: client2,
      now: fixedClock("2026-05-14T11:00:00.000Z"),
    });

    expect(second.status).toBe("ok");
    expect(db.select().from(internalTransfers).all()).toHaveLength(1);
    expect(db.select().from(transactionsTable).all()).toHaveLength(2);
  });

  it("writes a sync_runs row per invocation with counts and ok status", async () => {
    const stub = createStubAkahu({ transactionPages: [[]] });
    const client = buildClient(stub);
    const result = await runSync({
      db,
      client,
      now: fixedClock("2026-05-14T10:00:00.000Z"),
    });
    const runs = db.select().from(syncRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: result.runId,
      status: "ok",
      transactionsImported: 0,
      transfersAutoMarked: 0,
      transfersSuggested: 0,
      autoCategorized: 0,
      residualUncategorized: 0,
    });
    expect(runs[0]!.finishedAt).toBe("2026-05-14T10:00:00.000Z");
  });
});

describe("deriveMerchantKey", () => {
  it("uppercases the merchant name when present", () => {
    expect(deriveMerchantKey("Countdown Riccarton", "x")).toBe(
      "COUNTDOWN RICCARTON",
    );
  });

  it("falls back to the first two words of description when merchant missing", () => {
    expect(deriveMerchantKey(null, "z energy lincoln rd")).toBe("Z ENERGY");
  });

  it("returns the entire description when only one word", () => {
    expect(deriveMerchantKey(undefined, "fees")).toBe("FEES");
  });
});
