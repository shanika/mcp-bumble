import { describe, expect, it } from "vitest";

import {
  ACCOUNTS_TTL_MS,
  BALANCES_TTL_MS,
  TTLCache,
} from "../../src/lib/cache.js";

function makeClock(initial = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let value = initial;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
  };
}

describe("TTLCache", () => {
  it("returns set values within the TTL window", () => {
    const clock = makeClock();
    const cache = new TTLCache<string>({ ttlMs: 1000, clock: clock.now });
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    expect(cache.has("k")).toBe(true);
    expect(cache.size()).toBe(1);
  });

  it("expires entries once the clock advances past TTL", () => {
    const clock = makeClock();
    const cache = new TTLCache<string>({ ttlMs: 1000, clock: clock.now });
    cache.set("k", "v");
    clock.advance(999);
    expect(cache.get("k")).toBe("v");
    clock.advance(2);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.has("k")).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("treats unknown keys as misses", () => {
    const cache = new TTLCache<number>({ ttlMs: 1000 });
    expect(cache.get("missing")).toBeUndefined();
  });

  it("supports delete and clear", () => {
    const cache = new TTLCache<number>({ ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("uses Date.now() by default", () => {
    const cache = new TTLCache<number>({ ttlMs: 1000 });
    cache.set("k", 1);
    expect(cache.get("k")).toBe(1);
  });

  it("exposes the spec'd default TTL constants", () => {
    expect(ACCOUNTS_TTL_MS).toBe(60 * 60 * 1000);
    expect(BALANCES_TTL_MS).toBe(5 * 60 * 1000);
  });
});
