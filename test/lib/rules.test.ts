import { describe, expect, it } from "vitest";

import { deriveMerchantKey, findMatchingRule } from "../../src/lib/rules.js";

describe("deriveMerchantKey", () => {
  it("uppercases and trims a non-empty merchantName", () => {
    expect(deriveMerchantKey("Countdown Riccarton", "ignored")).toBe(
      "COUNTDOWN RICCARTON",
    );
    expect(deriveMerchantKey("  z energy ", "x")).toBe("Z ENERGY");
  });

  it("falls back to first two words of description when merchantName is null/empty", () => {
    expect(deriveMerchantKey(null, "z energy lincoln rd")).toBe("Z ENERGY");
    expect(deriveMerchantKey("", "MERCURY NZ DD")).toBe("MERCURY NZ");
    expect(deriveMerchantKey("   ", "Coffee Shop Kingsland")).toBe(
      "COFFEE SHOP",
    );
  });

  it("falls back to first two words when merchantName is undefined", () => {
    expect(deriveMerchantKey(undefined, "fees")).toBe("FEES");
  });

  it("collapses repeated whitespace in description before splitting", () => {
    expect(deriveMerchantKey(null, "  little   bird   organics  ")).toBe(
      "LITTLE BIRD",
    );
  });

  it("returns an empty string when both merchant name and description are blank", () => {
    expect(deriveMerchantKey("", "")).toBe("");
    expect(deriveMerchantKey(null, "   ")).toBe("");
  });
});

describe("findMatchingRule", () => {
  const rules = [
    { id: "r1", merchantPattern: "COUNTDOWN" },
    { id: "r2", merchantPattern: "Z ENERGY" },
    { id: "r3", merchantPattern: "COUNTDOWN MOORHOUSE" },
  ];

  it("finds a rule by case-insensitive prefix match", () => {
    expect(findMatchingRule("COUNTDOWN RICCARTON", rules)?.id).toBe("r1");
    expect(findMatchingRule("Z ENERGY GLEN INNES", rules)?.id).toBe("r2");
  });

  it("prefers the longest matching pattern (most specific wins)", () => {
    expect(findMatchingRule("COUNTDOWN MOORHOUSE", rules)?.id).toBe("r3");
  });

  it("returns undefined when nothing matches", () => {
    expect(findMatchingRule("WESTPAC ATM", rules)).toBeUndefined();
  });

  it("returns undefined for an empty merchant key", () => {
    expect(findMatchingRule("", rules)).toBeUndefined();
  });

  it("matches mixed-case merchant keys (callers may pass lowercase)", () => {
    expect(findMatchingRule("countdown riccarton", rules)?.id).toBe("r1");
  });

  it("returns undefined when the rule list is empty", () => {
    expect(findMatchingRule("COUNTDOWN", [])).toBeUndefined();
  });
});
