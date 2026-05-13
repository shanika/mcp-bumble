import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppDatabase } from "../../src/db/index.js";
import {
  accounts as accountsTable,
  categories as categoriesTable,
  categorizationRules,
  transactionCategories,
  transactions as transactionsTable,
} from "../../src/db/schema.js";
import {
  categorizeTransactions,
  createCategory,
  deleteCategory,
  listCategories,
  renameCategory,
} from "../../src/tools/categories.js";
import { createTestDatabase, disposeTestDatabase } from "../db/setup.js";

const SYNCED_AT = "2026-05-14T02:00:00.000Z";
const FROZEN_NOW = new Date("2026-05-14T03:30:00.000Z");
const now = (): Date => FROZEN_NOW;

interface SeedTx {
  id: string;
  description: string;
  merchantName?: string | null;
  amount?: number;
  accountId?: string;
}

function seedAccount(db: AppDatabase, id = "acc_a"): void {
  db.insert(accountsTable)
    .values({
      id,
      name: id,
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
      accountId: tx.accountId ?? "acc_a",
      date: "2026-05-01",
      description: tx.description,
      amount: tx.amount ?? -10,
      type: "DEBIT",
      merchantName: tx.merchantName ?? null,
      akahuCategory: null,
      metaOtherAccount: null,
      syncedAt: SYNCED_AT,
    })
    .run();
}

describe("categorizeTransactions", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
    seedAccount(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("returns the empty result for an empty assignments array", () => {
    expect(categorizeTransactions(db, { assignments: [] }, now)).toEqual({
      updated: 0,
      categoriesCreated: [],
      rulesCreated: 0,
      rulesUpdated: 0,
    });
  });

  it("creates a category, assigns the transaction, and creates a rule (akahu_accepted branch)", () => {
    seedTx(db, {
      id: "tx1",
      description: "COUNTDOWN RICCARTON",
      merchantName: "COUNTDOWN",
    });

    const result = categorizeTransactions(
      db,
      {
        assignments: [
          {
            transactionId: "tx1",
            categoryName: "Groceries & Supermarkets",
            source: "akahu_accepted",
          },
        ],
      },
      now,
    );

    expect(result).toEqual({
      updated: 1,
      categoriesCreated: ["Groceries & Supermarkets"],
      rulesCreated: 1,
      rulesUpdated: 0,
    });

    const cats = db.select().from(categoriesTable).all();
    expect(cats).toHaveLength(1);
    expect(cats[0]?.source).toBe("akahu_accepted");

    const assignment = db.select().from(transactionCategories).all()[0];
    expect(assignment?.categoryId).toBe(cats[0]?.id);
    expect(assignment?.source).toBe("akahu_accepted");
    expect(assignment?.assignedAt).toBe(FROZEN_NOW.toISOString());

    const rules = db.select().from(categorizationRules).all();
    expect(rules).toHaveLength(1);
    expect(rules[0]?.merchantPattern).toBe("COUNTDOWN");
    expect(rules[0]?.categoryId).toBe(cats[0]?.id);
    expect(rules[0]?.sourceTransactionId).toBe("tx1");
    expect(rules[0]?.matchCount).toBe(0);
  });

  it("uses the user_override source on category and assignment when chosen", () => {
    seedTx(db, {
      id: "tx_z",
      description: "Z ENERGY GLEN INNES",
      merchantName: "Z ENERGY",
    });

    categorizeTransactions(
      db,
      {
        assignments: [
          {
            transactionId: "tx_z",
            categoryName: "Car",
            source: "user_override",
          },
        ],
      },
      now,
    );

    const cat = db.select().from(categoriesTable).all()[0];
    expect(cat?.source).toBe("user_override");
    const assignment = db.select().from(transactionCategories).all()[0];
    expect(assignment?.source).toBe("user_override");
  });

  it("defaults source to user_override when omitted", () => {
    seedTx(db, { id: "tx1", description: "X", merchantName: "X" });
    categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx1", categoryName: "Misc" }] },
      now,
    );
    const assignment = db.select().from(transactionCategories).all()[0];
    expect(assignment?.source).toBe("user_override");
  });

  it("reuses an existing category when the name already exists", () => {
    seedTx(db, { id: "tx1", description: "A", merchantName: "A" });
    seedTx(db, { id: "tx2", description: "B", merchantName: "B" });

    const r1 = categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx1", categoryName: "Misc" }] },
      now,
    );
    const r2 = categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx2", categoryName: "Misc" }] },
      now,
    );

    expect(r1.categoriesCreated).toEqual(["Misc"]);
    expect(r2.categoriesCreated).toEqual([]);
    expect(db.select().from(categoriesTable).all()).toHaveLength(1);
  });

  it("trims whitespace around category names so re-assignments collapse to the same row", () => {
    seedTx(db, { id: "tx1", description: "A", merchantName: "A" });
    seedTx(db, { id: "tx2", description: "B", merchantName: "B" });

    categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx1", categoryName: "Groceries" }] },
      now,
    );
    const r2 = categorizeTransactions(
      db,
      {
        assignments: [{ transactionId: "tx2", categoryName: "  Groceries  " }],
      },
      now,
    );

    expect(r2.categoriesCreated).toEqual([]);
    expect(db.select().from(categoriesTable).all()).toHaveLength(1);
  });

  it("falls back to first-two-words of description when merchant_name is missing", () => {
    seedTx(db, {
      id: "tx_desc",
      description: "LITTLE BIRD ORGANICS PONSONBY",
      merchantName: null,
    });
    categorizeTransactions(
      db,
      {
        assignments: [{ transactionId: "tx_desc", categoryName: "Groceries" }],
      },
      now,
    );
    const rule = db.select().from(categorizationRules).all()[0];
    expect(rule?.merchantPattern).toBe("LITTLE BIRD");
  });

  it("re-categorizing the same merchant to a different category updates (not duplicates) the rule", () => {
    seedTx(db, {
      id: "tx1",
      description: "COUNTDOWN A",
      merchantName: "COUNTDOWN",
    });
    seedTx(db, {
      id: "tx2",
      description: "COUNTDOWN B",
      merchantName: "COUNTDOWN",
    });

    categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx1", categoryName: "Groceries" }] },
      now,
    );
    const result = categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx2", categoryName: "Snacks" }] },
      now,
    );

    expect(result.rulesCreated).toBe(0);
    expect(result.rulesUpdated).toBe(1);

    const rules = db.select().from(categorizationRules).all();
    expect(rules).toHaveLength(1);
    const snacks = db
      .select()
      .from(categoriesTable)
      .all()
      .find((c) => c.name === "Snacks");
    expect(rules[0]?.categoryId).toBe(snacks?.id);
    expect(rules[0]?.sourceTransactionId).toBe("tx2");
  });

  it("re-categorizing the same merchant to the same category does not increment rulesUpdated", () => {
    seedTx(db, {
      id: "tx1",
      description: "COUNTDOWN A",
      merchantName: "COUNTDOWN",
    });
    seedTx(db, {
      id: "tx2",
      description: "COUNTDOWN B",
      merchantName: "COUNTDOWN",
    });

    categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx1", categoryName: "Groceries" }] },
      now,
    );
    const result = categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx2", categoryName: "Groceries" }] },
      now,
    );
    expect(result.rulesCreated).toBe(0);
    expect(result.rulesUpdated).toBe(0);
    // sourceTransactionId still gets refreshed
    const rule = db.select().from(categorizationRules).all()[0];
    expect(rule?.sourceTransactionId).toBe("tx2");
  });

  it("re-assigning a single transaction to a different category replaces (not duplicates) its assignment", () => {
    seedTx(db, { id: "tx1", description: "X", merchantName: "X" });

    categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx1", categoryName: "Groceries" }] },
      now,
    );
    categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx1", categoryName: "Snacks" }] },
      now,
    );

    const assignments = db.select().from(transactionCategories).all();
    expect(assignments).toHaveLength(1);
    const snacks = db
      .select()
      .from(categoriesTable)
      .all()
      .find((c) => c.name === "Snacks");
    expect(assignments[0]?.categoryId).toBe(snacks?.id);
  });

  it("handles a bulk call with mixed accept/override and reuse semantics", () => {
    seedTx(db, {
      id: "tx1",
      description: "COUNTDOWN",
      merchantName: "COUNTDOWN",
    });
    seedTx(db, {
      id: "tx2",
      description: "Z ENERGY",
      merchantName: "Z ENERGY",
    });
    seedTx(db, {
      id: "tx3",
      description: "MCDONALDS",
      merchantName: "MCDONALDS",
    });

    const result = categorizeTransactions(
      db,
      {
        assignments: [
          {
            transactionId: "tx1",
            categoryName: "Groceries",
            source: "akahu_accepted",
          },
          {
            transactionId: "tx2",
            categoryName: "Car",
            source: "user_override",
          },
          {
            transactionId: "tx3",
            categoryName: "Restaurants & Cafes",
            source: "akahu_accepted",
          },
        ],
      },
      now,
    );

    expect(result.updated).toBe(3);
    expect(result.categoriesCreated.sort()).toEqual([
      "Car",
      "Groceries",
      "Restaurants & Cafes",
    ]);
    expect(result.rulesCreated).toBe(3);
    expect(result.rulesUpdated).toBe(0);
  });

  it("does not double-count a category created twice in a single call", () => {
    seedTx(db, { id: "tx1", description: "A", merchantName: "A" });
    seedTx(db, { id: "tx2", description: "B", merchantName: "B" });

    const result = categorizeTransactions(
      db,
      {
        assignments: [
          { transactionId: "tx1", categoryName: "Groceries" },
          { transactionId: "tx2", categoryName: "Groceries" },
        ],
      },
      now,
    );
    expect(result.categoriesCreated).toEqual(["Groceries"]);
  });

  it("throws on an unknown transactionId", () => {
    expect(() =>
      categorizeTransactions(
        db,
        { assignments: [{ transactionId: "missing", categoryName: "X" }] },
        now,
      ),
    ).toThrow(/Unknown transactionId/);
  });

  it("throws on an empty/whitespace categoryName", () => {
    seedTx(db, { id: "tx1", description: "X", merchantName: "X" });
    expect(() =>
      categorizeTransactions(
        db,
        { assignments: [{ transactionId: "tx1", categoryName: "   " }] },
        now,
      ),
    ).toThrow(/non-empty/);
  });

  it("skips rule creation when neither merchantName nor description yield a key", () => {
    seedTx(db, { id: "tx_blank", description: "   ", merchantName: null });
    const result = categorizeTransactions(
      db,
      { assignments: [{ transactionId: "tx_blank", categoryName: "Misc" }] },
      now,
    );
    expect(result.updated).toBe(1);
    expect(result.rulesCreated).toBe(0);
    expect(db.select().from(categorizationRules).all()).toHaveLength(0);
  });
});

describe("listCategories", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
    seedAccount(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("returns an empty array when no categories exist", () => {
    expect(listCategories(db)).toEqual([]);
  });

  it("returns categories with their transaction counts ordered alphabetically (case-insensitive)", () => {
    seedTx(db, { id: "tx1", description: "A", merchantName: "A" });
    seedTx(db, { id: "tx2", description: "B", merchantName: "B" });
    seedTx(db, { id: "tx3", description: "C", merchantName: "C" });

    categorizeTransactions(
      db,
      {
        assignments: [
          { transactionId: "tx1", categoryName: "groceries" },
          { transactionId: "tx2", categoryName: "groceries" },
          { transactionId: "tx3", categoryName: "Bills" },
        ],
      },
      now,
    );

    const result = listCategories(db);
    expect(result.map((c) => c.name)).toEqual(["Bills", "groceries"]);
    const groceries = result.find((c) => c.name === "groceries");
    expect(groceries?.transactionCount).toBe(2);
    expect(result.find((c) => c.name === "Bills")?.transactionCount).toBe(1);
  });

  it("reports zero count for a category with no assignments", () => {
    createCategory(db, { name: "Empty" }, now);
    expect(listCategories(db)).toEqual([
      { id: expect.any(String), name: "Empty", transactionCount: 0 },
    ]);
  });
});

describe("createCategory", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });
  afterEach(() => disposeTestDatabase(db));

  it("creates a new category with source 'user'", () => {
    const cat = createCategory(db, { name: "Holidays" }, now);
    expect(cat.id).toMatch(/^cat_/);
    expect(cat.name).toBe("Holidays");

    const rows = db.select().from(categoriesTable).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("user");
    expect(rows[0]?.createdAt).toBe(FROZEN_NOW.toISOString());
  });

  it("is idempotent — returns the existing category when the name already exists", () => {
    const first = createCategory(db, { name: "Holidays" }, now);
    const second = createCategory(db, { name: "Holidays" }, now);
    expect(second).toEqual(first);
    expect(db.select().from(categoriesTable).all()).toHaveLength(1);
  });

  it("trims whitespace around the name", () => {
    const cat = createCategory(db, { name: "  Holidays  " }, now);
    expect(cat.name).toBe("Holidays");
  });

  it("throws on an empty name", () => {
    expect(() => createCategory(db, { name: "   " }, now)).toThrow(/non-empty/);
  });
});

describe("renameCategory", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });
  afterEach(() => disposeTestDatabase(db));

  it("renames an existing category", () => {
    const cat = createCategory(db, { name: "Car" }, now);
    const renamed = renameCategory(db, {
      categoryId: cat.id,
      newName: "Vehicle",
    });
    expect(renamed).toEqual({ id: cat.id, name: "Vehicle" });
    expect(db.select().from(categoriesTable).all()[0]?.name).toBe("Vehicle");
  });

  it("trims whitespace in the new name", () => {
    const cat = createCategory(db, { name: "Car" }, now);
    const renamed = renameCategory(db, {
      categoryId: cat.id,
      newName: "  Vehicle ",
    });
    expect(renamed.name).toBe("Vehicle");
  });

  it("is a no-op when the new name equals the old name", () => {
    const cat = createCategory(db, { name: "Car" }, now);
    expect(renameCategory(db, { categoryId: cat.id, newName: "Car" })).toEqual(
      cat,
    );
  });

  it("throws when the new name collides with another category", () => {
    const car = createCategory(db, { name: "Car" }, now);
    createCategory(db, { name: "Vehicle" }, now);
    expect(() =>
      renameCategory(db, { categoryId: car.id, newName: "Vehicle" }),
    ).toThrow(/already exists/);
  });

  it("throws on unknown categoryId", () => {
    expect(() =>
      renameCategory(db, { categoryId: "cat_missing", newName: "X" }),
    ).toThrow(/Unknown categoryId/);
  });

  it("throws on empty newName", () => {
    const cat = createCategory(db, { name: "Car" }, now);
    expect(() =>
      renameCategory(db, { categoryId: cat.id, newName: "  " }),
    ).toThrow(/non-empty/);
  });
});

describe("deleteCategory", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
    seedAccount(db);
  });
  afterEach(() => disposeTestDatabase(db));

  it("deletes the category, uncategorizes its transactions, and drops its rules", () => {
    seedTx(db, {
      id: "tx1",
      description: "COUNTDOWN",
      merchantName: "COUNTDOWN",
    });
    seedTx(db, {
      id: "tx2",
      description: "COUNTDOWN B",
      merchantName: "COUNTDOWN",
    });

    categorizeTransactions(
      db,
      {
        assignments: [
          { transactionId: "tx1", categoryName: "Groceries" },
          { transactionId: "tx2", categoryName: "Groceries" },
        ],
      },
      now,
    );
    const cat = db.select().from(categoriesTable).all()[0]!;

    const result = deleteCategory(db, { categoryId: cat.id });
    expect(result).toEqual({ deleted: true, uncategorizedCount: 2 });

    expect(db.select().from(categoriesTable).all()).toHaveLength(0);
    expect(db.select().from(transactionCategories).all()).toHaveLength(0);
    expect(db.select().from(categorizationRules).all()).toHaveLength(0);
  });

  it("returns uncategorizedCount=0 for a category with no assignments", () => {
    const cat = createCategory(db, { name: "Empty" }, now);
    expect(deleteCategory(db, { categoryId: cat.id })).toEqual({
      deleted: true,
      uncategorizedCount: 0,
    });
  });

  it("throws on unknown categoryId", () => {
    expect(() => deleteCategory(db, { categoryId: "cat_missing" })).toThrow(
      /Unknown categoryId/,
    );
  });

  it("does not affect other categories or their assignments", () => {
    seedTx(db, { id: "tx1", description: "A", merchantName: "A" });
    seedTx(db, { id: "tx2", description: "B", merchantName: "B" });
    categorizeTransactions(
      db,
      {
        assignments: [
          { transactionId: "tx1", categoryName: "Groceries" },
          { transactionId: "tx2", categoryName: "Bills" },
        ],
      },
      now,
    );
    const groceries = db
      .select()
      .from(categoriesTable)
      .all()
      .find((c) => c.name === "Groceries")!;

    deleteCategory(db, { categoryId: groceries.id });
    const remaining = db.select().from(categoriesTable).all();
    expect(remaining.map((c) => c.name)).toEqual(["Bills"]);
    const assignments = db.select().from(transactionCategories).all();
    expect(assignments.map((a) => a.transactionId)).toEqual(["tx2"]);
  });
});
