import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase } from "../../src/db/index.js";
import { accounts as accountsTable } from "../../src/db/schema.js";
import { getBalances, listAccounts } from "../../src/tools/accounts.js";
import { createTestDatabase, disposeTestDatabase } from "../db/setup.js";

const SYNCED_AT = "2026-05-14T02:00:00.000Z";

interface SeedAccount {
  id: string;
  name: string;
  type: string;
  institution: string;
  balanceAvailable: number | null;
  balanceCurrent: number | null;
  currency?: string | null;
}

function seedAccount(db: AppDatabase, acc: SeedAccount): void {
  db.insert(accountsTable)
    .values({
      id: acc.id,
      name: acc.name,
      type: acc.type,
      institution: acc.institution,
      balanceAvailable: acc.balanceAvailable,
      balanceCurrent: acc.balanceCurrent,
      currency: acc.currency ?? "NZD",
      syncedAt: SYNCED_AT,
    })
    .run();
}

const ANZ_GO: SeedAccount = {
  id: "acc_anz_go",
  name: "ANZ Shanika Go",
  type: "CHECKING",
  institution: "ANZ",
  balanceAvailable: 1234.56,
  balanceCurrent: 1234.56,
};

const ANZ_SAVINGS: SeedAccount = {
  id: "acc_anz_savings",
  name: "ANZ Joint Savings",
  type: "SAVINGS",
  institution: "ANZ",
  balanceAvailable: 5678.9,
  balanceCurrent: 5678.9,
};

const KIWI_LOAN: SeedAccount = {
  id: "acc_kiwi_loan",
  name: "Kiwibank Mortgage",
  type: "LOAN",
  institution: "Kiwibank",
  balanceAvailable: null,
  balanceCurrent: -312000,
};

describe("listAccounts", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    disposeTestDatabase(db);
  });

  it("returns an empty array when no accounts have been synced", () => {
    expect(listAccounts(db)).toEqual([]);
  });

  it("returns a single account shaped per spec §3.1", () => {
    seedAccount(db, ANZ_GO);
    expect(listAccounts(db)).toEqual([
      {
        id: "acc_anz_go",
        name: "ANZ Shanika Go",
        type: "CHECKING",
        institution: "ANZ",
        balance: {
          available: 1234.56,
          current: 1234.56,
          currency: "NZD",
        },
      },
    ]);
  });

  it("returns every account when multiple are present", () => {
    seedAccount(db, ANZ_GO);
    seedAccount(db, ANZ_SAVINGS);
    seedAccount(db, KIWI_LOAN);
    const result = listAccounts(db);
    expect(result).toHaveLength(3);
    expect(result.map((a) => a.id).sort()).toEqual([
      "acc_anz_go",
      "acc_anz_savings",
      "acc_kiwi_loan",
    ]);
    const loan = result.find((a) => a.id === "acc_kiwi_loan");
    expect(loan?.balance).toEqual({
      available: null,
      current: -312000,
      currency: "NZD",
    });
  });

  it("falls back to NZD when the currency column is null", () => {
    seedAccount(db, { ...ANZ_GO, currency: null });
    expect(listAccounts(db)[0]?.balance.currency).toBe("NZD");
  });

  it("preserves a non-default currency", () => {
    seedAccount(db, { ...ANZ_GO, currency: "AUD" });
    expect(listAccounts(db)[0]?.balance.currency).toBe("AUD");
  });
});

describe("getBalances", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    disposeTestDatabase(db);
  });

  it("returns an empty array when no accounts have been synced", () => {
    expect(getBalances(db)).toEqual([]);
  });

  it("returns every account when no filter is provided", () => {
    seedAccount(db, ANZ_GO);
    seedAccount(db, ANZ_SAVINGS);
    const result = getBalances(db);
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.accountName).sort()).toEqual([
      "ANZ Joint Savings",
      "ANZ Shanika Go",
    ]);
  });

  it("shapes each row per spec §3.1 (accountName + available/current/currency)", () => {
    seedAccount(db, ANZ_SAVINGS);
    expect(getBalances(db)).toEqual([
      {
        accountName: "ANZ Joint Savings",
        available: 5678.9,
        current: 5678.9,
        currency: "NZD",
      },
    ]);
  });

  it("filters by case-insensitive substring match on the account name", () => {
    seedAccount(db, ANZ_GO);
    seedAccount(db, ANZ_SAVINGS);
    seedAccount(db, KIWI_LOAN);
    const matched = getBalances(db, { accountNameFilter: "savings" });
    expect(matched).toEqual([
      {
        accountName: "ANZ Joint Savings",
        available: 5678.9,
        current: 5678.9,
        currency: "NZD",
      },
    ]);
  });

  it("matches substrings regardless of case", () => {
    seedAccount(db, ANZ_GO);
    seedAccount(db, ANZ_SAVINGS);
    expect(getBalances(db, { accountNameFilter: "ANZ" })).toHaveLength(2);
    expect(getBalances(db, { accountNameFilter: "anz" })).toHaveLength(2);
    expect(getBalances(db, { accountNameFilter: "JoInT" })).toHaveLength(1);
  });

  it("returns an empty array when the filter matches nothing", () => {
    seedAccount(db, ANZ_GO);
    seedAccount(db, ANZ_SAVINGS);
    expect(getBalances(db, { accountNameFilter: "westpac" })).toEqual([]);
  });

  it("treats a whitespace-only filter as no filter", () => {
    seedAccount(db, ANZ_GO);
    seedAccount(db, ANZ_SAVINGS);
    expect(getBalances(db, { accountNameFilter: "   " })).toHaveLength(2);
  });

  it("propagates null available balances (e.g., mortgage accounts)", () => {
    seedAccount(db, KIWI_LOAN);
    expect(getBalances(db)[0]).toEqual({
      accountName: "Kiwibank Mortgage",
      available: null,
      current: -312000,
      currency: "NZD",
    });
  });
});
