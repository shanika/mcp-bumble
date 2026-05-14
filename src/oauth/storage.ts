import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  OAuthStoreShape,
  StoredAccessToken,
  StoredAuthCode,
  StoredRefreshToken,
} from "./types.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const EMPTY_STORE: OAuthStoreShape = {
  clients: {},
  codes: {},
  tokens: {},
  refresh_tokens: {},
};

export interface OAuthStoreOptions {
  /** Path to the JSON file. If undefined, the store is in-memory only (for tests). */
  filePath?: string;
  /** Override the clock — milliseconds since epoch. */
  now?: () => number;
}

/** Returns the sha256 hex digest of an opaque token. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Generates a cryptographically random opaque token (32 bytes → 64 hex chars). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * JSON-file-backed OAuth state store.
 *
 * The whole file is rewritten on every mutating call. This is fine for
 * single-user deployments where writes happen at most every 15 minutes
 * (per refresh cycle). Token records are keyed by sha256 of the opaque
 * token so the raw token never touches disk.
 *
 * Pass `filePath: undefined` for an in-memory store (used by tests).
 */
export class OAuthStore {
  private readonly filePath: string | undefined;
  private readonly now: () => number;
  private state: OAuthStoreShape;

  constructor(options: OAuthStoreOptions = {}) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => Date.now());
    this.state = this.load();
  }

  // --- clients ---------------------------------------------------------

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.state.clients[clientId];
  }

  saveClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    this.state.clients[client.client_id] = client;
    this.persist();
    return client;
  }

  // --- authorization codes --------------------------------------------

  saveCode(code: string, record: StoredAuthCode): void {
    this.state.codes[code] = record;
    this.persist();
  }

  getCode(code: string): StoredAuthCode | undefined {
    const record = this.state.codes[code];
    if (!record) return undefined;
    if (record.expires_at < this.nowSeconds()) {
      delete this.state.codes[code];
      this.persist();
      return undefined;
    }
    return record;
  }

  consumeCode(code: string): StoredAuthCode | undefined {
    const record = this.getCode(code);
    if (!record || record.used) return undefined;
    record.used = true;
    delete this.state.codes[code];
    this.persist();
    return record;
  }

  // --- access tokens --------------------------------------------------

  saveAccessToken(tokenHash: string, record: StoredAccessToken): void {
    this.state.tokens[tokenHash] = record;
    this.persist();
  }

  getAccessToken(tokenHash: string): StoredAccessToken | undefined {
    const record = this.state.tokens[tokenHash];
    if (!record) return undefined;
    if (record.expires_at < this.nowSeconds()) {
      delete this.state.tokens[tokenHash];
      this.persist();
      return undefined;
    }
    return record;
  }

  deleteAccessToken(tokenHash: string): void {
    if (tokenHash in this.state.tokens) {
      delete this.state.tokens[tokenHash];
      this.persist();
    }
  }

  // --- refresh tokens -------------------------------------------------

  saveRefreshToken(tokenHash: string, record: StoredRefreshToken): void {
    this.state.refresh_tokens[tokenHash] = record;
    this.persist();
  }

  getRefreshToken(tokenHash: string): StoredRefreshToken | undefined {
    const record = this.state.refresh_tokens[tokenHash];
    if (!record) return undefined;
    if (record.expires_at < this.nowSeconds()) {
      delete this.state.refresh_tokens[tokenHash];
      this.persist();
      return undefined;
    }
    return record;
  }

  /** Rotates: deletes the old refresh token and saves the new one in a single write. */
  rotateRefreshToken(
    oldHash: string,
    newHash: string,
    record: StoredRefreshToken,
  ): void {
    delete this.state.refresh_tokens[oldHash];
    this.state.refresh_tokens[newHash] = record;
    this.persist();
  }

  deleteRefreshToken(tokenHash: string): void {
    if (tokenHash in this.state.refresh_tokens) {
      delete this.state.refresh_tokens[tokenHash];
      this.persist();
    }
  }

  /** Test helper — returns a copy of the in-memory state. */
  snapshot(): OAuthStoreShape {
    return JSON.parse(JSON.stringify(this.state)) as OAuthStoreShape;
  }

  // --- internals ------------------------------------------------------

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000);
  }

  private load(): OAuthStoreShape {
    if (!this.filePath || !existsSync(this.filePath)) {
      return structuredClone(EMPTY_STORE);
    }
    const raw = readFileSync(this.filePath, "utf-8");
    if (raw.length === 0) return structuredClone(EMPTY_STORE);
    const parsed = JSON.parse(raw) as Partial<OAuthStoreShape>;
    return {
      clients: parsed.clients ?? {},
      codes: parsed.codes ?? {},
      tokens: parsed.tokens ?? {},
      refresh_tokens: parsed.refresh_tokens ?? {},
    };
  }

  private persist(): void {
    this.prune();
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
  }

  /** Drop expired codes/tokens. Called on every persist. */
  private prune(): void {
    const cutoff = this.nowSeconds();
    for (const [k, v] of Object.entries(this.state.codes)) {
      if (v.expires_at < cutoff) delete this.state.codes[k];
    }
    for (const [k, v] of Object.entries(this.state.tokens)) {
      if (v.expires_at < cutoff) delete this.state.tokens[k];
    }
    for (const [k, v] of Object.entries(this.state.refresh_tokens)) {
      if (v.expires_at < cutoff) delete this.state.refresh_tokens[k];
    }
  }
}
