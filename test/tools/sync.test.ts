import { describe, expect, it } from "vitest";

import { BumbleAkahuClient } from "../../src/akahu/client.js";
import type { SyncResult } from "../../src/akahu/sync.js";
import { refreshAccounts, summariseSync } from "../../src/tools/sync.js";
import { createStubAkahu } from "../fixtures/akahu.js";

function buildClient(
  stub: ReturnType<typeof createStubAkahu>,
): BumbleAkahuClient {
  return new BumbleAkahuClient({
    credentials: { appToken: "a", userToken: "u" },
    client: stub,
  });
}

interface CooldownErrorOptions {
  retryAfter?: string | number;
  noHeader?: boolean;
}

function makeCooldownError(opts: CooldownErrorOptions = {}): Error & {
  status: number;
  isAkahuError: true;
  response: { headers: Record<string, unknown> };
} {
  const err = new Error("Refresh cooldown active") as Error & {
    status: number;
    isAkahuError: true;
    response: { headers: Record<string, unknown> };
  };
  err.status = 429;
  err.isAkahuError = true;
  const headers: Record<string, unknown> = {};
  if (!opts.noHeader) {
    headers["retry-after"] = opts.retryAfter ?? "847";
  }
  err.response = { headers };
  return err;
}

describe("refreshAccounts", () => {
  it("returns ok and calls refreshAll when no accountId is given", async () => {
    const stub = createStubAkahu();
    const client = buildClient(stub);

    const result = await refreshAccounts(client);

    expect(result).toEqual({ status: "ok" });
    expect(stub.calls.refreshAll).toBe(1);
    expect(stub.calls.refresh).toHaveLength(0);
  });

  it("forwards accountId to the per-account refresh endpoint", async () => {
    const stub = createStubAkahu();
    const client = buildClient(stub);

    const result = await refreshAccounts(client, { accountId: "acc_anz_go" });

    expect(result).toEqual({ status: "ok" });
    expect(stub.calls.refresh).toEqual([{ accountId: "acc_anz_go" }]);
    expect(stub.calls.refreshAll).toBe(0);
  });

  it("returns cooldown + remaining seconds on a 429 with Retry-After", async () => {
    const stub = createStubAkahu();
    stub.accounts.refreshAll = async () => {
      throw makeCooldownError({ retryAfter: "847" });
    };
    const client = buildClient(stub);

    const result = await refreshAccounts(client);

    expect(result).toEqual({ status: "cooldown", cooldownRemaining: 847 });
  });

  it("accepts a numeric Retry-After value", async () => {
    const stub = createStubAkahu();
    stub.accounts.refreshAll = async () => {
      throw makeCooldownError({ retryAfter: 120 });
    };
    const client = buildClient(stub);

    const result = await refreshAccounts(client);

    expect(result).toEqual({ status: "cooldown", cooldownRemaining: 120 });
  });

  it("returns cooldown without remaining seconds when no Retry-After header is set", async () => {
    const stub = createStubAkahu();
    stub.accounts.refreshAll = async () => {
      throw makeCooldownError({ noHeader: true });
    };
    const client = buildClient(stub);

    const result = await refreshAccounts(client);

    expect(result).toEqual({ status: "cooldown" });
  });

  it("rethrows errors that are not 429 cooldowns", async () => {
    const stub = createStubAkahu();
    stub.accounts.refreshAll = async () => {
      throw new Error("akahu 503 service unavailable");
    };
    const client = buildClient(stub);

    await expect(refreshAccounts(client)).rejects.toThrow(
      /akahu 503 service unavailable/,
    );
  });

  it("does not treat unrelated AkahuErrorResponse statuses as cooldowns", async () => {
    const stub = createStubAkahu();
    stub.accounts.refreshAll = async () => {
      const err = new Error("forbidden") as Error & {
        status: number;
        isAkahuError: true;
      };
      err.status = 403;
      err.isAkahuError = true;
      throw err;
    };
    const client = buildClient(stub);

    await expect(refreshAccounts(client)).rejects.toThrow(/forbidden/);
  });
});

describe("summariseSync", () => {
  function makeResult(overrides: Partial<SyncResult> = {}): SyncResult {
    return {
      runId: "run_test",
      status: "ok",
      startedAt: "2026-05-14T10:00:00.000Z",
      finishedAt: "2026-05-14T10:00:01.000Z",
      fetchedFrom: "2026-05-13T10:00:00.000Z",
      transactionsImported: 3,
      transfersAutoMarked: 1,
      transfersSuggested: 2,
      autoCategorized: 4,
      residualUncategorized: 5,
      ...overrides,
    };
  }

  it("renames sync counts to the spec'd MCP shape", () => {
    expect(summariseSync(makeResult())).toEqual({
      status: "ok",
      runId: "run_test",
      imported: 3,
      autoMarkedTransfers: 1,
      pendingSuggestions: 2,
      autoCategorised: 4,
      residualUncategorised: 5,
    });
  });

  it("includes the error string when sync failed", () => {
    expect(
      summariseSync(makeResult({ status: "failed", error: "akahu down" })),
    ).toMatchObject({ status: "failed", error: "akahu down" });
  });

  it("omits the error key on success", () => {
    expect(summariseSync(makeResult())).not.toHaveProperty("error");
  });
});

