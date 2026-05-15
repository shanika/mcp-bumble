import { describe, expect, it } from "vitest";

import {
  BumbleAkahuClient,
  buildAkahuClientFromEnv,
} from "../../src/akahu/client.js";
import { ACCOUNTS_TTL_MS, BALANCES_TTL_MS } from "../../src/lib/cache.js";
import {
  FIXTURE_ACCOUNTS,
  createStubAkahu,
  makeTx,
} from "../fixtures/akahu.js";

function withClock(initial = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let v = initial;
  return { now: () => v, advance: (ms) => (v += ms) };
}

describe("BumbleAkahuClient.listAccounts", () => {
  it("hits the SDK on first call and caches the result", async () => {
    const stub = createStubAkahu();
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });

    const first = await client.listAccounts();
    const second = await client.listAccounts();

    expect(first).toHaveLength(FIXTURE_ACCOUNTS.length);
    expect(second).toEqual(first);
    expect(stub.calls.accounts).toBe(1);
  });

  it("refetches once the accounts TTL elapses", async () => {
    const stub = createStubAkahu();
    const clock = withClock();
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
      clock: clock.now,
    });

    await client.listAccounts();
    clock.advance(ACCOUNTS_TTL_MS + 1);
    await client.listAccounts();

    expect(stub.calls.accounts).toBe(2);
  });

  it("force=true bypasses the cache", async () => {
    const stub = createStubAkahu();
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });

    await client.listAccounts();
    await client.listAccounts({ force: true });
    expect(stub.calls.accounts).toBe(2);
  });
});

describe("BumbleAkahuClient.getBalances", () => {
  it("uses the 5-minute balance TTL independent of accounts TTL", async () => {
    const stub = createStubAkahu();
    const clock = withClock();
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
      clock: clock.now,
    });

    await client.getBalances();
    clock.advance(BALANCES_TTL_MS + 1);
    await client.getBalances();

    expect(stub.calls.accounts).toBe(2);
  });

  it("primes the accounts cache so a follow-up listAccounts() does not refetch", async () => {
    const stub = createStubAkahu();
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });

    await client.getBalances();
    await client.listAccounts();
    expect(stub.calls.accounts).toBe(1);
  });

  it("force=true bypasses the balance cache", async () => {
    const stub = createStubAkahu();
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });
    await client.getBalances();
    await client.getBalances({ force: true });
    expect(stub.calls.accounts).toBe(2);
  });
});

describe("BumbleAkahuClient.listAllTransactions", () => {
  it("loops pages until cursor.next === null", async () => {
    const tx1 = makeTx({
      id: "trans_1",
      account: "acc_anz_go",
      date: "2026-05-01T00:00:00Z",
      amount: -10,
      type: "DEBIT",
      description: "A",
    });
    const tx2 = makeTx({
      id: "trans_2",
      account: "acc_anz_go",
      date: "2026-05-02T00:00:00Z",
      amount: -20,
      type: "DEBIT",
      description: "B",
    });
    const tx3 = makeTx({
      id: "trans_3",
      account: "acc_anz_go",
      date: "2026-05-03T00:00:00Z",
      amount: -30,
      type: "DEBIT",
      description: "C",
    });

    const stub = createStubAkahu({
      transactionPages: [[tx1, tx2], [tx3]],
    });
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });

    const items = await client.listAllTransactions({
      start: "2026-04-30",
    });

    expect(items.map((t) => t._id)).toEqual(["trans_1", "trans_2", "trans_3"]);
    expect(stub.calls.transactions).toHaveLength(2);
    expect(stub.calls.transactions[0]).toMatchObject({ start: "2026-04-30" });
    expect(stub.calls.transactions[1]).toMatchObject({
      start: "2026-04-30",
      cursor: "cursor_1",
    });
  });

  it("returns an empty list when the first page is empty", async () => {
    const stub = createStubAkahu({ transactionPages: [[]] });
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });
    const items = await client.listAllTransactions();
    expect(items).toEqual([]);
  });

  it("passes start+end query params through", async () => {
    const stub = createStubAkahu({ transactionPages: [[]] });
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });
    await client.listAllTransactions({
      start: "2026-05-01",
      end: "2026-05-10",
    });
    expect(stub.calls.transactions[0]).toMatchObject({
      start: "2026-05-01",
      end: "2026-05-10",
    });
  });
});

describe("BumbleAkahuClient.resetCaches", () => {
  it("clears both caches", async () => {
    const stub = createStubAkahu();
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });
    await client.listAccounts();
    client.resetCaches();
    await client.listAccounts();
    expect(stub.calls.accounts).toBe(2);
  });
});

describe("BumbleAkahuClient.refresh", () => {
  it("calls refreshAll when no accountId is given", async () => {
    const stub = createStubAkahu();
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });
    await client.refresh();
    expect(stub.calls.refreshAll).toBe(1);
    expect(stub.calls.refresh).toHaveLength(0);
  });

  it("calls refresh with the given accountId", async () => {
    const stub = createStubAkahu();
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });
    await client.refresh({ accountId: "acc_anz_go" });
    expect(stub.calls.refresh).toEqual([{ accountId: "acc_anz_go" }]);
    expect(stub.calls.refreshAll).toBe(0);
  });

  it("propagates errors from the underlying SDK", async () => {
    const stub = createStubAkahu();
    stub.accounts.refreshAll = async () => {
      throw new Error("akahu down");
    };
    const client = new BumbleAkahuClient({
      credentials: { appToken: "a", userToken: "u" },
      client: stub,
    });
    await expect(client.refresh()).rejects.toThrow("akahu down");
  });
});

describe("buildAkahuClientFromEnv", () => {
  it("returns a client when both tokens are present", () => {
    const client = buildAkahuClientFromEnv({
      AKAHU_APP_TOKEN: "app_token_test",
      AKAHU_USER_TOKEN: "user_token_test",
    });
    expect(client).toBeInstanceOf(BumbleAkahuClient);
  });

  it("returns undefined when AKAHU_APP_TOKEN is missing", () => {
    expect(
      buildAkahuClientFromEnv({ AKAHU_USER_TOKEN: "user" }),
    ).toBeUndefined();
  });

  it("returns undefined when AKAHU_USER_TOKEN is missing", () => {
    expect(
      buildAkahuClientFromEnv({ AKAHU_APP_TOKEN: "app" }),
    ).toBeUndefined();
  });

  it("returns undefined when both are blank", () => {
    expect(
      buildAkahuClientFromEnv({ AKAHU_APP_TOKEN: "", AKAHU_USER_TOKEN: "" }),
    ).toBeUndefined();
  });
});
