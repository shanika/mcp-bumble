import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface StoredAuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: "S256";
  scope: string;
  resource: string;
  expires_at: number;
  used: boolean;
}

export interface StoredAccessToken {
  client_id: string;
  scope: string;
  resource: string;
  expires_at: number;
}

export interface StoredRefreshToken {
  client_id: string;
  scope: string;
  resource: string;
  expires_at: number;
  granted_at: number;
}

export interface OAuthStoreShape {
  clients: Record<string, OAuthClientInformationFull>;
  codes: Record<string, StoredAuthCode>;
  tokens: Record<string, StoredAccessToken>;
  refresh_tokens: Record<string, StoredRefreshToken>;
}
