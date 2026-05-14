import { randomUUID } from "node:crypto";

import type { Response } from "express";
import {
  InvalidRequestError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { renderConsentPage } from "./consent.js";
import { OAuthStore, generateOpaqueToken, hashToken } from "./storage.js";

/** Default access-token lifetime: 15 minutes (per ADR rev 2). */
export const DEFAULT_ACCESS_TOKEN_TTL_SEC = 15 * 60;
/** Default refresh-token lifetime: 90 days (per ADR rev 2). */
export const DEFAULT_REFRESH_TOKEN_TTL_SEC = 90 * 24 * 60 * 60;
/** Auth code lifetime: 60 seconds, single-use. */
export const AUTH_CODE_TTL_SEC = 60;

export interface BumbleOAuthProviderOptions {
  store: OAuthStore;
  /** Canonical resource URI, e.g. `https://bumble.heycasper.uk`. */
  resource: string;
  /** Admin password gate for the consent page. */
  adminPassword: string;
  /** Override the clock (milliseconds since epoch). */
  now?: () => number;
  /** Override access token TTL in seconds. */
  accessTokenTtlSec?: number;
  /** Override refresh token TTL in seconds. */
  refreshTokenTtlSec?: number;
}

class BumbleClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: OAuthStore) {}

  async getClient(
    clientId: string,
  ): Promise<OAuthClientInformationFull | undefined> {
    return this.store.getClient(clientId);
  }

  async registerClient(
    info: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const client: OAuthClientInformationFull = {
      ...info,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.store.saveClient(client);
    return client;
  }
}

/**
 * Bumble's OAuth 2.1 server provider — implements the MCP SDK's
 * OAuthServerProvider interface against our JSON-file token store.
 *
 * Notable behavior:
 * - The `authorize()` method renders a password-gated consent page on GET (or
 *   on POST without a valid password) and mints an auth code on POST when the
 *   password matches `OAUTH_ADMIN_PASSWORD`.
 * - All issued tokens are bound to a single `resource` (the canonical Bumble
 *   URI) — RFC 8707 audience indicators are validated on every exchange and
 *   on every access-token verification.
 * - Access tokens live 15 minutes; refresh tokens live 90 days and are
 *   rotated on every use per OAuth 2.1.
 */
export class BumbleOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly store: OAuthStore;
  private readonly resource: string;
  private readonly adminPassword: string;
  private readonly now: () => number;
  private readonly accessTokenTtlSec: number;
  private readonly refreshTokenTtlSec: number;

  constructor(options: BumbleOAuthProviderOptions) {
    this.store = options.store;
    // Canonicalize: trailing slash is significant in URL.href comparison.
    this.resource = new URL(options.resource).href;
    this.adminPassword = options.adminPassword;
    this.now = options.now ?? (() => Date.now());
    this.accessTokenTtlSec =
      options.accessTokenTtlSec ?? DEFAULT_ACCESS_TOKEN_TTL_SEC;
    this.refreshTokenTtlSec =
      options.refreshTokenTtlSec ?? DEFAULT_REFRESH_TOKEN_TTL_SEC;
    this.clientsStore = new BumbleClientsStore(this.store);
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.validateResource(params.resource);

    const req = res.req;
    const submittedPassword =
      req?.method === "POST"
        ? (req.body as Record<string, unknown> | undefined)?.["password"]
        : undefined;

    const scope = (params.scopes ?? []).join(" ") || "mcp";
    const consentParams = {
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uri: params.redirectUri,
      response_type: "code",
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      scope,
      state: params.state,
      resource: params.resource?.href,
    } as const;

    if (
      typeof submittedPassword !== "string" ||
      submittedPassword.length === 0
    ) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(renderConsentPage(consentParams));
      return;
    }
    if (submittedPassword !== this.adminPassword) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res
        .status(401)
        .send(
          renderConsentPage({ ...consentParams, error: "Incorrect password." }),
        );
      return;
    }

    const code = generateOpaqueToken();
    this.store.saveCode(code, {
      client_id: client.client_id,
      redirect_uri: params.redirectUri,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
      scope,
      resource: this.resource,
      expires_at: this.nowSec() + AUTH_CODE_TTL_SEC,
      used: false,
    });

    const targetUrl = new URL(params.redirectUri);
    targetUrl.searchParams.set("code", code);
    if (params.state !== undefined) {
      targetUrl.searchParams.set("state", params.state);
    }
    res.redirect(targetUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.store.getCode(authorizationCode);
    if (!record) throw new InvalidGrantError("Invalid authorization code");
    if (record.client_id !== client.client_id) {
      throw new InvalidGrantError(
        "Authorization code was not issued to this client",
      );
    }
    return record.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.store.consumeCode(authorizationCode);
    if (!record) throw new InvalidGrantError("Invalid authorization code");
    if (record.client_id !== client.client_id) {
      throw new InvalidGrantError(
        "Authorization code was not issued to this client",
      );
    }
    if (redirectUri !== undefined && redirectUri !== record.redirect_uri) {
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    if (resource !== undefined && resource.href !== record.resource) {
      throw new InvalidGrantError("resource mismatch");
    }
    return this.issueTokenPair(client.client_id, record.scope, record.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = hashToken(refreshToken);
    const record = this.store.getRefreshToken(hash);
    if (!record) throw new InvalidGrantError("Invalid refresh token");
    if (record.client_id !== client.client_id) {
      throw new InvalidGrantError(
        "Refresh token was not issued to this client",
      );
    }
    if (resource !== undefined && resource.href !== record.resource) {
      throw new InvalidGrantError("resource mismatch");
    }
    // Public clients can narrow scope on refresh, but never widen it.
    if (scopes !== undefined && scopes.length > 0) {
      const granted = new Set(record.scope.split(" ").filter(Boolean));
      for (const s of scopes) {
        if (!granted.has(s)) {
          throw new InvalidRequestError(
            `Scope '${s}' was not originally granted`,
          );
        }
      }
    }
    // Rotate: invalidate the old refresh token immediately.
    this.store.deleteRefreshToken(hash);
    return this.issueTokenPair(
      client.client_id,
      scopes && scopes.length > 0 ? scopes.join(" ") : record.scope,
      record.resource,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getAccessToken(hashToken(token));
    if (!record) throw new InvalidTokenError("Invalid or expired access token");
    if (record.resource !== this.resource) {
      throw new InvalidTokenError("Token is not valid for this resource");
    }
    return {
      token,
      clientId: record.client_id,
      scopes: record.scope.split(" ").filter(Boolean),
      expiresAt: record.expires_at,
      resource: new URL(record.resource),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const hash = hashToken(request.token);
    const access = this.store.getAccessToken(hash);
    if (access) {
      if (access.client_id !== client.client_id) return;
      this.store.deleteAccessToken(hash);
      return;
    }
    const refresh = this.store.getRefreshToken(hash);
    if (refresh) {
      if (refresh.client_id !== client.client_id) return;
      this.store.deleteRefreshToken(hash);
    }
  }

  // --- internals -------------------------------------------------------

  private validateResource(resource?: URL): void {
    if (resource === undefined) return;
    if (resource.href !== this.resource) {
      throw new InvalidRequestError(`Unknown resource: ${resource.href}`);
    }
  }

  private issueTokenPair(
    clientId: string,
    scope: string,
    resource: string,
  ): OAuthTokens {
    const accessToken = generateOpaqueToken();
    const refreshToken = generateOpaqueToken();
    const nowSec = this.nowSec();
    this.store.saveAccessToken(hashToken(accessToken), {
      client_id: clientId,
      scope,
      resource,
      expires_at: nowSec + this.accessTokenTtlSec,
    });
    this.store.saveRefreshToken(hashToken(refreshToken), {
      client_id: clientId,
      scope,
      resource,
      expires_at: nowSec + this.refreshTokenTtlSec,
      granted_at: nowSec,
    });
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSec,
      refresh_token: refreshToken,
      scope,
    };
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }
}
