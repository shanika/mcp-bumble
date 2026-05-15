import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BumbleAkahuClient } from "../../src/akahu/client.js";
import type { AppDatabase } from "../../src/db/index.js";
import type { SyncResult } from "../../src/akahu/sync.js";
import { registerSyncTools } from "../../src/tools/sync.js";
import { createTestDatabase, disposeTestDatabase } from "../db/setup.js";
import { createStubAkahu } from "../fixtures/akahu.js";

interface CallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

interface Harness {
  client: Client;
  dispose: () => Promise<void>;
}

interface HarnessOptions {
  akahuClient?: BumbleAkahuClient;
  runSync?: typeof import("../../src/akahu/sync.js").runSync;
}

async function createHarness(
  db: AppDatabase,
  opts: HarnessOptions = {},
): Promise<Harness> {
  const server = new McpServer({ name: "test-bumble", version: "0.0.0" });
  registerSyncTools(
    server,
    db,
    opts.akahuClient,
    opts.runSync ? { runSync: opts.runSync } : {},
  );

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

function buildAkahuClient(
  stub: ReturnType<typeof createStubAkahu>,
): BumbleAkahuClient {
  return new BumbleAkahuClient({
    credentials: { appToken: "a", userToken: "u" },
    client: stub,
  });
}

function fakeSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    runId: "run_test",
    status: "ok",
    startedAt: "2026-05-14T10:00:00.000Z",
    finishedAt: "2026-05-14T10:00:01.000Z",
    fetchedFrom: "2026-05-13T10:00:00.000Z",
    transactionsImported: 7,
    transfersAutoMarked: 1,
    transfersSuggested: 0,
    autoCategorized: 5,
    residualUncategorized: 1,
    ...overrides,
  };
}

describe("sync + refresh tools via MCP SDK transport", () => {
  let db: AppDatabase;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    disposeTestDatabase(db);
  });

  it("advertises both tools in listTools when an Akahu client is wired in", async () => {
    const harness = await createHarness(db, {
      akahuClient: buildAkahuClient(createStubAkahu()),
    });
    try {
      const tools = await harness.client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(["refresh", "sync"]);
    } finally {
      await harness.dispose();
    }
  });

  it("still advertises both tools when no Akahu client is wired in", async () => {
    const harness = await createHarness(db);
    try {
      const tools = await harness.client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(["refresh", "sync"]);
    } finally {
      await harness.dispose();
    }
  });

  it("refresh returns ok via structured content on the happy path", async () => {
    const stub = createStubAkahu();
    const harness = await createHarness(db, {
      akahuClient: buildAkahuClient(stub),
    });
    try {
      const result = (await harness.client.callTool({
        name: "refresh",
        arguments: {},
      })) as CallResult;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ status: "ok" });
      expect(stub.calls.refreshAll).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("refresh forwards accountId to the per-account endpoint", async () => {
    const stub = createStubAkahu();
    const harness = await createHarness(db, {
      akahuClient: buildAkahuClient(stub),
    });
    try {
      const result = (await harness.client.callTool({
        name: "refresh",
        arguments: { accountId: "acc_anz_go" },
      })) as CallResult;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ status: "ok" });
      expect(stub.calls.refresh).toEqual([{ accountId: "acc_anz_go" }]);
      expect(stub.calls.refreshAll).toBe(0);
    } finally {
      await harness.dispose();
    }
  });

  it("refresh surfaces a 429 cooldown with remaining seconds", async () => {
    const stub = createStubAkahu();
    stub.accounts.refreshAll = async () => {
      const err = new Error("cooldown") as Error & {
        status: number;
        isAkahuError: true;
        response: { headers: Record<string, unknown> };
      };
      err.status = 429;
      err.isAkahuError = true;
      err.response = { headers: { "retry-after": "300" } };
      throw err;
    };
    const harness = await createHarness(db, {
      akahuClient: buildAkahuClient(stub),
    });
    try {
      const result = (await harness.client.callTool({
        name: "refresh",
        arguments: {},
      })) as CallResult;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        status: "cooldown",
        cooldownRemaining: 300,
      });
    } finally {
      await harness.dispose();
    }
  });

  it("refresh returns isError when no Akahu client is configured", async () => {
    const harness = await createHarness(db);
    try {
      const result = (await harness.client.callTool({
        name: "refresh",
        arguments: {},
      })) as CallResult;

      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(
        /AKAHU_APP_TOKEN and AKAHU_USER_TOKEN/,
      );
    } finally {
      await harness.dispose();
    }
  });

  it("sync returns the renamed summary on a successful run", async () => {
    const runSyncSpy = vi.fn(async () => fakeSyncResult());
    const harness = await createHarness(db, {
      akahuClient: buildAkahuClient(createStubAkahu()),
      runSync: runSyncSpy,
    });
    try {
      const result = (await harness.client.callTool({
        name: "sync",
        arguments: {},
      })) as CallResult;

      expect(result.isError).toBeFalsy();
      expect(runSyncSpy).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toMatchObject({
        status: "ok",
        runId: "run_test",
        imported: 7,
        autoMarkedTransfers: 1,
        pendingSuggestions: 0,
        autoCategorised: 5,
        residualUncategorised: 1,
      });
      expect(result.structuredContent).not.toHaveProperty("error");
    } finally {
      await harness.dispose();
    }
  });

  it("sync surfaces a failed result with the error message preserved", async () => {
    const runSyncSpy = vi.fn(async () =>
      fakeSyncResult({ status: "failed", error: "akahu 503" }),
    );
    const harness = await createHarness(db, {
      akahuClient: buildAkahuClient(createStubAkahu()),
      runSync: runSyncSpy,
    });
    try {
      const result = (await harness.client.callTool({
        name: "sync",
        arguments: {},
      })) as CallResult;

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        status: "failed",
        error: "akahu 503",
      });
    } finally {
      await harness.dispose();
    }
  });

  it("sync returns isError when no Akahu client is configured", async () => {
    const runSyncSpy = vi.fn();
    const harness = await createHarness(db, { runSync: runSyncSpy });
    try {
      const result = (await harness.client.callTool({
        name: "sync",
        arguments: {},
      })) as CallResult;

      expect(result.isError).toBe(true);
      expect(runSyncSpy).not.toHaveBeenCalled();
      expect(result.content?.[0]?.text).toMatch(
        /AKAHU_APP_TOKEN and AKAHU_USER_TOKEN/,
      );
    } finally {
      await harness.dispose();
    }
  });
});
