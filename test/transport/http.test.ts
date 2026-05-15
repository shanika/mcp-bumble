import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import {
  createHttpApp,
  parseHttpConfigFromEnv,
} from "../../src/transport/http.js";
import type { AppDatabase } from "../../src/db/index.js";
import { createTestDatabase, disposeTestDatabase } from "../db/setup.js";

const ISSUER = "http://127.0.0.1/";
const RESOURCE = "http://127.0.0.1/mcp";
const ADMIN_PASSWORD = "letmein";

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function pkcePair() {
  const verifier = base64url(Buffer.from(`verifier-${Math.random()}`));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

interface Harness {
  baseUrl: string;
  db: AppDatabase;
  close: () => Promise<void>;
}

async function startServer(): Promise<Harness> {
  const db = createTestDatabase();
  const config = {
    issuer: ISSUER,
    adminPassword: ADMIN_PASSWORD,
    port: 0,
    host: "127.0.0.1",
  };
  const { app, close: closeApp } = createHttpApp(config, db);
  const server = await new Promise<import("node:http").Server>(
    (resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", (err?: Error) => {
        if (err) reject(err);
        else resolve(s);
      });
    },
  );
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = async (): Promise<void> => {
    closeApp();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    disposeTestDatabase(db);
  };
  return { baseUrl, db, close };
}

async function registerClient(baseUrl: string) {
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test",
      redirect_uris: ["http://localhost:9999/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string };
}

async function obtainCode(
  baseUrl: string,
  clientId: string,
  challenge: string,
): Promise<string> {
  const url = new URL(`${baseUrl}/authorize`);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://localhost:9999/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
    state: "xyz",
    resource: RESOURCE,
    password: ADMIN_PASSWORD,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    redirect: "manual",
  });
  expect([302, 303]).toContain(res.status);
  const location = res.headers.get("location")!;
  const code = new URL(location).searchParams.get("code");
  expect(code).toBeTruthy();
  return code!;
}

async function exchangeCode(
  baseUrl: string,
  clientId: string,
  code: string,
  verifier: string,
  resource: string = RESOURCE,
): Promise<Response> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: "http://localhost:9999/cb",
    code_verifier: verifier,
    resource,
  });
  return fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

describe("parseHttpConfigFromEnv", () => {
  it("reads required and optional vars", () => {
    const config = parseHttpConfigFromEnv({
      OAUTH_ISSUER: "https://b.example",
      OAUTH_ADMIN_PASSWORD: "pw",
      BUMBLE_HTTP_PORT: "4000",
      OAUTH_DATA_FILE: "/tmp/x.json",
      BUMBLE_HTTP_HOST: "0.0.0.0",
      BUMBLE_HTTP_ALLOWED_HOSTS: "a.example,b.example, ",
    });
    expect(config).toEqual({
      issuer: "https://b.example",
      adminPassword: "pw",
      port: 4000,
      oauthDataFile: "/tmp/x.json",
      host: "0.0.0.0",
      allowedHosts: ["a.example", "b.example"],
    });
  });

  it("defaults port to 3001 and omits optional fields", () => {
    const config = parseHttpConfigFromEnv({
      OAUTH_ISSUER: "https://b.example",
      OAUTH_ADMIN_PASSWORD: "pw",
    });
    expect(config.port).toBe(3001);
    expect(config.oauthDataFile).toBeUndefined();
    expect(config.host).toBeUndefined();
    expect(config.allowedHosts).toBeUndefined();
  });

  it("throws when OAUTH_ISSUER is missing", () => {
    expect(() =>
      parseHttpConfigFromEnv({ OAUTH_ADMIN_PASSWORD: "pw" }),
    ).toThrow(/OAUTH_ISSUER/);
  });

  it("throws when OAUTH_ADMIN_PASSWORD is missing", () => {
    expect(() =>
      parseHttpConfigFromEnv({ OAUTH_ISSUER: "https://b.example" }),
    ).toThrow(/OAUTH_ADMIN_PASSWORD/);
  });

  it("throws when BUMBLE_HTTP_PORT is not a number", () => {
    expect(() =>
      parseHttpConfigFromEnv({
        OAUTH_ISSUER: "https://b.example",
        OAUTH_ADMIN_PASSWORD: "pw",
        BUMBLE_HTTP_PORT: "abc",
      }),
    ).toThrow(/BUMBLE_HTTP_PORT/);
  });
});

describe("HTTP transport (live server)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startServer();
  });

  afterEach(async () => {
    await h.close();
  });

  it("serves /.well-known/oauth-authorization-server with our endpoints", async () => {
    const res = await fetch(
      `${h.baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(ISSUER);
    expect(meta.authorization_endpoint).toBe(`${ISSUER}authorize`);
    expect(meta.token_endpoint).toBe(`${ISSUER}token`);
    expect(meta.code_challenge_methods_supported).toContain("S256");
    expect(meta.scopes_supported).toContain("mcp");
  });

  it("serves PRM at the /mcp path-specific URL with resource set to .../mcp", async () => {
    // RFC 9728: PRM is mounted at /.well-known/oauth-protected-resource<rsPath>
    const res = await fetch(
      `${h.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.resource).toBe(RESOURCE);
    expect(meta.authorization_servers).toEqual([ISSUER]);
    expect(meta.scopes_supported).toEqual(["mcp"]);
  });

  it("registers a client and returns a UUID client_id", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    expect(client_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("renders the consent page on GET /authorize", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    const { challenge } = pkcePair();
    const url = new URL(`${h.baseUrl}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client_id);
    url.searchParams.set("redirect_uri", "http://localhost:9999/cb");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("scope", "mcp");
    url.searchParams.set("resource", RESOURCE);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("Authorize Bumble");
  });

  it("requires a Bearer token on /mcp (no auth → 401 with WWW-Authenticate that points at a real PRM URL)", async () => {
    const res = await fetch(`${h.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
    const www = res.headers.get("www-authenticate") ?? "";
    expect(www).toMatch(/Bearer/);
    // Regression guard for FAM-266: resource_metadata must point to a URL
    // that actually serves the PRM. Previously it advertised
    // /.well-known/oauth-protected-resource/mcp but the PRM was only at
    // /.well-known/oauth-protected-resource — Claude's connector flow followed
    // the dead URL and failed with ofid_…
    const match = www.match(/resource_metadata="([^"]+)"/);
    expect(match).toBeTruthy();
    // The hinted PRM URL is built from the configured issuer (no test port), so
    // we re-host it against the test server before fetching.
    const hinted = new URL(match![1]!);
    const prm = await fetch(`${h.baseUrl}${hinted.pathname}`);
    expect(prm.status).toBe(200);
  });

  it("rejects an invalid Bearer token with 401", async () => {
    const res = await fetch(`${h.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer not-a-real-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(401);
  });

  it("completes the full OAuth flow with PKCE and accepts the access token at /mcp", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    const { verifier, challenge } = pkcePair();
    const code = await obtainCode(h.baseUrl, client_id, challenge);
    const tokenRes = await exchangeCode(h.baseUrl, client_id, code, verifier);
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.scope).toBe("mcp");
    expect(tokens.expires_in).toBeGreaterThan(0);

    // Initialize an MCP session with this access token.
    const initRes = await fetch(`${h.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.1" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("rejects a PKCE verifier mismatch at /token", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    const { challenge } = pkcePair();
    const code = await obtainCode(h.baseUrl, client_id, challenge);
    const tokenRes = await exchangeCode(
      h.baseUrl,
      client_id,
      code,
      "wrong-verifier",
    );
    expect(tokenRes.status).toBe(400);
    const err = (await tokenRes.json()) as Record<string, unknown>;
    expect(err.error).toBe("invalid_grant");
  });

  it("rejects a replayed authorization code", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    const { verifier, challenge } = pkcePair();
    const code = await obtainCode(h.baseUrl, client_id, challenge);
    const first = await exchangeCode(h.baseUrl, client_id, code, verifier);
    expect(first.status).toBe(200);
    const second = await exchangeCode(h.baseUrl, client_id, code, verifier);
    expect(second.status).toBe(400);
    const err = (await second.json()) as Record<string, unknown>;
    expect(err.error).toBe("invalid_grant");
  });

  it("rejects a token-exchange with a wrong audience (resource)", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    const { verifier, challenge } = pkcePair();
    const code = await obtainCode(h.baseUrl, client_id, challenge);
    const res = await exchangeCode(
      h.baseUrl,
      client_id,
      code,
      verifier,
      "https://attacker.example",
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as Record<string, unknown>;
    expect(err.error).toBe("invalid_grant");
  });

  it("rejects a malformed token request (no grant_type)", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    const res = await fetch(`${h.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id }).toString(),
    });
    expect(res.status).toBe(400);
  });

  it("issues a fresh access token on refresh and rotates the refresh token", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    const { verifier, challenge } = pkcePair();
    const code = await obtainCode(h.baseUrl, client_id, challenge);
    const tokenRes = await exchangeCode(h.baseUrl, client_id, code, verifier);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
    };

    const refreshRes = await fetch(`${h.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id,
        resource: RESOURCE,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const next = (await refreshRes.json()) as {
      access_token: string;
      refresh_token: string;
    };
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(next.refresh_token).not.toBe(tokens.refresh_token);

    // Old refresh token must be invalid now.
    const replay = await fetch(`${h.baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id,
        resource: RESOURCE,
      }).toString(),
    });
    expect(replay.status).toBe(400);
  });

  it("requires a valid session ID on DELETE /mcp", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    const { verifier, challenge } = pkcePair();
    const code = await obtainCode(h.baseUrl, client_id, challenge);
    const tokenRes = await exchangeCode(h.baseUrl, client_id, code, verifier);
    const tokens = (await tokenRes.json()) as { access_token: string };

    const res = await fetch(`${h.baseUrl}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/session/i);
  });

  it("requires a valid session ID on GET /mcp", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    const { verifier, challenge } = pkcePair();
    const code = await obtainCode(h.baseUrl, client_id, challenge);
    const tokenRes = await exchangeCode(h.baseUrl, client_id, code, verifier);
    const tokens = (await tokenRes.json()) as { access_token: string };

    const res = await fetch(`${h.baseUrl}/mcp`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/session/i);
  });

  it("rejects an unknown session ID on POST /mcp with 400", async () => {
    const { client_id } = await registerClient(h.baseUrl);
    const { verifier, challenge } = pkcePair();
    const code = await obtainCode(h.baseUrl, client_id, challenge);
    const tokenRes = await exchangeCode(h.baseUrl, client_id, code, verifier);
    const tokens = (await tokenRes.json()) as { access_token: string };

    const res = await fetch(`${h.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tokens.access_token}`,
        "mcp-session-id": "nonexistent",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.error as Record<string, unknown>)?.code).toBe(-32000);
  });
});
