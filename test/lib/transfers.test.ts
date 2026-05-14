import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase } from "../../src/db/index.js";
import {
  accounts as accountsTable,
  internalTransfers,
  internalTransferSuggestions,
  transactions as transactionsTable,
} from "../../src/db/schema.js";
import {
  buildAccountIndex,
  buildAccountIndexFromDb,
  findTxIdsInRange,
  hasPendingSuggestion,
  isAlreadyMarkedInternal,
  runPass1,
  runPass2,
  PASS2_WINDOW_MS,
  TRANSFER_TYPES,
} from "../../src/lib/transfers.js";
import { createTestDatabase, disposeTestDatabase } from "../db/setup.js";

const NOW = "2026-05-14T10:00:00.000Z";

const ACC_GO = "acc_anz_go";
const ACC_SAV = "acc_anz_savings";
const ACC_KIWI = "acc_kiwi_chq";

const FMT_GO = "01-1234-1234567-00";
const FMT_SAV = "01-1234-9876543-00";
const FMT_KIWI = "38-9000-0000001-00";

interface SeedAccountOpts {
  id: string;
  formattedAccount?: string | null;
  rawJson?: string;
}

function seedAccount(db: AppDatabase, opts: SeedAccountOpts): void {
  const raw =
    opts.rawJson ??
    JSON.stringify({
      _id: opts.id,
      formatted_account: opts.formattedAccount ?? null,
    });
  db.insert(accountsTable)
    .values({
      id: opts.id,
      name: opts.id,
      type: "CHECKING",
      institution: "Test",
      balanceAvailable: 0,
      balanceCurrent: 0,
      currency: "NZD",
      rawJson: raw,
      syncedAt: NOW,
    })
    .run();
}

interface SeedTxOpts {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  type?: string;
  metaOtherAccount?: string | null;
  description?: string;
}

function seedTx(db: AppDatabase, opts: SeedTxOpts): void {
  db.insert(transactionsTable)
    .values({
      id: opts.id,
      accountId: opts.accountId,
      date: opts.date,
      description: opts.description ?? opts.id,
      amount: opts.amount,
      type: opts.type ?? "TRANSFER",
      merchantName: null,
      akahuCategory: null,
      metaOtherAccount: opts.metaOtherAccount ?? null,
      rawJson: null,
      syncedAt: NOW,
    })
    .run();
}

function seedStandardAccounts(db: AppDatabase): void {
  seedAccount(db, { id: ACC_GO, formattedAccount: FMT_GO });
  seedAccount(db, { id: ACC_SAV, formattedAccount: FMT_SAV });
  seedAccount(db, { id: ACC_KIWI, formattedAccount: FMT_KIWI });
}

describe("transfer heuristic constants", () => {
  it("TRANSFER_TYPES covers the four spec types and nothing else", () => {
    expect([...TRANSFER_TYPES].sort()).toEqual([
      "DIRECT CREDIT",
      "DIRECT DEBIT",
      "PAYMENT",
      "TRANSFER",
    ]);
  });

  it("PASS2_WINDOW_MS is exactly 48 hours", () => {
    expect(PASS2_WINDOW_MS).toBe(48 * 60 * 60 * 1000);
  });
});

describe("buildAccountIndex / buildAccountIndexFromDb", () => {
  let db: AppDatabase;
  beforeEach(() => {
    db = createTestDatabase();
  });
  afterEach(() => disposeTestDatabase(db));

  it("maps formatted_account → id from explicit list", () => {
    const index = buildAccountIndex([
      { id: "a", formattedAccount: "01-1" },
      { id: "b", formattedAccount: null },
      { id: "c", formattedAccount: "02-2" },
    ]);
    expect(index.get("01-1")).toBe("a");
    expect(index.get("02-2")).toBe("c");
    expect(index.size).toBe(2);
  });

  it("reads formatted_account out of accounts.raw_json", () => {
    seedStandardAccounts(db);
    const index = buildAccountIndexFromDb(db);
    expect(index.get(FMT_GO)).toBe(ACC_GO);
    expect(index.get(FMT_SAV)).toBe(ACC_SAV);
    expect(index.get(FMT_KIWI)).toBe(ACC_KIWI);
  });

  it("tolerates rows without raw_json or with bad JSON", () => {
    db.insert(accountsTable)
      .values({
        id: "acc_blank",
        name: "blank",
        type: "CHECKING",
        institution: "X",
        rawJson: null,
        syncedAt: NOW,
      })
      .run();
    db.insert(accountsTable)
      .values({
        id: "acc_bad",
        name: "bad",
        type: "CHECKING",
        institution: "X",
        rawJson: "{not-json",
        syncedAt: NOW,
      })
      .run();
    expect(buildAccountIndexFromDb(db).size).toBe(0);
  });
});

describe("findTxIdsInRange", () => {
  let db: AppDatabase;
  beforeEach(() => {
    db = createTestDatabase();
    seedStandardAccounts(db);
    seedTx(db, {
      id: "t_old",
      accountId: ACC_GO,
      date: "2026-04-30",
      amount: -10,
    });
    seedTx(db, {
      id: "t_mid",
      accountId: ACC_GO,
      date: "2026-05-05",
      amount: -10,
    });
    seedTx(db, {
      id: "t_new",
      accountId: ACC_GO,
      date: "2026-05-20",
      amount: -10,
    });
  });
  afterEach(() => disposeTestDatabase(db));

  it("returns all ids when neither bound is given", () => {
    expect(findTxIdsInRange(db).sort()).toEqual(["t_mid", "t_new", "t_old"]);
  });
  it("filters with start only", () => {
    expect(findTxIdsInRange(db, "2026-05-01").sort()).toEqual([
      "t_mid",
      "t_new",
    ]);
  });
  it("filters with end only", () => {
    expect(findTxIdsInRange(db, undefined, "2026-05-05").sort()).toEqual([
      "t_mid",
      "t_old",
    ]);
  });
  it("filters with both bounds inclusive", () => {
    expect(findTxIdsInRange(db, "2026-05-01", "2026-05-19")).toEqual(["t_mid"]);
  });
});

describe("runPass1 — table-driven (§7)", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
    seedStandardAccounts(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("marks a Pass-1 pair as auto_matched when both legs land in the same sync", () => {
    seedTx(db, {
      id: "debit",
      accountId: ACC_GO,
      date: "2026-05-10T10:00:00Z",
      amount: -500,
      metaOtherAccount: FMT_SAV,
    });
    seedTx(db, {
      id: "credit",
      accountId: ACC_SAV,
      date: "2026-05-10T10:01:00Z",
      amount: 500,
    });

    const result = runPass1(
      db,
      ["debit", "credit"],
      buildAccountIndexFromDb(db),
      NOW,
    );
    expect(result.marked).toBe(1);
    expect(result.matchedTxIds).toEqual(new Set(["debit", "credit"]));

    const row = db.select().from(internalTransfers).all()[0];
    expect(row).toMatchObject({
      debitTransactionId: "debit",
      creditTransactionId: "credit",
      detectionMethod: "auto_matched",
    });
  });

  it("falls back to auto_other_account when only one leg is in our DB", () => {
    seedTx(db, {
      id: "debit_only",
      accountId: ACC_GO,
      date: "2026-05-10T10:00:00Z",
      amount: -200,
      metaOtherAccount: FMT_KIWI,
    });

    const result = runPass1(
      db,
      ["debit_only"],
      buildAccountIndexFromDb(db),
      NOW,
    );
    expect(result.marked).toBe(1);
    const row = db.select().from(internalTransfers).all()[0];
    expect(row).toMatchObject({
      debitTransactionId: "debit_only",
      creditTransactionId: null,
      detectionMethod: "auto_other_account",
    });
  });

  it("skips when meta.other_account does not match any known account", () => {
    seedTx(db, {
      id: "stranger",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -300,
      metaOtherAccount: "99-9999-9999999-99",
    });
    const result = runPass1(
      db,
      ["stranger"],
      buildAccountIndexFromDb(db),
      NOW,
    );
    expect(result.marked).toBe(0);
    expect(db.select().from(internalTransfers).all()).toHaveLength(0);
  });

  it("skips non-transfer types even when meta.other_account matches", () => {
    seedTx(db, {
      id: "debit_card",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -50,
      type: "DEBIT",
      metaOtherAccount: FMT_SAV,
    });
    const result = runPass1(
      db,
      ["debit_card"],
      buildAccountIndexFromDb(db),
      NOW,
    );
    expect(result.marked).toBe(0);
  });

  it("skips when other_account resolves back to the same account", () => {
    seedTx(db, {
      id: "self",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -50,
      metaOtherAccount: FMT_GO,
    });
    expect(
      runPass1(db, ["self"], buildAccountIndexFromDb(db), NOW).marked,
    ).toBe(0);
  });

  it("skips transactions already in internal_transfers", () => {
    seedTx(db, {
      id: "debit",
      accountId: ACC_GO,
      date: "2026-05-10T10:00:00Z",
      amount: -500,
      metaOtherAccount: FMT_SAV,
    });
    seedTx(db, {
      id: "credit",
      accountId: ACC_SAV,
      date: "2026-05-10T10:01:00Z",
      amount: 500,
    });
    db.insert(internalTransfers)
      .values({
        id: "preexisting",
        debitTransactionId: "debit",
        creditTransactionId: null,
        detectionMethod: "manual",
        markedAt: NOW,
      })
      .run();
    const result = runPass1(
      db,
      ["debit", "credit"],
      buildAccountIndexFromDb(db),
      NOW,
    );
    expect(result.marked).toBe(0);
  });

  it("does not pair a counterpart that is itself outside the 48h window", () => {
    seedTx(db, {
      id: "debit",
      accountId: ACC_GO,
      date: "2026-05-10T10:00:00Z",
      amount: -500,
      metaOtherAccount: FMT_SAV,
    });
    seedTx(db, {
      id: "stale_credit",
      accountId: ACC_SAV,
      date: "2026-05-13T10:00:00Z", // 72h later
      amount: 500,
    });
    const result = runPass1(
      db,
      ["debit", "stale_credit"],
      buildAccountIndexFromDb(db),
      NOW,
    );
    expect(result.marked).toBe(1);
    expect(db.select().from(internalTransfers).all()[0]).toMatchObject({
      debitTransactionId: "debit",
      creditTransactionId: null,
      detectionMethod: "auto_other_account",
    });
  });

  it("returns zero work for an empty candidate list", () => {
    expect(runPass1(db, [], buildAccountIndexFromDb(db), NOW)).toEqual({
      marked: 0,
      matchedTxIds: new Set(),
    });
  });

  it("ignores tx with no metaOtherAccount", () => {
    seedTx(db, {
      id: "no_meta",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    expect(
      runPass1(db, ["no_meta"], buildAccountIndexFromDb(db), NOW).marked,
    ).toBe(0);
  });
});

describe("runPass2 — table-driven (§7)", () => {
  let db: AppDatabase;
  beforeEach(() => {
    db = createTestDatabase();
    seedStandardAccounts(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("suggests a pair within the 48h window", () => {
    seedTx(db, {
      id: "debit",
      accountId: ACC_GO,
      date: "2026-05-10T10:00:00Z",
      amount: -250,
    });
    seedTx(db, {
      id: "credit",
      accountId: ACC_SAV,
      date: "2026-05-11T10:00:00Z",
      amount: 250,
    });
    const count = runPass2(db, ["debit", "credit"], new Set(), NOW);
    expect(count).toBe(1);
    const row = db.select().from(internalTransferSuggestions).all()[0];
    expect(row).toMatchObject({
      debitTransactionId: "debit",
      creditTransactionId: "credit",
      detectionMethod: "amount_window",
      confidence: "medium",
      status: "pending",
    });
  });

  it("does not suggest when the candidate pair sits outside 48h", () => {
    seedTx(db, {
      id: "debit",
      accountId: ACC_GO,
      date: "2026-05-10T10:00:00Z",
      amount: -250,
    });
    seedTx(db, {
      id: "credit",
      accountId: ACC_SAV,
      date: "2026-05-13T10:01:00Z", // >48h
      amount: 250,
    });
    expect(runPass2(db, ["debit", "credit"], new Set(), NOW)).toBe(0);
    expect(db.select().from(internalTransferSuggestions).all()).toHaveLength(0);
  });

  it("rejects partial-amount matches (eg $499.50 vs $500)", () => {
    seedTx(db, {
      id: "debit",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -500,
    });
    seedTx(db, {
      id: "credit_partial",
      accountId: ACC_SAV,
      date: "2026-05-11",
      amount: 499.5,
    });
    expect(
      runPass2(db, ["debit", "credit_partial"], new Set(), NOW),
    ).toBe(0);
  });

  it("filters by type — same amount on the same day with non-transfer types does not match", () => {
    seedTx(db, {
      id: "savings_xfer",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -50,
      type: "TRANSFER",
    });
    seedTx(db, {
      id: "groceries",
      accountId: ACC_SAV,
      date: "2026-05-10",
      amount: 50,
      type: "EFTPOS", // <-- not a transfer type
    });
    expect(
      runPass2(db, ["savings_xfer", "groceries"], new Set(), NOW),
    ).toBe(0);
  });

  it("detects round-trip transfers as two separate pairs", () => {
    seedTx(db, {
      id: "out",
      accountId: ACC_GO,
      date: "2026-05-10T10:00:00Z",
      amount: -500,
    });
    seedTx(db, {
      id: "in_other",
      accountId: ACC_SAV,
      date: "2026-05-10T10:00:00Z",
      amount: 500,
    });
    seedTx(db, {
      id: "back_out",
      accountId: ACC_SAV,
      date: "2026-05-12T10:00:00Z",
      amount: -500,
    });
    seedTx(db, {
      id: "back_in",
      accountId: ACC_GO,
      date: "2026-05-12T10:00:00Z",
      amount: 500,
    });
    const count = runPass2(
      db,
      ["out", "in_other", "back_out", "back_in"],
      new Set(),
      NOW,
    );
    expect(count).toBe(2);
    const rows = db.select().from(internalTransferSuggestions).all();
    expect(rows).toHaveLength(2);
  });

  it("respects skipIds (Pass-1 matches handed in by sync)", () => {
    seedTx(db, {
      id: "debit",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    seedTx(db, {
      id: "credit",
      accountId: ACC_SAV,
      date: "2026-05-10",
      amount: 100,
    });
    const skip = new Set<string>(["debit", "credit"]);
    expect(runPass2(db, ["debit", "credit"], skip, NOW)).toBe(0);
  });

  it("skips already-marked rows even without the skipIds hint", () => {
    seedTx(db, {
      id: "debit",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    seedTx(db, {
      id: "credit",
      accountId: ACC_SAV,
      date: "2026-05-10",
      amount: 100,
    });
    db.insert(internalTransfers)
      .values({
        id: "x",
        debitTransactionId: "debit",
        creditTransactionId: "credit",
        detectionMethod: "manual",
        markedAt: NOW,
      })
      .run();
    expect(runPass2(db, ["debit", "credit"], new Set(), NOW)).toBe(0);
  });

  it("does not pair across the same account (intra-account transfer can't be internal)", () => {
    seedTx(db, {
      id: "a",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    seedTx(db, {
      id: "b",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: 100,
    });
    expect(runPass2(db, ["a", "b"], new Set(), NOW)).toBe(0);
  });

  it("does not duplicate an existing pending suggestion", () => {
    seedTx(db, {
      id: "debit",
      accountId: ACC_GO,
      date: "2026-05-10",
      amount: -100,
    });
    seedTx(db, {
      id: "credit",
      accountId: ACC_SAV,
      date: "2026-05-10",
      amount: 100,
    });
    db.insert(internalTransferSuggestions)
      .values({
        id: "preexisting",
        debitTransactionId: "debit",
        creditTransactionId: "credit",
        detectionMethod: "amount_window",
        confidence: "medium",
        suggestedAt: NOW,
        status: "pending",
      })
      .run();
    expect(runPass2(db, ["debit", "credit"], new Set(), NOW)).toBe(0);
  });

  it("amount symmetry invariant: every suggested pair has tx_a.amount == -tx_b.amount and different accountIds", () => {
    const dates = [
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
      "2026-05-04",
      "2026-05-05",
    ];
    const ids: string[] = [];
    for (let i = 0; i < dates.length; i++) {
      const amount = 100 + i * 50;
      seedTx(db, {
        id: `d${i}`,
        accountId: ACC_GO,
        date: dates[i]!,
        amount: -amount,
      });
      seedTx(db, {
        id: `c${i}`,
        accountId: ACC_SAV,
        date: dates[i]!,
        amount,
      });
      ids.push(`d${i}`, `c${i}`);
    }
    runPass2(db, ids, new Set(), NOW);
    const rows = db.select().from(internalTransferSuggestions).all();
    expect(rows).toHaveLength(dates.length);
    for (const row of rows) {
      const debit = db
        .select()
        .from(transactionsTable)
        .where(eqId(row.debitTransactionId))
        .all()[0];
      const credit = db
        .select()
        .from(transactionsTable)
        .where(eqId(row.creditTransactionId!))
        .all()[0];
      expect(debit?.amount).toBe(-credit!.amount);
      expect(debit?.accountId).not.toBe(credit?.accountId);
    }
  });

  it("returns zero work for an empty candidate list", () => {
    expect(runPass2(db, [], new Set(), NOW)).toBe(0);
  });
});

// Tiny shim so the invariant test stays terse without polluting the file with imports.
import { eq as drizzleEq } from "drizzle-orm";
function eqId(id: string) {
  return drizzleEq(transactionsTable.id, id);
}

describe("isAlreadyMarkedInternal / hasPendingSuggestion", () => {
  let db: AppDatabase;
  beforeEach(() => {
    db = createTestDatabase();
    seedStandardAccounts(db);
    seedTx(db, { id: "t1", accountId: ACC_GO, date: "2026-05-10", amount: -1 });
    seedTx(db, { id: "t2", accountId: ACC_SAV, date: "2026-05-10", amount: 1 });
  });
  afterEach(() => disposeTestDatabase(db));

  it("detects either side of a confirmed internal_transfer", () => {
    db.insert(internalTransfers)
      .values({
        id: "x",
        debitTransactionId: "t1",
        creditTransactionId: "t2",
        detectionMethod: "manual",
        markedAt: NOW,
      })
      .run();
    expect(isAlreadyMarkedInternal(db, "t1")).toBe(true);
    expect(isAlreadyMarkedInternal(db, "t2")).toBe(true);
    expect(isAlreadyMarkedInternal(db, "other")).toBe(false);
  });

  it("detects pending suggestions but not confirmed/dismissed", () => {
    db.insert(internalTransferSuggestions)
      .values({
        id: "s1",
        debitTransactionId: "t1",
        creditTransactionId: "t2",
        detectionMethod: "amount_window",
        confidence: "medium",
        suggestedAt: NOW,
        status: "pending",
      })
      .run();
    expect(hasPendingSuggestion(db, "t1")).toBe(true);
    expect(hasPendingSuggestion(db, "t2")).toBe(true);

    db.update(internalTransferSuggestions)
      .set({ status: "confirmed" })
      .run();
    expect(hasPendingSuggestion(db, "t1")).toBe(false);
  });
});
