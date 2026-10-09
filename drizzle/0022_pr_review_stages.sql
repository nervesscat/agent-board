ALTER TABLE `prs` ADD `review_stage` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `prs` ADD `merged_at` text;--> statement-breakpoint
ALTER TABLE `prs` ADD `closed_at` text;--> statement-breakpoint
-- A PR already out of the queue left it when it was last fetched.
UPDATE `prs` SET `closed_at` = `fetched_at` WHERE `open` = 0;
