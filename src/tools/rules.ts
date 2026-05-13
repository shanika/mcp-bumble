import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../db/index.js";
import {
  categories as categoriesTable,
  categorizationRules,
} from "../db/schema.js";

export interface RuleSummary {
  id: string;
  merchantPattern: string;
  categoryName: string;
  matchCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DeleteRuleArgs {
  ruleId: string;
}

export interface DeleteRuleResult {
  deleted: true;
}

/** §3.5 list_rules — joins rules with the category name for display. */
export function listRules(db: AppDatabase): RuleSummary[] {
  const rows = db
    .select({
      id: categorizationRules.id,
      merchantPattern: categorizationRules.merchantPattern,
      categoryName: categoriesTable.name,
      matchCount: categorizationRules.matchCount,
      createdAt: categorizationRules.createdAt,
      updatedAt: categorizationRules.updatedAt,
    })
    .from(categorizationRules)
    .innerJoin(
      categoriesTable,
      eq(categoriesTable.id, categorizationRules.categoryId),
    )
    .orderBy(asc(categorizationRules.merchantPattern))
    .all();
  return rows.map((row) => ({
    id: row.id,
    merchantPattern: row.merchantPattern,
    categoryName: row.categoryName,
    matchCount: Number(row.matchCount ?? 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/** §3.5 delete_rule — already-categorized transactions are unaffected. */
export function deleteRule(
  db: AppDatabase,
  args: DeleteRuleArgs,
): DeleteRuleResult {
  const existing = db
    .select({ id: categorizationRules.id })
    .from(categorizationRules)
    .where(eq(categorizationRules.id, args.ruleId))
    .all()[0];
  if (!existing) throw new Error(`Unknown ruleId: ${args.ruleId}`);
  db.delete(categorizationRules)
    .where(eq(categorizationRules.id, args.ruleId))
    .run();
  return { deleted: true };
}

const deleteRuleInput = {
  ruleId: z.string().min(1),
};

/** Registers `list_rules` + `delete_rule`. */
export function registerRuleTools(server: McpServer, db: AppDatabase): void {
  server.registerTool(
    "list_rules",
    {
      title: "List auto-categorization rules",
      description:
        "List every vendor→category auto-rule with its match count and timestamps.",
      inputSchema: {},
    },
    () => {
      const rules = listRules(db);
      return {
        content: [{ type: "text", text: JSON.stringify({ rules }) }],
        structuredContent: { rules },
      };
    },
  );

  server.registerTool(
    "delete_rule",
    {
      title: "Delete auto-categorization rule",
      description:
        "Delete a vendor→category auto-rule. Existing categorized transactions are unchanged; future transactions from the same vendor will appear uncategorized.",
      inputSchema: deleteRuleInput,
    },
    (args) => {
      const result = deleteRule(db, args as DeleteRuleArgs);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
