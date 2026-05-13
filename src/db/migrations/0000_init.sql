CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`institution` text NOT NULL,
	`balance_available` real,
	`balance_current` real,
	`currency` text DEFAULT 'NZD',
	`raw_json` text,
	`synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source` text DEFAULT 'user',
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_unique` ON `categories` (`name`);--> statement-breakpoint
CREATE TABLE `categorization_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`merchant_pattern` text NOT NULL,
	`category_id` text NOT NULL,
	`source_transaction_id` text,
	`match_count` integer DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categorization_rules_merchant_pattern_unique` ON `categorization_rules` (`merchant_pattern`);--> statement-breakpoint
CREATE INDEX `idx_categorization_rules_merchant` ON `categorization_rules` (`merchant_pattern`);--> statement-breakpoint
CREATE TABLE `internal_transfer_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`debit_transaction_id` text NOT NULL,
	`credit_transaction_id` text NOT NULL,
	`detection_method` text NOT NULL,
	`confidence` text NOT NULL,
	`suggested_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`debit_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_transfer_suggestions_status` ON `internal_transfer_suggestions` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `internal_transfer_suggestions_pair_unique` ON `internal_transfer_suggestions` (`debit_transaction_id`,`credit_transaction_id`);--> statement-breakpoint
CREATE TABLE `internal_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`debit_transaction_id` text NOT NULL,
	`credit_transaction_id` text,
	`detection_method` text NOT NULL,
	`marked_at` text NOT NULL,
	FOREIGN KEY (`debit_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`credit_transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `internal_transfers_debit_unique` ON `internal_transfers` (`debit_transaction_id`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`transactions_imported` integer DEFAULT 0,
	`transfers_auto_marked` integer DEFAULT 0,
	`transfers_suggested` integer DEFAULT 0,
	`auto_categorized` integer DEFAULT 0,
	`residual_uncategorized` integer DEFAULT 0,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_sync_runs_started` ON `sync_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`last_synced_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `transaction_categories` (
	`transaction_id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`source` text,
	`assigned_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_transaction_categories_category` ON `transaction_categories` (`category_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`date` text NOT NULL,
	`description` text NOT NULL,
	`amount` real NOT NULL,
	`type` text NOT NULL,
	`merchant_name` text,
	`akahu_category` text,
	`meta_other_account` text,
	`raw_json` text,
	`synced_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_transactions_date` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `idx_transactions_account` ON `transactions` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_transactions_type` ON `transactions` (`type`);--> statement-breakpoint
CREATE INDEX `idx_transactions_akahu_cat` ON `transactions` (`akahu_category`);