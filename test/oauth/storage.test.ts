import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OAuthStore,
  generateOpaqueToken,
  hashToken,
} from "../../src/oauth/storage.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

function uniqueTmpFile(): string {
  return path.join(
    tmpdir(),
    `bumble-oauth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

function sampleClient(id = "cli-1"): OAuthClientInformationFull {
  return {
    client_id: id,
    client_id_issued_at: 1_700_000_000,
    redirect_uris: ["http://localhost:9000/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Test Client",
  };
}

describe("hashToken", () => {
  it("returns a deterministic 64-char hex digest", () => {
    const h = hashToken("hello");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).toBe(hashToken("hello"));
    expect(h).not.toBe(hashToken("hellp"));
  });
});

describe("generateOpaqueToken", () => {
  it("produces unique 64-char hex tokens", () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("OAuthStore (in-memory)", () => {
  it("starts empty and round-trips clients", () => {
    const store = new OAuthStore();
    expect(store.getClient("nope")).toBeUndefined();
    const client = sampleClient();
    store.saveClient(client);
    expect(store.getClient("cli-1")).toEqual(client);
  });

  it("returns codes until they expire, and consumes them once", () => {
    let nowMs = 1_700_000_000_000;
    const store = new OAuthStore({ now: () => nowMs });
    store.saveCode("code-1", {
      client_id: "cli-1",
      redirect_uri: "http://localhost/cb",
      code_challenge: "chal",
      code_challenge_method: "S256",
      scope: "mcp",
      resource: "https://bumble.example",
      expires_at: Math.floor(nowMs / 1000) + 60,
      used: false,
    });
    expect(store.getCode("code-1")?.client_id).toBe("cli-1");
    const consumed = store.consumeCode("code-1");
    expect(consumed?.client_id).toBe("cli-1");
    expect(store.getCode("code-1")).toBeUndefined();
    expect(store.consumeCode("code-1")).toBeUndefined();
  });

  it("prunes expired codes on read", () => {
    let nowMs = 1_700_000_000_000;
    const store = new OAuthStore({ now: () => nowMs });
    store.saveCode("code-old", {
      client_id: "cli-1",
      redirect_uri: "http://localhost/cb",
      code_challenge: "chal",
      code_challenge_method: "S256",
      scope: "mcp",
      resource: "https://bumble.example",
      expires_at: Math.floor(nowMs / 1000) + 10,
      used: false,
    });
    nowMs += 20_000;
    expect(store.getCode("code-old")).toBeUndefined();
    expect(store.snapshot().codes["code-old"]).toBeUndefined();
  });

  it("round-trips access and refresh tokens, and deletes them", () => {
    const store = new OAuthStore();
    const now = Math.floor(Date.now() / 1000);
    store.saveAccessToken("ah", {
      client_id: "cli-1",
      scope: "mcp",
      resource: "https://bumble.example",
      expires_at: now + 900,
    });
    store.saveRefreshToken("rh", {
      client_id: "cli-1",
      scope: "mcp",
      resource: "https://bumble.example",
      expires_at: now + 7_776_000,
      granted_at: now,
    });
    expect(store.getAccessToken("ah")?.scope).toBe("mcp");
    expect(store.getRefreshToken("rh")?.scope).toBe("mcp");
    store.deleteAccessToken("ah");
    store.deleteRefreshToken("rh");
    expect(store.getAccessToken("ah")).toBeUndefined();
    expect(store.getRefreshToken("rh")).toBeUndefined();
  });

  it("expires access tokens on read", () => {
    let nowMs = 1_700_000_000_000;
    const store = new OAuthStore({ now: () => nowMs });
    store.saveAccessToken("ah", {
      client_id: "cli-1",
      scope: "mcp",
      resource: "https://bumble.example",
      expires_at: Math.floor(nowMs / 1000) + 5,
    });
    nowMs += 10_000;
    expect(store.getAccessToken("ah")).toBeUndefined();
  });

  it("expires refresh tokens on read", () => {
    let nowMs = 1_700_000_000_000;
    const store = new OAuthStore({ now: () => nowMs });
    store.saveRefreshToken("rh", {
      client_id: "cli-1",
      scope: "mcp",
      resource: "https://bumble.example",
      expires_at: Math.floor(nowMs / 1000) + 5,
      granted_at: Math.floor(nowMs / 1000),
    });
    nowMs += 10_000;
    expect(store.getRefreshToken("rh")).toBeUndefined();
  });

  it("rotateRefreshToken swaps old hash for new in one persist", () => {
    const store = new OAuthStore();
    const now = Math.floor(Date.now() / 1000);
    const record = {
      client_id: "cli-1",
      scope: "mcp",
      resource: "https://bumble.example",
      expires_at: now + 7_776_000,
      granted_at: now,
    };
    store.saveRefreshToken("old", record);
    store.rotateRefreshToken("old", "new", { ...record, granted_at: now + 1 });
    expect(store.getRefreshToken("old")).toBeUndefined();
    expect(store.getRefreshToken("new")?.granted_at).toBe(now + 1);
  });

  it("deletes are no-ops when key is absent", () => {
    const store = new OAuthStore();
    expect(() => store.deleteAccessToken("missing")).not.toThrow();
    expect(() => store.deleteRefreshToken("missing")).not.toThrow();
  });
});

describe("OAuthStore (file-backed)", () => {
  let filePath: string;

  beforeEach(() => {
    filePath = uniqueTmpFile();
  });

  afterEach(() => {
    if (existsSync(filePath)) rmSync(filePath, { force: true });
  });

  it("creates the file with mode 0600 on first write", () => {
    const store = new OAuthStore({ filePath });
    store.saveClient(sampleClient());
    expect(existsSync(filePath)).toBe(true);
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("persists state across instances", () => {
    const a = new OAuthStore({ filePath });
    a.saveClient(sampleClient("cli-A"));
    a.saveAccessToken("ah", {
      client_id: "cli-A",
      scope: "mcp",
      resource: "https://bumble.example",
      expires_at: Math.floor(Date.now() / 1000) + 900,
    });

    const b = new OAuthStore({ filePath });
    expect(b.getClient("cli-A")?.client_name).toBe("Test Client");
    expect(b.getAccessToken("ah")?.client_id).toBe("cli-A");
  });

  it("handles a missing file as empty state", () => {
    const store = new OAuthStore({ filePath });
    expect(store.snapshot()).toEqual({
      clients: {},
      codes: {},
      tokens: {},
      refresh_tokens: {},
    });
  });

  it("treats an empty file as empty state", () => {
    const store = new OAuthStore({ filePath });
    store.saveClient(sampleClient());
    rmSync(filePath, { force: true });
    // Re-create file empty and reload
    const fresh = new OAuthStore({ filePath });
    expect(fresh.snapshot().clients).toEqual({});
  });

  it("prunes expired records during persist", () => {
    let nowMs = 1_700_000_000_000;
    const store = new OAuthStore({ filePath, now: () => nowMs });
    store.saveAccessToken("ah-old", {
      client_id: "cli",
      scope: "mcp",
      resource: "https://bumble.example",
      expires_at: Math.floor(nowMs / 1000) + 5,
    });
    nowMs += 60_000;
    // Trigger a persist that should drop the expired token
    store.saveClient(sampleClient("cli-B"));
    const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
    expect(onDisk.tokens).toEqual({});
    expect(onDisk.clients["cli-B"]).toBeDefined();
  });
});
