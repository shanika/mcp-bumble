import { describe, expect, it } from "vitest";

import {
  newCategoryId,
  newRuleId,
  newSuggestionId,
  newSyncRunId,
  newTransferId,
} from "../../src/lib/ids.js";

describe("id helpers", () => {
  const cases: Array<[string, () => string]> = [
    ["cat_", newCategoryId],
    ["rule_", newRuleId],
    ["xfer_", newTransferId],
    ["sugg_", newSuggestionId],
    ["run_", newSyncRunId],
  ];

  it.each(cases)("%s prefix is applied and ids are unique", (prefix, factory) => {
    const a = factory();
    const b = factory();
    expect(a.startsWith(prefix)).toBe(true);
    expect(b.startsWith(prefix)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(prefix.length + 8);
  });
});
