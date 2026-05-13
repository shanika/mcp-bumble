import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import type { AppDatabase } from "../../src/db/index.js";
import {
  accounts as accountsTable,
  categorizationRules,
  transactionCategories,
  transactions as transactionsTable,
} from "../../src/db/schema.js";
import { categorizeTransactions } from "../../src/tools/categories.js";
import { deleteRule, listRules } from "../../src/tools/rules.js";
import { createTestDatabase, disposeTestDatabase } from "../db/setup.js";

const SYNCED_AT = "2026-05-14T02:00:00.000Z";
const FROZEN_NOW = new Date("2026-05-14T03:00:00.000Z");
const now = (): Date => FROZEN_NOW;

function seedAccount(db: AppDatabase): void {
  db.insert(accountsTable)
    .values({
      id: "acc_a",
      name: "acc_a",
      type: "CHECKING",
      institution: "ANZ",
      balanceAvailable: 0,
      balanceCurrent: 0,
      currency: "NZD",
      syncedAt: SYNCED_AT,
    })
    .run();
}

function seedTx(
  db: AppDatabase,
  id: string,
  merchantName: string,
  description = merchantName,
): void {
  db.insert(transactionsTable)
    .values({
      id,
      accountId: "acc_a",
      date: "2026-05-01",
      description,
      amount: -10,
      type: "DEBIT",
      merchantName,
      akahuCategory: null,
      metaOtherAccount: null,
      syncedAt: SYNCED_AT,
    })
    .run();
}

describe("listRules", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
    seedAccount(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("returns an empty array when no rules exist", () => {
    expect(listRules(db)).toEqual([]);
  });

  it("returns rules joined to category names, ordered by merchantPattern", () => {
    seedTx(db, "tx1", "COUNTDOWN");
    seedTx(db, "tx2", "Z ENERGY");
    seedTx(db, "tx3", "MCDONALDS");

    categorizeTransactions(
      db,
      {
        assignments: [
          { transactionId: "tx1", categoryName: "Groceries" },
          { transactionId: "tx2", categoryName: "Car" },
          { transactionId: "tx3", categoryName: "Restaurants" },
        ],
      },
      now,
    );

    const rules = listRules(db);
    expect(rules.map((r) => r.merchantPattern)).toEqual([
      "COUNTDOWN",
      "MCDONALDS",
      "Z ENERGY",
    ]);
    const countdown = rules.find((r) => r.merchantPattern === "COUNTDOWN")!;
    expect(countdown.categoryName).toBe("Groceries");
    expect(countdown.matchCount).toBe(0);
    expect(countdown.createdAt).toBe(FROZEN_NOW.toISOString());
    expect(countdown.updatedAt).toBe(FROZEN_NOW.toISOString());
    expect(countdown.id).toMatch(/^rule_/);
  });

  it("preserves matchCount as written by the sync pipeline", () => {
    seedTx(db, "tx1", "COUNTDOWN");
    categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx1", categoryName: "Groceries" }] },
      now,
    );
    const rule = db.select().from(categorizationRules).all()[0]!;
    db.update(categorizationRules)
      .set({ matchCount: 7 })
      .where(eq(categorizationRules.id, rule.id))
      .run();
    expect(listRules(db)[0]?.matchCount).toBe(7);
  });
});

describe("deleteRule", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
    seedAccount(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("removes the named rule but leaves categorized transactions intact", () => {
    seedTx(db, "tx1", "COUNTDOWN");
    categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx1", categoryName: "Groceries" }] },
      now,
    );
    const rule = db.select().from(categorizationRules).all()[0]!;

    expect(deleteRule(db, { ruleId: rule.id })).toEqual({ deleted: true });
    expect(db.select().from(categorizationRules).all()).toHaveLength(0);
    expect(db.select().from(transactionCategories).all()).toHaveLength(1);
  });

  it("throws on unknown ruleId", () => {
    expect(() => deleteRule(db, { ruleId: "rule_missing" })).toThrow(
      /Unknown ruleId/,
    );
  });

  it("only deletes the targeted rule", () => {
    seedTx(db, "tx1", "COUNTDOWN");
    seedTx(db, "tx2", "Z ENERGY");
    categorizeTransactions(
      db,
      {
        assignments: [
          { transactionId: "tx1", categoryName: "Groceries" },
          { transactionId: "tx2", categoryName: "Car" },
        ],
      },
      now,
    );
    const all = db.select().from(categorizationRules).all();
    deleteRule(db, { ruleId: all[0]!.id });
    const remaining = db.select().from(categorizationRules).all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(all[1]?.id);
  });
});
