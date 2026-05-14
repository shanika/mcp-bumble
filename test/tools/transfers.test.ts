import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase } from "../../src/db/index.js";
import {
  accounts as accountsTable,
  internalTransfers,
  internalTransferSuggestions,
  transactions as transactionsTable,
} from "../../src/db/schema.js";
import {
  detectInternalTransfers,
  listInternalTransfers,
  markInternalTransfer,
  unmarkInternalTransfer,
} from "../../src/tools/transfers.js";
import { createTestDatabase, disposeTestDatabase } from "../db/setup.js";

const NOW = new Date("2026-05-14T10:00:00.000Z");
const now = (): Date => NOW;

const ACC_GO = "acc_anz_go";
const ACC_SAV = "acc_anz_savings";
const FMT_GO = "01-1234-1234567-00";
const FMT_SAV = "01-1234-9876543-00";

function seedAccounts(db: AppDatabase): void {
  for (const [id, fmt] of [
    [ACC_GO, FMT_GO],
    [ACC_SAV, FMT_SAV],
  ] as const) {
    db.insert(accountsTable)
      .values({
        id,
        name: id,
        type: "CHECKING",
        institution: "ANZ",
        rawJson: JSON.stringify({ _id: id, formatted_account: fmt }),
        syncedAt: NOW.toISOString(),
      })
      .run();
  }
}

interface SeedTxOpts {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  type?: string;
  metaOtherAccount?: string | null;
}

function seedTx(db: AppDatabase, opts: SeedTxOpts): void {
  db.insert(transactionsTable)
    .values({
      id: opts.id,
      accountId: opts.accountId,
      date: opts.date,
      description: opts.id,
      amount: opts.amount,
      type: opts.type ?? "TRANSFER",
      merchantName: null,
      akahuCategory: null,
      metaOtherAccount: opts.metaOtherAccount ?? null,
      rawJson: null,
      syncedAt: NOW.toISOString(),
    })
    .run();
}

describe("detectInternalTransfers", () => {
  let db: AppDatabase;
  beforeEach(() => {
    db = createTestDatabase();
    seedAccounts(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("returns an empty list when nothing is pending and no range is given", () => {
    expect(detectInternalTransfers(db, {}, now)).toEqual({ pairs: [] });
  });

  it("surfaces pending Pass-2 suggestions newest-first", () => {
    seedTx(db, {
      id: "d1",
      accountId: ACC_GO,
      date: "2026-05-05",
      amount: -100,
    });
    seedTx(db, {
      id: "c1",
      accountId: ACC_SAV,
      date: "2026-05-05",
      amount: 100,
    });
    seedTx(db, {
      id: "d2",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -300,
    });
    seedTx(db, {
      id: "c2",
      accountId: ACC_SAV,
      date: "2026-05-10",
      amount: 300,
    });

    db.insert(internalTransferSuggestions)
      .values([
        {
          id: "sugg_old",
          debitTransactionId: "d1",
          creditTransactionId: "c1",
          detectionMethod: "amount_window",
          confidence: "medium",
          suggestedAt: "2026-05-06T00:00:00Z",
          status: "pending",
        },
        {
          id: "sugg_new",
          debitTransactionId: "d2",
          creditTransactionId: "c2",
          detectionMethod: "amount_window",
          confidence: "medium",
          suggestedAt: "2026-05-11T00:00:00Z",
          status: "pending",
        },
      ])
      .run();

    const { pairs } = detectInternalTransfers(db, {}, now);
    expect(pairs.map((p) => p.pairId)).toEqual(["sugg_new", "sugg_old"]);
    expect(pairs[0]).toMatchObject({
      pairId: "sugg_new",
      debitTransactionId: "d2",
      creditTransactionId: "c2",
      detectionMethod: "amount_window",
      confidence: "medium",
      status: "pending",
      debitDate: "2026-05-10",
      creditDate: "2026-05-10",
      amount: 300,
    });
  });

  it("re-runs the heuristic over a date range and surfaces newly-suggested Pass-2 pairs", () => {
    seedTx(db, {
      id: "d",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -77,
    });
    seedTx(db, {
      id: "c",
      accountId: ACC_SAV,
      date: "2026-05-10",
      amount: 77,
    });

    const before = db.select().from(internalTransferSuggestions).all();
    expect(before).toHaveLength(0);

    const { pairs } = detectInternalTransfers(
      db,
      { start: "2026-05-01", end: "2026-05-20" },
      now,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      debitTransactionId: "d",
      creditTransactionId: "c",
      detectionMethod: "amount_window",
      status: "pending",
      amount: 77,
    });
    expect(db.select().from(internalTransferSuggestions).all()).toHaveLength(1);
  });

  it("auto-marks Pass-1 matches on re-run without including them in the returned pending list", () => {
    seedTx(db, {
      id: "d",
      accountId: ACC_GO,
      date: "2026-05-10T10:00:00Z",
      amount: -500,
      metaOtherAccount: FMT_SAV,
    });
    seedTx(db, {
      id: "c",
      accountId: ACC_SAV,
      date: "2026-05-10T10:05:00Z",
      amount: 500,
    });

    const { pairs } = detectInternalTransfers(
      db,
      { start: "2026-05-09", end: "2026-05-11" },
      now,
    );
    expect(pairs).toHaveLength(0);
    const marked = db.select().from(internalTransfers).all();
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({
      debitTransactionId: "d",
      creditTransactionId: "c",
      detectionMethod: "auto_matched",
    });
  });

  it("filters pending suggestions by suggestedAt when start/end provided", () => {
    seedTx(db, {
      id: "d_old",
      accountId: ACC_GO,
      date: "2026-04-01",
      amount: -10,
    });
    seedTx(db, {
      id: "c_old",
      accountId: ACC_SAV,
      date: "2026-04-01",
      amount: 10,
    });

    db.insert(internalTransferSuggestions)
      .values({
        id: "old",
        debitTransactionId: "d_old",
        creditTransactionId: "c_old",
        detectionMethod: "amount_window",
        confidence: "medium",
        suggestedAt: "2026-04-02T00:00:00Z",
        status: "pending",
      })
      .run();

    const { pairs } = detectInternalTransfers(
      db,
      { start: "2026-05-01", end: "2026-05-31" },
      now,
    );
    expect(pairs).toHaveLength(0);
  });
});

describe("markInternalTransfer", () => {
  let db: AppDatabase;
  beforeEach(() => {
    db = createTestDatabase();
    seedAccounts(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("requires at least one of transferPairs or transactionIds", () => {
    expect(() => markInternalTransfer(db, {}, now)).toThrow(/requires/);
  });

  it("confirms pending suggestions: inserts internal_transfers + updates suggestion status", () => {
    seedTx(db, {
      id: "d",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    seedTx(db, {
      id: "c",
      accountId: ACC_SAV,
      date: "2026-05-10",
      amount: 100,
    });
    db.insert(internalTransferSuggestions)
      .values({
        id: "sugg_1",
        debitTransactionId: "d",
        creditTransactionId: "c",
        detectionMethod: "amount_window",
        confidence: "medium",
        suggestedAt: NOW.toISOString(),
        status: "pending",
      })
      .run();

    const result = markInternalTransfer(db, { transferPairs: ["sugg_1"] }, now);
    expect(result).toEqual({ marked: 1 });

    const transfers = db.select().from(internalTransfers).all();
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({
      debitTransactionId: "d",
      creditTransactionId: "c",
      detectionMethod: "manual",
      markedAt: NOW.toISOString(),
    });
    const sugg = db.select().from(internalTransferSuggestions).all()[0];
    expect(sugg?.status).toBe("confirmed");
  });

  it("throws when a referenced suggestion id is unknown or non-pending", () => {
    expect(() =>
      markInternalTransfer(db, { transferPairs: ["does_not_exist"] }, now),
    ).toThrow(/Unknown or non-pending transferPair/);
  });

  it("manually marks transactions one-sided using detection_method=manual", () => {
    seedTx(db, {
      id: "d",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    const result = markInternalTransfer(
      db,
      { transactionIds: ["d"], reason: "savings sweep" },
      now,
    );
    expect(result).toEqual({ marked: 1 });
    const row = db.select().from(internalTransfers).all()[0];
    expect(row).toMatchObject({
      debitTransactionId: "d",
      creditTransactionId: null,
      detectionMethod: "manual",
    });
  });

  it("throws on unknown transactionId in the manual branch", () => {
    expect(() =>
      markInternalTransfer(db, { transactionIds: ["missing"] }, now),
    ).toThrow(/Unknown transactionId/);
  });

  it("is idempotent — re-marking an already-marked tx does not throw or duplicate", () => {
    seedTx(db, {
      id: "d",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    markInternalTransfer(db, { transactionIds: ["d"] }, now);
    const second = markInternalTransfer(db, { transactionIds: ["d"] }, now);
    expect(second.marked).toBe(0);
    expect(db.select().from(internalTransfers).all()).toHaveLength(1);
  });
});

describe("listInternalTransfers", () => {
  let db: AppDatabase;
  beforeEach(() => {
    db = createTestDatabase();
    seedAccounts(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("returns confirmed marks newest-first with debit/credit dates and amount", () => {
    seedTx(db, {
      id: "d1",
      accountId: ACC_GO,
      date: "2026-05-05",
      amount: -50,
    });
    seedTx(db, {
      id: "c1",
      accountId: ACC_SAV,
      date: "2026-05-05",
      amount: 50,
    });
    seedTx(db, {
      id: "d2",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    db.insert(internalTransfers)
      .values([
        {
          id: "x1",
          debitTransactionId: "d1",
          creditTransactionId: "c1",
          detectionMethod: "auto_matched",
          markedAt: NOW.toISOString(),
        },
        {
          id: "x2",
          debitTransactionId: "d2",
          creditTransactionId: null,
          detectionMethod: "auto_other_account",
          markedAt: NOW.toISOString(),
        },
      ])
      .run();

    const { transfers } = listInternalTransfers(db);
    expect(transfers.map((t) => t.id)).toEqual(["x2", "x1"]);
    expect(transfers[0]).toMatchObject({
      debitTransactionId: "d2",
      creditTransactionId: null,
      detectionMethod: "auto_other_account",
      debitDate: "2026-05-10",
      creditDate: null,
      amount: 100,
    });
    expect(transfers[1]).toMatchObject({
      debitTransactionId: "d1",
      creditTransactionId: "c1",
      detectionMethod: "auto_matched",
      debitDate: "2026-05-05",
      creditDate: "2026-05-05",
      amount: 50,
    });
  });

  it("filters by debit date range", () => {
    seedTx(db, {
      id: "d1",
      accountId: ACC_GO,
      date: "2026-04-30",
      amount: -10,
    });
    seedTx(db, {
      id: "d2",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -20,
    });
    db.insert(internalTransfers)
      .values([
        {
          id: "x1",
          debitTransactionId: "d1",
          detectionMethod: "manual",
          markedAt: NOW.toISOString(),
        },
        {
          id: "x2",
          debitTransactionId: "d2",
          detectionMethod: "manual",
          markedAt: NOW.toISOString(),
        },
      ])
      .run();

    const filtered = listInternalTransfers(db, {
      start: "2026-05-01",
      end: "2026-05-31",
    });
    expect(filtered.transfers.map((t) => t.id)).toEqual(["x2"]);
  });
});

describe("unmarkInternalTransfer", () => {
  let db: AppDatabase;
  beforeEach(() => {
    db = createTestDatabase();
    seedAccounts(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("throws on an empty transactionIds array", () => {
    expect(() => unmarkInternalTransfer(db, { transactionIds: [] })).toThrow(
      /non-empty/,
    );
  });

  it("removes auto-marked rows touching either debit or credit leg", () => {
    seedTx(db, {
      id: "d",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    seedTx(db, {
      id: "c",
      accountId: ACC_SAV,
      date: "2026-05-10",
      amount: 100,
    });
    db.insert(internalTransfers)
      .values({
        id: "x",
        debitTransactionId: "d",
        creditTransactionId: "c",
        detectionMethod: "auto_matched",
        markedAt: NOW.toISOString(),
      })
      .run();

    expect(unmarkInternalTransfer(db, { transactionIds: ["c"] })).toEqual({
      unmarked: 1,
    });
    expect(db.select().from(internalTransfers).all()).toHaveLength(0);
  });

  it("dismisses any pending Pass-2 suggestions touching the supplied ids", () => {
    seedTx(db, {
      id: "d",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    seedTx(db, {
      id: "c",
      accountId: ACC_SAV,
      date: "2026-05-10",
      amount: 100,
    });
    db.insert(internalTransferSuggestions)
      .values({
        id: "sugg",
        debitTransactionId: "d",
        creditTransactionId: "c",
        detectionMethod: "amount_window",
        confidence: "medium",
        suggestedAt: NOW.toISOString(),
        status: "pending",
      })
      .run();

    const result = unmarkInternalTransfer(db, { transactionIds: ["d"] });
    expect(result.unmarked).toBe(0);
    const sugg = db.select().from(internalTransferSuggestions).all()[0];
    expect(sugg?.status).toBe("dismissed");
  });

  it("is a no-op count when nothing matches", () => {
    expect(unmarkInternalTransfer(db, { transactionIds: ["nope"] })).toEqual({
      unmarked: 0,
    });
  });
});
