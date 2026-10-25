CREATE TABLE `project_instruction_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`old_value` text DEFAULT '' NOT NULL,
	`new_value` text DEFAULT '' NOT NULL,
	`changed_by` text NOT NULL,
	`role` text NOT NULL,
	`state` text DEFAULT 'accepted' NOT NULL,
	`resolved_by` text DEFAULT '' NOT NULL,
	`resolved_at` text,
	`revert_of` integer,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_instruction_changes_project` ON `project_instruction_changes` (`project_id`,`createdAt`);--> statement-breakpoint
ALTER TABLE `actors` ADD `role` text DEFAULT 'worker' NOT NULL;--> statement-breakpoint
ALTER TABLE `actors` ADD `parent` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `role` text DEFAULT 'worker' NOT NULL;