ALTER TABLE `tickets` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `archived_by` text DEFAULT '' NOT NULL;