ALTER TABLE `tasks` ADD `blocked` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `blocked_reason` text DEFAULT '' NOT NULL;