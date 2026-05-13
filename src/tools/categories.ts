import { z } from "zod";
import { count, eq, inArray, sql } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppDatabase } from "../db/index.js";
import {
  categories as categoriesTable,
  categorizationRules,
  transactionCategories,
  transactions as transactionsTable,
} from "../db/schema.js";
import { newCategoryId, newRuleId } from "../lib/ids.js";
import { deriveMerchantKey } from "../lib/rules.js";

export type CategorizationSource = "akahu_accepted" | "user_override";

export interface CategorizeAssignment {
  transactionId: string;
  categoryName: string;
  source?: CategorizationSource;
}

export interface CategorizeArgs {
  assignments: CategorizeAssignment[];
}

export interface CategorizeResult {
  updated: number;
  categoriesCreated: string[];
  rulesCreated: number;
  rulesUpdated: number;
}

export interface CategorySummary {
  id: string;
  name: string;
  transactionCount: number;
}

export interface CreateCategoryArgs {
  name: string;
}

export interface RenameCategoryArgs {
  categoryId: string;
  newName: string;
}

export interface DeleteCategoryArgs {
  categoryId: string;
}

export interface CategoryRef {
  id: string;
  name: string;
}

export interface DeleteCategoryResult {
  deleted: true;
  uncategorizedCount: number;
}

function normaliseCategoryName(raw: string): string {
  return raw.trim();
}

function findCategoryByName(
  db: AppDatabase,
  name: string,
): { id: string; name: string } | undefined {
  return db
    .select({ id: categoriesTable.id, name: categoriesTable.name })
    .from(categoriesTable)
    .where(eq(categoriesTable.name, name))
    .all()[0];
}

function findCategoryById(
  db: AppDatabase,
  id: string,
): { id: string; name: string } | undefined {
  return db
    .select({ id: categoriesTable.id, name: categoriesTable.name })
    .from(categoriesTable)
    .where(eq(categoriesTable.id, id))
    .all()[0];
}

/**
 * §2.4 + §3.3 — the categorize flow. For each assignment:
 *   1. Upsert category by name (case-sensitive — the LLM is expected to reuse
 *      exact names returned by `list_categories`; capitalisation differences
 *      create distinct categories on purpose).
 *   2. Replace any existing `transaction_categories` row for the transaction.
 *   3. Derive merchant key (§2.7) and create-or-update a rule mapping it to
 *      the chosen category. The `source_transaction_id` always points at the
 *      most recent assignment that touched the rule.
 */
export function categorizeTransactions(
  db: AppDatabase,
  args: CategorizeArgs,
  now: () => Date = () => new Date(),
): CategorizeResult {
  const result: CategorizeResult = {
    updated: 0,
    categoriesCreated: [],
    rulesCreated: 0,
    rulesUpdated: 0,
  };
  if (!args.assignments?.length) return result;

  const txIds = args.assignments.map((a) => a.transactionId);
  const txRows = db
    .select()
    .from(transactionsTable)
    .where(inArray(transactionsTable.id, txIds))
    .all();
  const txById = new Map(txRows.map((row) => [row.id, row]));

  const nowIso = now().toISOString();
  const createdNamesSeen = new Set<string>();

  for (const assignment of args.assignments) {
    const tx = txById.get(assignment.transactionId);
    if (!tx) {
      throw new Error(`Unknown transactionId: ${assignment.transactionId}`);
    }
    const name = normaliseCategoryName(assignment.categoryName);
    if (!name) {
      throw new Error(
        `categoryName must be a non-empty string (transactionId=${assignment.transactionId})`,
      );
    }

    let category = findCategoryByName(db, name);
    if (!category) {
      const newId = newCategoryId();
      db.insert(categoriesTable)
        .values({
          id: newId,
          name,
          source: assignment.source ?? "user",
          createdAt: nowIso,
        })
        .run();
      category = { id: newId, name };
      if (!createdNamesSeen.has(name)) {
        createdNamesSeen.add(name);
        result.categoriesCreated.push(name);
      }
    }

    db.insert(transactionCategories)
      .values({
        transactionId: tx.id,
        categoryId: category.id,
        source: assignment.source ?? "user_override",
        assignedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: transactionCategories.transactionId,
        set: {
          categoryId: category.id,
          source: assignment.source ?? "user_override",
          assignedAt: nowIso,
        },
      })
      .run();

    result.updated += 1;

    const merchantKey = deriveMerchantKey(tx.merchantName, tx.description);
    if (!merchantKey) continue;

    const existingRule = db
      .select()
      .from(categorizationRules)
      .where(eq(categorizationRules.merchantPattern, merchantKey))
      .all()[0];

    if (!existingRule) {
      db.insert(categorizationRules)
        .values({
          id: newRuleId(),
          merchantPattern: merchantKey,
          categoryId: category.id,
          sourceTransactionId: tx.id,
          matchCount: 0,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .run();
      result.rulesCreated += 1;
    } else if (existingRule.categoryId !== category.id) {
      db.update(categorizationRules)
        .set({
          categoryId: category.id,
          sourceTransactionId: tx.id,
          updatedAt: nowIso,
        })
        .where(eq(categorizationRules.id, existingRule.id))
        .run();
      result.rulesUpdated += 1;
    } else {
      // Same merchant→category as before — keep the rule but bump source/updatedAt
      // so the audit trail reflects the latest reinforcing assignment.
      db.update(categorizationRules)
        .set({
          sourceTransactionId: tx.id,
          updatedAt: nowIso,
        })
        .where(eq(categorizationRules.id, existingRule.id))
        .run();
    }
  }

  return result;
}

/** §3.3 list_categories — every category with its current assignment count. */
export function listCategories(db: AppDatabase): CategorySummary[] {
  const rows = db
    .select({
      id: categoriesTable.id,
      name: categoriesTable.name,
      transactionCount: count(transactionCategories.transactionId),
    })
    .from(categoriesTable)
    .leftJoin(
      transactionCategories,
      eq(transactionCategories.categoryId, categoriesTable.id),
    )
    .groupBy(categoriesTable.id, categoriesTable.name)
    .orderBy(sql`lower(${categoriesTable.name})`)
    .all();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    transactionCount: Number(row.transactionCount ?? 0),
  }));
}

/** §3.3 create_category — manual create (rare; the categorize flow is the main path). */
export function createCategory(
  db: AppDatabase,
  args: CreateCategoryArgs,
  now: () => Date = () => new Date(),
): CategoryRef {
  const name = normaliseCategoryName(args.name);
  if (!name) throw new Error("name must be a non-empty string");
  const existing = findCategoryByName(db, name);
  if (existing) return existing;
  const id = newCategoryId();
  db.insert(categoriesTable)
    .values({ id, name, source: "user", createdAt: now().toISOString() })
    .run();
  return { id, name };
}

/** §3.3 rename_category — UNIQUE(name) is enforced by the schema. */
export function renameCategory(
  db: AppDatabase,
  args: RenameCategoryArgs,
): CategoryRef {
  const newName = normaliseCategoryName(args.newName);
  if (!newName) throw new Error("newName must be a non-empty string");
  const existing = findCategoryById(db, args.categoryId);
  if (!existing) throw new Error(`Unknown categoryId: ${args.categoryId}`);
  if (existing.name === newName) return existing;
  const collision = findCategoryByName(db, newName);
  if (collision && collision.id !== args.categoryId) {
    throw new Error(`A category named "${newName}" already exists`);
  }
  db.update(categoriesTable)
    .set({ name: newName })
    .where(eq(categoriesTable.id, args.categoryId))
    .run();
  return { id: args.categoryId, name: newName };
}

/**
 * §3.3 delete_category — uncategorize transactions and drop any rules pointing
 * at this category (rules carry an FK; users can re-train by categorizing
 * again later).
 */
export function deleteCategory(
  db: AppDatabase,
  args: DeleteCategoryArgs,
): DeleteCategoryResult {
  const existing = findCategoryById(db, args.categoryId);
  if (!existing) throw new Error(`Unknown categoryId: ${args.categoryId}`);
  const assignments = db
    .delete(transactionCategories)
    .where(eq(transactionCategories.categoryId, args.categoryId))
    .run();
  db.delete(categorizationRules)
    .where(eq(categorizationRules.categoryId, args.categoryId))
    .run();
  db.delete(categoriesTable)
    .where(eq(categoriesTable.id, args.categoryId))
    .run();
  return {
    deleted: true,
    uncategorizedCount: Number(assignments.changes ?? 0),
  };
}

const assignmentSchema = z.object({
  transactionId: z.string().min(1),
  categoryName: z.string().min(1),
  source: z.enum(["akahu_accepted", "user_override"]).optional(),
});

const categorizeInput = {
  assignments: z
    .array(assignmentSchema)
    .min(1)
    .describe(
      "One or more transaction → category assignments. The category is upserted by name; a vendor→category rule is created or updated based on the transaction's merchant.",
    ),
};

const createCategoryInput = {
  name: z
    .string()
    .min(1)
    .describe("Category name; trimmed of surrounding whitespace."),
};

const renameCategoryInput = {
  categoryId: z.string().min(1),
  newName: z.string().min(1),
};

const deleteCategoryInput = {
  categoryId: z.string().min(1),
};

/** Registers the five category tools on the given McpServer. */
export function registerCategoryTools(
  server: McpServer,
  db: AppDatabase,
  now: () => Date = () => new Date(),
): void {
  server.registerTool(
    "categorize_transactions",
    {
      title: "Categorize transactions",
      description:
        "Assign a category (by name) to one or more transactions. Creates the category on first use and creates/updates a vendor→category auto-rule per assignment.",
      inputSchema: categorizeInput,
    },
    (args) => {
      const result = categorizeTransactions(db, args as CategorizeArgs, now);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "list_categories",
    {
      title: "List categories",
      description:
        "List every user-defined category with its current transaction count, ordered alphabetically.",
      inputSchema: {},
    },
    () => {
      const categories = listCategories(db);
      return {
        content: [{ type: "text", text: JSON.stringify({ categories }) }],
        structuredContent: { categories },
      };
    },
  );

  server.registerTool(
    "create_category",
    {
      title: "Create category",
      description:
        "Create a new category by name. Idempotent: returns the existing category if one with that name already exists.",
      inputSchema: createCategoryInput,
    },
    (args) => {
      const category = createCategory(db, args as CreateCategoryArgs, now);
      return {
        content: [{ type: "text", text: JSON.stringify({ category }) }],
        structuredContent: { category },
      };
    },
  );

  server.registerTool(
    "rename_category",
    {
      title: "Rename category",
      description:
        "Rename an existing category. Fails if another category already has the new name.",
      inputSchema: renameCategoryInput,
    },
    (args) => {
      const category = renameCategory(db, args as RenameCategoryArgs);
      return {
        content: [{ type: "text", text: JSON.stringify({ category }) }],
        structuredContent: { category },
      };
    },
  );

  server.registerTool(
    "delete_category",
    {
      title: "Delete category",
      description:
        "Delete a category, uncategorize its transactions, and drop any auto-rules pointing at it.",
      inputSchema: deleteCategoryInput,
    },
    (args) => {
      const result = deleteCategory(db, args as DeleteCategoryArgs);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
}
