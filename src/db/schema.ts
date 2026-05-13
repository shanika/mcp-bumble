import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

/** Synced from Akahu (forward-only daily sync). */
export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  institution: text("institution").notNull(),
  balanceAvailable: real("balance_available"),
  balanceCurrent: real("balance_current"),
  currency: text("currency").default("NZD"),
  rawJson: text("raw_json"),
  syncedAt: text("synced_at").notNull(),
});

/** Synced from Akahu (forward-only daily sync). */
export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    date: text("date").notNull(),
    description: text("description").notNull(),
    amount: real("amount").notNull(),
    type: text("type").notNull(),
    merchantName: text("merchant_name"),
    akahuCategory: text("akahu_category"),
    metaOtherAccount: text("meta_other_account"),
    rawJson: text("raw_json"),
    syncedAt: text("synced_at").notNull(),
  },
  (table) => ({
    dateIdx: index("idx_transactions_date").on(table.date),
    accountIdx: index("idx_transactions_account").on(table.accountId),
    typeIdx: index("idx_transactions_type").on(table.type),
    akahuCatIdx: index("idx_transactions_akahu_cat").on(table.akahuCategory),
  }),
);

/** Local only — user-defined categories (created on first use, no defaults shipped). */
export const categories = sqliteTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  source: text("source").default("user"),
  createdAt: text("created_at").notNull(),
});

/** Local only — maps transactions to user categories (one per transaction in v1). */
export const transactionCategories = sqliteTable(
  "transaction_categories",
  {
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    source: text("source"),
    assignedAt: text("assigned_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.transactionId] }),
    categoryIdx: index("idx_transaction_categories_category").on(
      table.categoryId,
    ),
  }),
);

/** Local only — vendor→category auto-categorization rules. */
export const categorizationRules = sqliteTable(
  "categorization_rules",
  {
    id: text("id").primaryKey(),
    merchantPattern: text("merchant_pattern").notNull().unique(),
    categoryId: text("category_id")
      .notNull()
      .references(() => categories.id),
    sourceTransactionId: text("source_transaction_id"),
    matchCount: integer("match_count").default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    merchantIdx: index("idx_categorization_rules_merchant").on(
      table.merchantPattern,
    ),
  }),
);

/** Local only — confirmed internal transfer markings. */
export const internalTransfers = sqliteTable(
  "internal_transfers",
  {
    id: text("id").primaryKey(),
    debitTransactionId: text("debit_transaction_id")
      .notNull()
      .references(() => transactions.id),
    creditTransactionId: text("credit_transaction_id").references(
      () => transactions.id,
    ),
    detectionMethod: text("detection_method").notNull(),
    markedAt: text("marked_at").notNull(),
  },
  (table) => ({
    debitUnique: unique("internal_transfers_debit_unique").on(
      table.debitTransactionId,
    ),
  }),
);

/** Local only — pending Pass-2 internal transfer suggestions, awaiting user confirmation. */
export const internalTransferSuggestions = sqliteTable(
  "internal_transfer_suggestions",
  {
    id: text("id").primaryKey(),
    debitTransactionId: text("debit_transaction_id")
      .notNull()
      .references(() => transactions.id),
    creditTransactionId: text("credit_transaction_id")
      .notNull()
      .references(() => transactions.id),
    detectionMethod: text("detection_method").notNull(),
    confidence: text("confidence").notNull(),
    suggestedAt: text("suggested_at").notNull(),
    status: text("status").notNull().default("pending"),
  },
  (table) => ({
    pairUnique: unique("internal_transfer_suggestions_pair_unique").on(
      table.debitTransactionId,
      table.creditTransactionId,
    ),
    statusIdx: index("idx_transfer_suggestions_status").on(table.status),
  }),
);

/** Local only — tracks the high-water mark for forward-only sync per data kind. */
export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  lastSyncedAt: text("last_synced_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Local only — audit log of nightly cron runs. */
export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    status: text("status").notNull(),
    transactionsImported: integer("transactions_imported").default(0),
    transfersAutoMarked: integer("transfers_auto_marked").default(0),
    transfersSuggested: integer("transfers_suggested").default(0),
    autoCategorized: integer("auto_categorized").default(0),
    residualUncategorized: integer("residual_uncategorized").default(0),
    error: text("error"),
  },
  (table) => ({
    startedIdx: index("idx_sync_runs_started").on(table.startedAt),
  }),
);

export const schema = {
  accounts,
  transactions,
  categories,
  transactionCategories,
  categorizationRules,
  internalTransfers,
  internalTransferSuggestions,
  syncState,
  syncRuns,
};

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type TransactionCategory = typeof transactionCategories.$inferSelect;
export type NewTransactionCategory = typeof transactionCategories.$inferInsert;
export type CategorizationRule = typeof categorizationRules.$inferSelect;
export type NewCategorizationRule = typeof categorizationRules.$inferInsert;
export type InternalTransfer = typeof internalTransfers.$inferSelect;
export type NewInternalTransfer = typeof internalTransfers.$inferInsert;
export type InternalTransferSuggestion =
  typeof internalTransferSuggestions.$inferSelect;
export type NewInternalTransferSuggestion =
  typeof internalTransferSuggestions.$inferInsert;
export type SyncState = typeof syncState.$inferSelect;
export type NewSyncState = typeof syncState.$inferInsert;
export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;

export { sql };
