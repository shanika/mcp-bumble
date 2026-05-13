/**
 * In-memory TTL cache for per-session API response caching.
 *
 * Spec §4.1: accounts → 1 hour, balances → 5 minutes. The cache is
 * per-process; restarting Bumble clears it. The nightly sync upserts
 * authoritative data into SQLite, so cache eviction never causes data loss —
 * worst case, the next call hits Akahu again.
 */

export type Clock = () => number;

export interface TTLCacheOptions {
  /** TTL in milliseconds. Required. */
  ttlMs: number;
  /** Override the time source for testing. Defaults to Date.now. */
  clock?: Clock;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TTLCache<V> {
  private readonly store = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly clock: Clock;

  constructor(options: TTLCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.clock = options.clock ?? Date.now;
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.clock()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    this.store.set(key, { value, expiresAt: this.clock() + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  size(): number {
    return this.store.size;
  }
}

/** Convenience constants matching spec §4.1. */
export const ACCOUNTS_TTL_MS = 60 * 60 * 1000; // 1 hour
export const BALANCES_TTL_MS = 5 * 60 * 1000; // 5 minutes
