import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../../src/db/index.js";
import { accounts as accountsTable } from "../../src/db/schema.js";
import { registerAccountTools } from "../../src/tools/accounts.js";
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

async function createHarness(db: AppDatabase): Promise<Harness> {
  const server = new McpServer({ name: "test-bumble", version: "0.0.0" });
  registerAccountTools(server, db);

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

function seedAnzAccounts(db: AppDatabase): void {
  db.insert(accountsTable)
    .values([
      {
        id: "acc_anz_go",
        name: "ANZ Shanika Go",
        type: "CHECKING",
        institution: "ANZ",
        balanceAvailable: 1234.56,
        balanceCurrent: 1234.56,
        currency: "NZD",
        syncedAt: "2026-05-14T02:00:00.000Z",
      },
      {
        id: "acc_anz_savings",
        name: "ANZ Joint Savings",
        type: "SAVINGS",
        institution: "ANZ",
        balanceAvailable: 5678.9,
        balanceCurrent: 5678.9,
        currency: "NZD",
        syncedAt: "2026-05-14T02:00:00.000Z",
      },
    ])
    .run();
}

describe("account tools via MCP SDK transport", () => {
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

  it("advertises list_accounts and get_balances in listTools", async () => {
    const tools = await harness.client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_balances", "list_accounts"]);
  });

  it("list_accounts returns the seeded accounts as structured content", async () => {
    seedAnzAccounts(db);

    const result = (await harness.client.callTool({
      name: "list_accounts",
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeFalsy();
    const accounts = (result.structuredContent as { accounts?: unknown[] })
      .accounts;
    expect(accounts).toHaveLength(2);
    expect(accounts).toContainEqual({
      id: "acc_anz_go",
      name: "ANZ Shanika Go",
      type: "CHECKING",
      institution: "ANZ",
      balance: { available: 1234.56, current: 1234.56, currency: "NZD" },
    });

    // text fallback content also carries the same payload as a JSON string
    const text = result.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { accounts: unknown[] };
    expect(parsed.accounts).toHaveLength(2);
  });

  it("list_accounts returns an empty array when no accounts have been synced", async () => {
    const result = (await harness.client.callTool({
      name: "list_accounts",
      arguments: {},
    })) as CallResult;

    expect(result.isError).toBeFalsy();
    expect(
      (result.structuredContent as { accounts: unknown[] }).accounts,
    ).toEqual([]);
  });

  it("get_balances filters by case-insensitive substring on accountName", async () => {
    seedAnzAccounts(db);

    const result = (await harness.client.callTool({
      name: "get_balances",
      arguments: { accountNameFilter: "savings" },
    })) as CallResult;

    expect(result.isError).toBeFalsy();
    const balances = (result.structuredContent as { balances: unknown[] })
      .balances;
    expect(balances).toEqual([
      {
        accountName: "ANZ Joint Savings",
        available: 5678.9,
        current: 5678.9,
        currency: "NZD",
      },
    ]);
  });

  it("get_balances returns every account when no filter is provided", async () => {
    seedAnzAccounts(db);
    const result = (await harness.client.callTool({
      name: "get_balances",
      arguments: {},
    })) as CallResult;
    const balances = (result.structuredContent as { balances: unknown[] })
      .balances;
    expect(balances).toHaveLength(2);
  });

  it("get_balances returns an empty array when the filter matches nothing", async () => {
    seedAnzAccounts(db);
    const result = (await harness.client.callTool({
      name: "get_balances",
      arguments: { accountNameFilter: "westpac" },
    })) as CallResult;
    expect(
      (result.structuredContent as { balances: unknown[] }).balances,
    ).toEqual([]);
  });
});
