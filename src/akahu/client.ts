import { AkahuClient } from "akahu";
import type {
  Account,
  Cursor,
  Paginated,
  Transaction,
  TransactionQueryParams,
} from "akahu";

import {
  ACCOUNTS_TTL_MS,
  BALANCES_TTL_MS,
  TTLCache,
  type Clock,
} from "../lib/cache.js";

/** Subset of the Akahu SDK surface that Bumble actually depends on. */
export interface AkahuLike {
  accounts: {
    list(userToken: string): Promise<Account[]>;
    refresh(userToken: string, accountId: string): Promise<void>;
    refreshAll(userToken: string): Promise<void>;
  };
  transactions: {
    list(
      userToken: string,
      query?: TransactionQueryParams,
    ): Promise<Paginated<Transaction>>;
  };
}

export interface AkahuCredentials {
  appToken: string;
  userToken: string;
}

export interface BumbleAkahuClientOptions {
  credentials: AkahuCredentials;
  /** Injectable for tests. Defaults to a real `new AkahuClient({ appToken })`. */
  client?: AkahuLike;
  /** Override the time source for cache TTL testing. */
  clock?: Clock;
}

export interface ListTransactionsRange {
  start?: string;
  end?: string;
}

const ACCOUNTS_CACHE_KEY = "accounts";
const BALANCES_CACHE_KEY = "balances";

function defaultClient(credentials: AkahuCredentials): AkahuLike {
  return new AkahuClient({ appToken: credentials.appToken }) as AkahuLike;
}

/**
 * Thin wrapper around the official `akahu` SDK. Adds:
 *  - Implicit `userToken` so callers don't pass it on every method.
 *  - A pagination helper that loops until `cursor.next === null` (spec §4).
 *  - Per-session TTL caches for accounts (1h) and balances (5m) per spec §4.1.
 */
export class BumbleAkahuClient {
  private readonly client: AkahuLike;
  private readonly userToken: string;
  private readonly accountsCache: TTLCache<Account[]>;
  private readonly balancesCache: TTLCache<Account[]>;

  constructor(options: BumbleAkahuClientOptions) {
    this.client = options.client ?? defaultClient(options.credentials);
    this.userToken = options.credentials.userToken;
    this.accountsCache = new TTLCache<Account[]>({
      ttlMs: ACCOUNTS_TTL_MS,
      clock: options.clock,
    });
    this.balancesCache = new TTLCache<Account[]>({
      ttlMs: BALANCES_TTL_MS,
      clock: options.clock,
    });
  }

  /** Returns the full account list, cached for 1 hour per spec §4.1. */
  async listAccounts(options: { force?: boolean } = {}): Promise<Account[]> {
    if (!options.force) {
      const cached = this.accountsCache.get(ACCOUNTS_CACHE_KEY);
      if (cached) return cached;
    }
    const accounts = await this.client.accounts.list(this.userToken);
    this.accountsCache.set(ACCOUNTS_CACHE_KEY, accounts);
    this.balancesCache.set(BALANCES_CACHE_KEY, accounts);
    return accounts;
  }

  /**
   * Returns the latest account snapshot with balances refreshed if the
   * 5-minute balance TTL has expired (spec §4.1). The underlying call is the
   * same `/v1/accounts` endpoint — Akahu doesn't have a balance-only call —
   * so the two caches just gate refresh frequency.
   */
  async getBalances(options: { force?: boolean } = {}): Promise<Account[]> {
    if (!options.force) {
      const cached = this.balancesCache.get(BALANCES_CACHE_KEY);
      if (cached) return cached;
    }
    const accounts = await this.client.accounts.list(this.userToken);
    this.balancesCache.set(BALANCES_CACHE_KEY, accounts);
    this.accountsCache.set(ACCOUNTS_CACHE_KEY, accounts);
    return accounts;
  }

  /**
   * Fetches every transaction in the given range, paginating until
   * `cursor.next === null`. Returns the full flattened list — this is the
   * only call pattern the nightly sync uses, so callers don't have to
   * cursor manage themselves.
   */
  async listAllTransactions(
    range: ListTransactionsRange = {},
  ): Promise<Transaction[]> {
    const collected: Transaction[] = [];
    let cursor: Cursor;
    do {
      const query: TransactionQueryParams = {
        ...(range.start !== undefined ? { start: range.start } : {}),
        ...(range.end !== undefined ? { end: range.end } : {}),
        ...(cursor !== undefined && cursor !== null ? { cursor } : {}),
      };
      const page = await this.client.transactions.list(this.userToken, query);
      collected.push(...page.items);
      cursor = page.cursor.next;
    } while (cursor !== null);
    return collected;
  }

  /** Clears all in-memory caches. Primarily used after a forced refresh. */
  resetCaches(): void {
    this.accountsCache.clear();
    this.balancesCache.clear();
  }

  /**
   * Asks Akahu to repull data from the bank. Subject to Akahu's 15-minute
   * per-account cooldown — callers should expect a 429 (`AkahuErrorResponse`
   * with `status: 429`) when invoked too soon after the previous refresh.
   * Pass `accountId` to refresh a single account, or omit to refresh every
   * account linked to this user token.
   */
  async refresh(options: { accountId?: string } = {}): Promise<void> {
    if (options.accountId) {
      await this.client.accounts.refresh(this.userToken, options.accountId);
    } else {
      await this.client.accounts.refreshAll(this.userToken);
    }
  }
}

/**
 * Builds a `BumbleAkahuClient` from environment variables, or returns
 * `undefined` when either token is missing. Used by the MCP transports so the
 * server can boot for read-only use without Akahu credentials.
 */
export function buildAkahuClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BumbleAkahuClient | undefined {
  const appToken = env.AKAHU_APP_TOKEN;
  const userToken = env.AKAHU_USER_TOKEN;
  if (!appToken || !userToken) return undefined;
  return new BumbleAkahuClient({ credentials: { appToken, userToken } });
}
