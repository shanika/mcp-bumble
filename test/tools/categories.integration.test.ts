import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../../src/db/index.js";
import {
  accounts as accountsTable,
  categorizationRules,
  transactionCategories,
  transactions as transactionsTable,
} from "../../src/db/schema.js";
import { registerCategoryTools } from "../../src/tools/categories.js";
import { registerRuleTools } from "../../src/tools/rules.js";
import { createTestDatabase, disposeTestDatabase } from "../db/setup.js";

interface CallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

interface Harness {
  client: Client;
  dispose: () => Promise<void>;
}

const FROZEN_NOW = new Date("2026-05-14T03:00:00.000Z");

async function createHarness(db: AppDatabase): Promise<Harness> {
  const server = new McpServer({ name: "test-bumble", version: "0.0.0" });
  registerCategoryTools(server, db, () => FROZEN_NOW);
  registerRuleTools(server, db);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    dispose: async () => {
      await client.close();
      await server.close();
    },
  };
}

function seedSample(db: AppDatabase): void {
  db.insert(accountsTable)
    .values({
      id: "acc_a",
      name: "ANZ Go",
      type: "CHECKING",
      institution: "ANZ",
      balanceAvailable: 100,
      balanceCurrent: 100,
      currency: "NZD",
      syncedAt: FROZEN_NOW.toISOString(),
    })
    .run();

  db.insert(transactionsTable)
    .values([
      {
        id: "tx_a",
        accountId: "acc_a",
        date: "2026-05-01",
        description: "COUNTDOWN RICCARTON",
        amount: -42.5,
        type: "DEBIT",
        merchantName: "COUNTDOWN",
        akahuCategory: "Groceries & Supermarkets",
        syncedAt: FROZEN_NOW.toISOString(),
      },
      {
        id: "tx_b",
        accountId: "acc_a",
        date: "2026-05-05",
        description: "Z ENERGY GLEN INNES",
        amount: -68,
        type: "DEBIT",
        merchantName: "Z ENERGY",
        akahuCategory: "Vehicles & Transport",
        syncedAt: FROZEN_NOW.toISOString(),
      },
    ])
    .run();
}

describe("category + rule tools via MCP SDK transport", () => {
  let db: AppDatabase;
  let harness: Harness;

  beforeEach(async () => {
    db = createTestDatabase();
    harness = await createHarness(db);
  });

  afterEach(async () => {
    await harness.dispose();
    disposeTestDatabase(db);
  });

  it("advertises every category + rule tool in listTools", async () => {
    const tools = await harness.client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "categorize_transactions",
      "create_category",
      "delete_category",
      "delete_rule",
      "list_categories",
      "list_rules",
      "rename_category",
    ]);
  });

  it("categorize_transactions creates a category, assignment, and rule end-to-end", async () => {
    seedSample(db);

    const result = (await harness.client.callTool({
      name: "categorize_transactions",
      arguments: {
        assignments: [
          {
            transactionId: "tx_a",
            categoryName: "Groceries",
            source: "akahu_accepted",
          },
        ],
      },
    })) as CallResult;

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      updated: number;
      categoriesCreated: string[];
      rulesCreated: number;
      rulesUpdated: number;
    };
    expect(payload).toEqual({
      updated: 1,
      categoriesCreated: ["Groceries"],
      rulesCreated: 1,
      rulesUpdated: 0,
    });

    expect(db.select().from(transactionCategories).all()).toHaveLength(1);
    expect(db.select().from(categorizationRules).all()).toHaveLength(1);
  });

  it("list_categories returns transactionCount per category", async () => {
    seedSample(db);
    await harness.client.callTool({
      name: "categorize_transactions",
      arguments: {
        assignments: [
          { transactionId: "tx_a", categoryName: "Groceries" },
          { transactionId: "tx_b", categoryName: "Car" },
        ],
      },
    });

    const result = (await harness.client.callTool({
      name: "list_categories",
      arguments: {},
    })) as CallResult;
    const payload = result.structuredContent as {
      categories: Array<{ name: string; transactionCount: number }>;
    };
    expect(payload.categories.map((c) => c.name).sort()).toEqual([
      "Car",
      "Groceries",
    ]);
    expect(
      payload.categories.find((c) => c.name === "Car")?.transactionCount,
    ).toBe(1);
  });

  it("create_category + rename_category + delete_category complete the CRUD loop", async () => {
    const created = (await harness.client.callTool({
      name: "create_category",
      arguments: { name: "Holidays" },
    })) as CallResult;
    const createdCat = (
      created.structuredContent as { category: { id: string; name: string } }
    ).category;
    expect(createdCat.name).toBe("Holidays");

    const renamed = (await harness.client.callTool({
      name: "rename_category",
      arguments: { categoryId: createdCat.id, newName: "Travel" },
    })) as CallResult;
    expect(
      (renamed.structuredContent as { category: { name: string } }).category
        .name,
    ).toBe("Travel");

    const deleted = (await harness.client.callTool({
      name: "delete_category",
      arguments: { categoryId: createdCat.id },
    })) as CallResult;
    expect(deleted.structuredContent).toEqual({
      deleted: true,
      uncategorizedCount: 0,
    });
  });

  it("list_rules returns the rule joined to its category name", async () => {
    seedSample(db);
    await harness.client.callTool({
      name: "categorize_transactions",
      arguments: {
        assignments: [{ transactionId: "tx_a", categoryName: "Groceries" }],
      },
    });

    const result = (await harness.client.callTool({
      name: "list_rules",
      arguments: {},
    })) as CallResult;
    const payload = result.structuredContent as {
      rules: Array<{
        id: string;
        merchantPattern: string;
        categoryName: string;
        matchCount: number;
      }>;
    };
    expect(payload.rules).toHaveLength(1);
    expect(payload.rules[0]).toMatchObject({
      merchantPattern: "COUNTDOWN",
      categoryName: "Groceries",
      matchCount: 0,
    });
  });

  it("delete_rule removes the rule but keeps the existing assignment", async () => {
    seedSample(db);
    await harness.client.callTool({
      name: "categorize_transactions",
      arguments: {
        assignments: [{ transactionId: "tx_a", categoryName: "Groceries" }],
      },
    });
    const ruleId = db.select().from(categorizationRules).all()[0]!.id;

    const result = (await harness.client.callTool({
      name: "delete_rule",
      arguments: { ruleId },
    })) as CallResult;
    expect(result.structuredContent).toEqual({ deleted: true });
    expect(db.select().from(categorizationRules).all()).toHaveLength(0);
    expect(db.select().from(transactionCategories).all()).toHaveLength(1);
  });

  it("delete_category cascades into rules and uncategorizes transactions", async () => {
    seedSample(db);
    await harness.client.callTool({
      name: "categorize_transactions",
      arguments: {
        assignments: [
          { transactionId: "tx_a", categoryName: "Groceries" },
          { transactionId: "tx_b", categoryName: "Groceries" },
        ],
      },
    });

    const list = (await harness.client.callTool({
      name: "list_categories",
      arguments: {},
    })) as CallResult;
    const categoryId = (
      list.structuredContent as {
        categories: Array<{ id: string; name: string }>;
      }
    ).categories[0]!.id;

    const result = (await harness.client.callTool({
      name: "delete_category",
      arguments: { categoryId },
    })) as CallResult;
    expect(result.structuredContent).toEqual({
      deleted: true,
      uncategorizedCount: 2,
    });
    expect(db.select().from(categorizationRules).all()).toHaveLength(0);
    expect(db.select().from(transactionCategories).all()).toHaveLength(0);
  });

  it("returns an error result when categorize_transactions targets an unknown id", async () => {
    const result = (await harness.client.callTool({
      name: "categorize_transactions",
      arguments: {
        assignments: [{ transactionId: "tx_missing", categoryName: "X" }],
      },
    })) as CallResult;
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? "";
    expect(text).toMatch(/Unknown transactionId/);
  });
});
