ALTER TABLE `updates` ADD `decision` text;--> statement-breakpoint
ALTER TABLE `updates` ADD `decided_option` integer;--> statement-breakpoint
ALTER TABLE `updates` ADD `decided_by` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `updates` ADD `decided_at` text;