ALTER TABLE `prs` ADD `waiting_on` text DEFAULT 'me' NOT NULL;--> statement-breakpoint
ALTER TABLE `prs` ADD `mergeable` text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE `prs` ADD `merge_state_status` text DEFAULT 'UNKNOWN' NOT NULL;--> statement-breakpoint
ALTER TABLE `prs` ADD `checks` text DEFAULT '[]' NOT NULL;