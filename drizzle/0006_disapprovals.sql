ALTER TABLE `tickets` ADD `disapproved_at` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `disapproved_by` text DEFAULT '' NOT NULL;