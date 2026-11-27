CREATE TABLE `ticket_send_backs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`event_id` integer,
	`from_stage` text NOT NULL,
	`to_stage` text NOT NULL,
	`by` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`reason_by` text DEFAULT '' NOT NULL,
	`reason_at` text,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `ticket_events`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ticket_send_backs_ticket` ON `ticket_send_backs` (`ticket_id`,`at`);--> statement-breakpoint
ALTER TABLE `ticket_events` ADD `moved_by` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `ticket_events` ADD `how` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `merged_at` text;