import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";

import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";

import {
  AUTH_CODE_TTL_SEC,
  BumbleOAuthProvider,
} from "../../src/oauth/provider.js";
import { OAuthStore, hashToken } from "../../src/oauth/storage.js";

const RESOURCE = "https://bumble.example/";
const ADMIN_PASSWORD = "hunter2";

function buildProvider(
  opts: {
    now?: () => number;
    accessTokenTtlSec?: number;
    refreshTokenTtlSec?: number;
  } = {},
) {
  const store = new OAuthStore({ now: opts.now });
  const provider = new BumbleOAuthProvider({
    store,
    resource: RESOURCE,
    adminPassword: ADMIN_PASSWORD,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.accessTokenTtlSec !== undefined
      ? { accessTokenTtlSec: opts.accessTokenTtlSec }
      : {}),
    ...(opts.refreshTokenTtlSec !== undefined
      ? { refreshTokenTtlSec: opts.refreshTokenTtlSec }
      : {}),
  });
  return { store, provider };
}

function makeClient(
  overrides: Partial<OAuthClientInformationFull> = {},
): OAuthClientInformationFull {
  return {
    client_id: "cli-1",
    client_id_issued_at: 1,
    redirect_uris: ["http://localhost:9000/cb"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "Claude",
    ...overrides,
  };
}

function makeRes(method: "GET" | "POST", body?: Record<string, unknown>) {
  const res = {
    req: { method, body },
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    redirect: vi.fn(),
  } as unknown as Response & {
    setHeader: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    redirect: ReturnType<typeof vi.fn>;
  };
  return res;
}

function authParams(
  overrides: Partial<AuthorizationParams> = {},
): AuthorizationParams {
  return {
    codeChallenge: "abc123",
    redirectUri: "http://localhost:9000/cb",
    scopes: ["mcp"],
    state: "s1",
    resource: new URL(RESOURCE),
    ...overrides,
  };
}

describe("BumbleClientsStore", () => {
  it("registers clients with a UUID client_id and persists them", async () => {
    const { provider, store } = buildProvider();
    const registered = await provider.clientsStore.registerClient({
      redirect_uris: ["http://localhost/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect(registered.client_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(registered.client_id_issued_at).toBeGreaterThan(0);
    expect(await provider.clientsStore.getClient(registered.client_id)).toEqual(
      registered,
    );
    expect(store.getClient(registered.client_id)).toEqual(registered);
  });

  it("returns undefined for unknown clients", async () => {
    const { provider } = buildProvider();
    expect(await provider.clientsStore.getClient("missing")).toBeUndefined();
  });
});

describe("authorize()", () => {
  let provider: BumbleOAuthProvider;
  let store: OAuthStore;

  beforeEach(() => {
    ({ provider, store } = buildProvider());
  });

  it("renders the consent page on GET", async () => {
    const client = makeClient();
    const res = makeRes("GET");
    await provider.authorize(client, authParams(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalled();
    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain("Authorize Bumble");
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("re-renders with an error on POST with the wrong password", async () => {
    const client = makeClient();
    const res = makeRes("POST", { password: "wrong" });
    await provider.authorize(client, authParams(), res);
    expect(res.status).toHaveBeenCalledWith(401);
    const html = res.send.mock.calls[0][0] as string;
    expect(html).toContain("Incorrect password.");
    expect(store.snapshot().codes).toEqual({});
  });

  it("issues a code and redirects on POST with the right password", async () => {
    const client = makeClient();
    const res = makeRes("POST", { password: ADMIN_PASSWORD });
    await provider.authorize(client, authParams(), res);
    expect(res.redirect).toHaveBeenCalledTimes(1);
    const target = new URL(res.redirect.mock.calls[0][0] as string);
    expect(target.origin + target.pathname).toBe("http://localhost:9000/cb");
    expect(target.searchParams.get("state")).toBe("s1");
    const code = target.searchParams.get("code");
    expect(code).toBeTruthy();
    const stored = store.getCode(code!);
    expect(stored?.client_id).toBe(client.client_id);
    expect(stored?.code_challenge).toBe("abc123");
    expect(stored?.resource).toBe(RESOURCE);
    expect(stored?.scope).toBe("mcp");
  });

  it("rejects a resource that does not match the canonical URI", async () => {
    const client = makeClient();
    const res = makeRes("POST", { password: ADMIN_PASSWORD });
    await expect(
      provider.authorize(
        client,
        authParams({ resource: new URL("https://attacker.example") }),
        res,
      ),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });
});

describe("challengeForAuthorizationCode()", () => {
  it("returns the stored PKCE challenge", async () => {
    const { provider } = buildProvider();
    const client = makeClient();
    const res = makeRes("POST", { password: ADMIN_PASSWORD });
    await provider.authorize(client, authParams(), res);
    const code = new URL(
      res.redirect.mock.calls[0][0] as string,
    ).searchParams.get("code")!;
    expect(await provider.challengeForAuthorizationCode(client, code)).toBe(
      "abc123",
    );
  });

  it("throws InvalidGrant for an unknown code", async () => {
    const { provider } = buildProvider();
    await expect(
      provider.challengeForAuthorizationCode(makeClient(), "missing"),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("throws InvalidGrant when the code belongs to another client", async () => {
    const { provider } = buildProvider();
    const owner = makeClient({ client_id: "cli-A" });
    const other = makeClient({ client_id: "cli-B" });
    const res = makeRes("POST", { password: ADMIN_PASSWORD });
    await provider.authorize(owner, authParams(), res);
    const code = new URL(
      res.redirect.mock.calls[0][0] as string,
    ).searchParams.get("code")!;
    await expect(
      provider.challengeForAuthorizationCode(other, code),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });
});

describe("exchangeAuthorizationCode()", () => {
  async function mintCode(
    provider: BumbleOAuthProvider,
    client = makeClient(),
  ) {
    const res = makeRes("POST", { password: ADMIN_PASSWORD });
    await provider.authorize(client, authParams(), res);
    return new URL(res.redirect.mock.calls[0][0] as string).searchParams.get(
      "code",
    )!;
  }

  it("returns a Bearer access token + refresh token bound to the resource", async () => {
    const { provider, store } = buildProvider({ accessTokenTtlSec: 900 });
    const client = makeClient();
    const code = await mintCode(provider, client);
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code,
      "verifier",
      "http://localhost:9000/cb",
      new URL(RESOURCE),
    );
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(900);
    expect(tokens.scope).toBe("mcp");
    const accessRecord = store.getAccessToken(hashToken(tokens.access_token));
    expect(accessRecord?.resource).toBe(RESOURCE);
    expect(accessRecord?.client_id).toBe(client.client_id);
    const refreshRecord = store.getRefreshToken(
      hashToken(tokens.refresh_token!),
    );
    expect(refreshRecord?.resource).toBe(RESOURCE);
  });

  it("rejects replay (single-use codes)", async () => {
    const { provider } = buildProvider();
    const client = makeClient();
    const code = await mintCode(provider, client);
    await provider.exchangeAuthorizationCode(client, code);
    await expect(
      provider.exchangeAuthorizationCode(client, code),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects an expired code", async () => {
    let nowMs = 1_700_000_000_000;
    const { provider } = buildProvider({ now: () => nowMs });
    const client = makeClient();
    const code = await mintCode(provider, client);
    nowMs += (AUTH_CODE_TTL_SEC + 1) * 1000;
    await expect(
      provider.exchangeAuthorizationCode(client, code),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects a code presented by a different client", async () => {
    const { provider } = buildProvider();
    const owner = makeClient({ client_id: "cli-A" });
    const other = makeClient({ client_id: "cli-B" });
    const code = await mintCode(provider, owner);
    await expect(
      provider.exchangeAuthorizationCode(other, code),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects a redirect_uri mismatch", async () => {
    const { provider } = buildProvider();
    const client = makeClient();
    const code = await mintCode(provider, client);
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        code,
        "v",
        "http://evil.example/cb",
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects a resource mismatch (audience binding)", async () => {
    const { provider } = buildProvider();
    const client = makeClient();
    const code = await mintCode(provider, client);
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        code,
        "v",
        "http://localhost:9000/cb",
        new URL("https://attacker.example"),
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });
});

describe("exchangeRefreshToken()", () => {
  async function bootstrap() {
    const { provider, store } = buildProvider();
    const client = makeClient();
    const res = makeRes("POST", { password: ADMIN_PASSWORD });
    await provider.authorize(client, authParams(), res);
    const code = new URL(
      res.redirect.mock.calls[0][0] as string,
    ).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    return { provider, store, client, tokens };
  }

  it("rotates: invalidates the old refresh token and returns a new pair", async () => {
    const { provider, store, client, tokens } = await bootstrap();
    const oldHash = hashToken(tokens.refresh_token!);
    expect(store.getRefreshToken(oldHash)).toBeDefined();

    const next = await provider.exchangeRefreshToken(
      client,
      tokens.refresh_token!,
    );
    expect(next.refresh_token).toBeTruthy();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(store.getRefreshToken(oldHash)).toBeUndefined();
    expect(store.getRefreshToken(hashToken(next.refresh_token!))).toBeDefined();
  });

  it("rejects an unknown refresh token", async () => {
    const { provider, client } = await bootstrap();
    await expect(
      provider.exchangeRefreshToken(client, "never-issued"),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects a refresh token issued to another client", async () => {
    const { provider, tokens } = await bootstrap();
    await expect(
      provider.exchangeRefreshToken(
        makeClient({ client_id: "other" }),
        tokens.refresh_token!,
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("rejects a resource mismatch on refresh", async () => {
    const { provider, client, tokens } = await bootstrap();
    await expect(
      provider.exchangeRefreshToken(
        client,
        tokens.refresh_token!,
        undefined,
        new URL("https://attacker.example"),
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it("allows narrowing scope but rejects widening", async () => {
    const { provider, client, tokens } = await bootstrap();
    // Asking for a scope not originally granted → InvalidRequest
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!, ["admin"]),
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("rejects an expired refresh token", async () => {
    let nowMs = 1_700_000_000_000;
    const { provider } = buildProvider({
      now: () => nowMs,
      refreshTokenTtlSec: 10,
    });
    const client = makeClient();
    const res = makeRes("POST", { password: ADMIN_PASSWORD });
    await provider.authorize(client, authParams(), res);
    const code = new URL(
      res.redirect.mock.calls[0][0] as string,
    ).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    nowMs += 60_000;
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });
});

describe("verifyAccessToken()", () => {
  it("returns AuthInfo for a valid token", async () => {
    const { provider } = buildProvider();
    const client = makeClient();
    const res = makeRes("POST", { password: ADMIN_PASSWORD });
    await provider.authorize(client, authParams(), res);
    const code = new URL(
      res.redirect.mock.calls[0][0] as string,
    ).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(client.client_id);
    expect(info.scopes).toEqual(["mcp"]);
    expect(info.resource?.href).toBe(RESOURCE);
  });

  it("rejects an unknown token", async () => {
    const { provider } = buildProvider();
    await expect(
      provider.verifyAccessToken("not-a-real-token"),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects an expired token", async () => {
    let nowMs = 1_700_000_000_000;
    const { provider } = buildProvider({
      now: () => nowMs,
      accessTokenTtlSec: 10,
    });
    const client = makeClient();
    const res = makeRes("POST", { password: ADMIN_PASSWORD });
    await provider.authorize(client, authParams(), res);
    const code = new URL(
      res.redirect.mock.calls[0][0] as string,
    ).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    nowMs += 60_000;
    await expect(
      provider.verifyAccessToken(tokens.access_token),
    ).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it("rejects a token whose stored resource does not match this server", async () => {
    // Manually save a token bound to a different resource to simulate
    // a stolen token from another audience.
    const { provider, store } = buildProvider();
    const fakeToken = "00".repeat(32);
    store.saveAccessToken(hashToken(fakeToken), {
      client_id: "cli-X",
      scope: "mcp",
      resource: "https://attacker.example",
      expires_at: Math.floor(Date.now() / 1000) + 900,
    });
    await expect(provider.verifyAccessToken(fakeToken)).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });
});

describe("revokeToken()", () => {
  async function bootstrap() {
    const { provider, store } = buildProvider();
    const client = makeClient();
    const res = makeRes("POST", { password: ADMIN_PASSWORD });
    await provider.authorize(client, authParams(), res);
    const code = new URL(
      res.redirect.mock.calls[0][0] as string,
    ).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    return { provider, store, client, tokens };
  }

  it("revokes an access token", async () => {
    const { provider, store, client, tokens } = await bootstrap();
    await provider.revokeToken(client, { token: tokens.access_token });
    expect(
      store.getAccessToken(hashToken(tokens.access_token)),
    ).toBeUndefined();
  });

  it("revokes a refresh token", async () => {
    const { provider, store, client, tokens } = await bootstrap();
    await provider.revokeToken(client, { token: tokens.refresh_token! });
    expect(
      store.getRefreshToken(hashToken(tokens.refresh_token!)),
    ).toBeUndefined();
  });

  it("ignores revocation requests from a different client", async () => {
    const { provider, store, tokens } = await bootstrap();
    await provider.revokeToken(makeClient({ client_id: "other" }), {
      token: tokens.access_token,
    });
    expect(store.getAccessToken(hashToken(tokens.access_token))).toBeDefined();
  });

  it("is a no-op for an unknown token", async () => {
    const { provider, client } = await bootstrap();
    await expect(
      provider.revokeToken(client, { token: "ghost" }),
    ).resolves.toBeUndefined();
  });
});
