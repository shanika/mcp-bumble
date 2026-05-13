import type { CategorizationRule } from "../db/schema.js";

/**
 * Spec §2.7 — derive the normalised merchant key used for both rule storage
 * and rule matching. Prefers `merchant_name`; otherwise falls back to the
 * first two words of `description`. Always uppercase, trimmed.
 */
export function deriveMerchantKey(
  merchantName: string | null | undefined,
  description: string,
): string {
  if (merchantName && merchantName.trim().length > 0) {
    return merchantName.trim().toUpperCase();
  }
  const words = description.trim().split(/\s+/).slice(0, 2).join(" ");
  return words.toUpperCase();
}

/**
 * Case-insensitive prefix match on `merchant_pattern` against the derived
 * merchant key. Returns the most specific (longest) matching rule, mirroring
 * the sync pipeline's resolution order so user-facing tools and the cron see
 * identical results.
 */
export function findMatchingRule<
  T extends Pick<CategorizationRule, "merchantPattern">,
>(merchantKey: string, rules: readonly T[]): T | undefined {
  if (!merchantKey) return undefined;
  const haystack = merchantKey.toUpperCase();
  const sorted = [...rules].sort(
    (a, b) => b.merchantPattern.length - a.merchantPattern.length,
  );
  return sorted.find((rule) =>
    haystack.startsWith(rule.merchantPattern.toUpperCase()),
  );
}
