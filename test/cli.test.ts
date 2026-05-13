import { describe, expect, it, vi } from "vitest";

import { BumbleAkahuClient } from "../src/akahu/client.js";
import { parseArgs, runCli } from "../src/cli.js";
import { openDatabase } from "../src/db/index.js";
import type { SyncResult } from "../src/akahu/sync.js";
import { createStubAkahu } from "./fixtures/akahu.js";

describe("parseArgs", () => {
  it("returns sync when first arg is sync", () => {
    expect(parseArgs(["sync"])).toEqual({ command: "sync", immediate: false });
  });

  it("flags --now as immediate", () => {
    expect(parseArgs(["sync", "--now"])).toEqual({
      command: "sync",
      immediate: true,
    });
  });

  it("returns help for anything else", () => {
    expect(parseArgs([])).toEqual({ command: "help", immediate: false });
    expect(parseArgs(["foo"])).toEqual({
      command: "help",
      immediate: false,
    });
  });
});

function fakeSyncResult(overrides: Partial<SyncResult> = {}): SyncResult {
  return {
    runId: "run_test",
    status: "ok",
    startedAt: "2026-05-14T10:00:00.000Z",
    finishedAt: "2026-05-14T10:00:01.000Z",
    fetchedFrom: "2026-05-13T10:00:00.000Z",
    transactionsImported: 0,
    transfersAutoMarked: 0,
    transfersSuggested: 0,
    autoCategorized: 0,
    residualUncategorized: 0,
    ...overrides,
  };
}

describe("runCli", () => {
  it("prints help and returns 0 when no subcommand is given", async () => {
    const stdout: string[] = [];
    const code = await runCli([], {
      env: { AKAHU_APP_TOKEN: "a", AKAHU_USER_TOKEN: "u" },
      stdout: (l) => stdout.push(l),
      stderr: () => {},
      openDatabase: (() => {
        throw new Error("should not open db on help path");
      }) as typeof openDatabase,
    });
    expect(code).toBe(0);
    expect(stdout.join("\n")).toMatch(/Usage:/);
  });

  it("exits 2 with a clear error when env vars are missing", async () => {
    const stderr: string[] = [];
    const code = await runCli(["sync"], {
      env: {},
      stdout: () => {},
      stderr: (l) => stderr.push(l),
      openDatabase: (() => {
        throw new Error("should not open db before env check");
      }) as typeof openDatabase,
    });
    expect(code).toBe(2);
    expect(stderr[0]).toMatch(/AKAHU_APP_TOKEN/);
  });

  it("returns 0 and prints summary on a successful sync", async () => {
    const stdout: string[] = [];
    const runSyncSpy = vi.fn(async () => fakeSyncResult());
    const code = await runCli(["sync"], {
      env: { AKAHU_APP_TOKEN: "a", AKAHU_USER_TOKEN: "u" },
      stdout: (l) => stdout.push(l),
      stderr: () => {},
      openDatabase: ((opts) =>
        openDatabase({
          ...(opts ?? {}),
          url: ":memory:",
        })) as typeof openDatabase,
      createClient: () =>
        new BumbleAkahuClient({
          credentials: { appToken: "a", userToken: "u" },
          client: createStubAkahu({ transactionPages: [[]] }),
        }),
      runSync: runSyncSpy,
    });
    expect(code).toBe(0);
    expect(runSyncSpy).toHaveBeenCalled();
    expect(stdout.join("\n")).toMatch(/sync ok/);
  });

  it("returns 1 when the sync result reports failure", async () => {
    const stdout: string[] = [];
    const code = await runCli(["sync", "--now"], {
      env: { AKAHU_APP_TOKEN: "a", AKAHU_USER_TOKEN: "u" },
      stdout: (l) => stdout.push(l),
      stderr: () => {},
      openDatabase: ((opts) =>
        openDatabase({
          ...(opts ?? {}),
          url: ":memory:",
        })) as typeof openDatabase,
      createClient: () =>
        new BumbleAkahuClient({
          credentials: { appToken: "a", userToken: "u" },
          client: createStubAkahu({ transactionPages: [[]] }),
        }),
      runSync: async () => fakeSyncResult({ status: "failed", error: "boom" }),
    });
    expect(code).toBe(1);
    expect(stdout.join("\n")).toMatch(/sync failed/);
    expect(stdout.join("\n")).toMatch(/error: boom/);
  });
});
