ALTER TABLE `tickets` ADD `approved_at` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `approved_by` text DEFAULT '' NOT NULL;