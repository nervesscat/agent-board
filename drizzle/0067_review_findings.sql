ALTER TABLE `review_results` ADD `round` integer;--> statement-breakpoint
ALTER TABLE `review_results` ADD `findings` text DEFAULT '[]' NOT NULL;