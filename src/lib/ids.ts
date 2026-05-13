import { nanoid } from "nanoid";

export const newCategoryId = (): string => `cat_${nanoid()}`;
export const newRuleId = (): string => `rule_${nanoid()}`;
export const newTransferId = (): string => `xfer_${nanoid()}`;
export const newSuggestionId = (): string => `sugg_${nanoid()}`;
export const newSyncRunId = (): string => `run_${nanoid()}`;
