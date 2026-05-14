import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../../src/db/index.js";
import {
  accounts as accountsTable,
  internalTransfers,
  internalTransferSuggestions,
  transactions as transactionsTable,
} from "../../src/db/schema.js";
import { registerTransferTools } from "../../src/tools/transfers.js";
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
  registerTransferTools(server, db, () => FROZEN_NOW);

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
        syncedAt: FROZEN_NOW.toISOString(),
      })
      .run();
  }
}

function seedPass2Pair(db: AppDatabase): void {
  db.insert(transactionsTable)
    .values([
      {
        id: "d",
        accountId: ACC_GO,
        date: "2026-05-10",
        description: "Transfer to savings",
        amount: -250,
        type: "TRANSFER",
        merchantName: null,
        akahuCategory: null,
        metaOtherAccount: null,
        syncedAt: FROZEN_NOW.toISOString(),
      },
      {
        id: "c",
        accountId: ACC_SAV,
        date: "2026-05-11",
        description: "Transfer from go",
        amount: 250,
        type: "TRANSFER",
        merchantName: null,
        akahuCategory: null,
        metaOtherAccount: null,
        syncedAt: FROZEN_NOW.toISOString(),
      },
    ])
    .run();
}

function seedPass1Pair(db: AppDatabase): void {
  db.insert(transactionsTable)
    .values([
      {
        id: "p1_debit",
        accountId: ACC_GO,
        date: "2026-05-10T10:00:00Z",
        description: "Transfer to savings",
        amount: -500,
        type: "TRANSFER",
        merchantName: null,
        akahuCategory: null,
        metaOtherAccount: FMT_SAV,
        syncedAt: FROZEN_NOW.toISOString(),
      },
      {
        id: "p1_credit",
        accountId: ACC_SAV,
        date: "2026-05-10T10:05:00Z",
        description: "Transfer from go",
        amount: 500,
        type: "TRANSFER",
        merchantName: null,
        akahuCategory: null,
        metaOtherAccount: null,
        syncedAt: FROZEN_NOW.toISOString(),
      },
    ])
    .run();
}

describe("transfer tools via MCP SDK transport", () => {
  let db: AppDatabase;
  let harness: Harness;

  beforeEach(async () => {
    db = createTestDatabase();
    seedAccounts(db);
    harness = await createHarness(db);
  });

  afterEach(async () => {
    await harness.dispose();
    disposeTestDatabase(db);
  });

  it("advertises all four transfer tools in listTools", async () => {
    const tools = await harness.client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "detect_internal_transfers",
      "list_internal_transfers",
      "mark_internal_transfer",
      "unmark_internal_transfer",
    ]);
  });

  it("detect → mark (transferPairs) → list completes the confirm-suggestion flow", async () => {
    seedPass2Pair(db);

    const detect = (await harness.client.callTool({
      name: "detect_internal_transfers",
      arguments: { start: "2026-05-01", end: "2026-05-31" },
    })) as CallResult;
    const detectPayload = detect.structuredContent as {
      pairs: Array<{ pairId: string; debitTransactionId: string }>;
    };
    expect(detectPayload.pairs).toHaveLength(1);
    expect(detectPayload.pairs[0]).toMatchObject({
      debitTransactionId: "d",
    });

    const pairId = detectPayload.pairs[0]!.pairId;
    const mark = (await harness.client.callTool({
      name: "mark_internal_transfer",
      arguments: { transferPairs: [pairId] },
    })) as CallResult;
    expect(mark.structuredContent).toEqual({ marked: 1 });

    const list = (await harness.client.callTool({
      name: "list_internal_transfers",
      arguments: {},
    })) as CallResult;
    const listPayload = list.structuredContent as {
      transfers: Array<{ debitTransactionId: string; detectionMethod: string }>;
    };
    expect(listPayload.transfers).toHaveLength(1);
    expect(listPayload.transfers[0]).toMatchObject({
      debitTransactionId: "d",
      creditTransactionId: "c",
      detectionMethod: "manual",
    });

    // Suggestion was flipped to confirmed
    const sugg = db.select().from(internalTransferSuggestions).all()[0];
    expect(sugg?.status).toBe("confirmed");
  });

  it("mark_internal_transfer({ transactionIds }) supports a manual one-sided mark", async () => {
    db.insert(transactionsTable)
      .values({
        id: "solo",
        accountId: ACC_GO,
        date: "2026-05-12",
        description: "Adjustment",
        amount: -42,
        type: "TRANSFER",
        merchantName: null,
        akahuCategory: null,
        metaOtherAccount: null,
        syncedAt: FROZEN_NOW.toISOString(),
      })
      .run();

    const mark = (await harness.client.callTool({
      name: "mark_internal_transfer",
      arguments: {
        transactionIds: ["solo"],
        reason: "covered by joint account",
      },
    })) as CallResult;
    expect(mark.structuredContent).toEqual({ marked: 1 });

    const row = db.select().from(internalTransfers).all()[0];
    expect(row).toMatchObject({
      debitTransactionId: "solo",
      creditTransactionId: null,
      detectionMethod: "manual",
    });
  });

  it("unmark_internal_transfer reverses an auto-marked Pass-1 row", async () => {
    seedPass1Pair(db);

    // Trigger the auto-mark via detect's re-run
    await harness.client.callTool({
      name: "detect_internal_transfers",
      arguments: { start: "2026-05-09", end: "2026-05-11" },
    });
    expect(db.select().from(internalTransfers).all()).toHaveLength(1);

    const unmark = (await harness.client.callTool({
      name: "unmark_internal_transfer",
      arguments: { transactionIds: ["p1_credit"] },
    })) as CallResult;
    expect(unmark.structuredContent).toEqual({ unmarked: 1 });
    expect(db.select().from(internalTransfers).all()).toHaveLength(0);
  });

  it("propagates a thrown error as an MCP tool error", async () => {
    const result = (await harness.client.callTool({
      name: "mark_internal_transfer",
      arguments: {},
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? "").toMatch(/requires/);
  });
});
