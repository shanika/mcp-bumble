import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../../src/db/index.js";
import {
  accounts as accountsTable,
  syncRuns,
  transactions as transactionsTable,
} from "../../src/db/schema.js";
import { registerTransactionTools } from "../../src/tools/transactions.js";
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
  registerTransactionTools(server, db, () => FROZEN_NOW);

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
      syncedAt: "2026-05-14T02:00:00.000Z",
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
        syncedAt: "2026-05-14T02:00:00.000Z",
      },
      {
        id: "tx_b",
        accountId: "acc_a",
        date: "2026-05-05",
        description: "MERCURY NZ DD",
        amount: -185.42,
        type: "DIRECT DEBIT",
        merchantName: "MERCURY NZ",
        akahuCategory: "Utilities",
        syncedAt: "2026-05-14T02:00:00.000Z",
      },
    ])
    .run();
}

describe("transaction tools via MCP SDK transport", () => {
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

  it("advertises the three transaction tools in listTools", async () => {
    const tools = await harness.client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "list_transactions",
      "list_uncategorized",
      "search_transactions",
    ]);
  });

  it("list_transactions returns seeded rows as structured content", async () => {
    seedSample(db);
    const result = (await harness.client.callTool({
      name: "list_transactions",
      arguments: {},
    })) as CallResult;
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      transactions: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(payload.transactions.map((t) => t.id)).toEqual(["tx_b", "tx_a"]);
    expect(payload.nextCursor).toBeUndefined();
    // text fallback matches structured payload
    const text = result.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { transactions: unknown[] };
    expect(parsed.transactions).toHaveLength(2);
  });

  it("list_transactions returns a cursor when more rows remain", async () => {
    seedSample(db);
    const result = (await harness.client.callTool({
      name: "list_transactions",
      arguments: { limit: 1 },
    })) as CallResult;
    const payload = result.structuredContent as {
      transactions: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(payload.transactions.map((t) => t.id)).toEqual(["tx_b"]);
    expect(typeof payload.nextCursor).toBe("string");

    const next = (await harness.client.callTool({
      name: "list_transactions",
      arguments: { limit: 1, cursor: payload.nextCursor },
    })) as CallResult;
    expect(
      (
        next.structuredContent as { transactions: Array<{ id: string }> }
      ).transactions.map((t) => t.id),
    ).toEqual(["tx_a"]);
  });

  it("search_transactions filters by merchant substring", async () => {
    seedSample(db);
    const result = (await harness.client.callTool({
      name: "search_transactions",
      arguments: { query: "mercury" },
    })) as CallResult;
    const payload = result.structuredContent as {
      transactions: Array<{ id: string }>;
    };
    expect(payload.transactions.map((t) => t.id)).toEqual(["tx_b"]);
  });

  it("list_uncategorized surfaces akahuCategory and the stale-sync warning", async () => {
    seedSample(db);
    db.insert(syncRuns)
      .values({
        id: "run_old",
        startedAt: "2026-05-12T02:00:00.000Z",
        finishedAt: "2026-05-12T02:01:00.000Z",
        status: "ok",
      })
      .run();

    const result = (await harness.client.callTool({
      name: "list_uncategorized",
      arguments: {},
    })) as CallResult;
    const payload = result.structuredContent as {
      transactions: Array<{ id: string; akahuCategory: string | null }>;
      warning?: string;
    };
    expect(payload.transactions.map((t) => t.id)).toEqual(["tx_b", "tx_a"]);
    expect(payload.transactions[0]?.akahuCategory).toBe("Utilities");
    expect(payload.warning).toMatch(/^Last sync was \d+h ago/);
  });
});
