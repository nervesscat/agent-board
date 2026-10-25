CREATE TABLE `ticket_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`kind` text NOT NULL,
	`agent` text NOT NULL,
	`by` text NOT NULL,
	`phase` text DEFAULT '' NOT NULL,
	`round` integer,
	`ref_id` integer,
	`from_agent` text DEFAULT '' NOT NULL,
	`to_agent` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`from_stage` text DEFAULT '' NOT NULL,
	`to_stage` text DEFAULT '' NOT NULL,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ticket_events_kind" CHECK(kind IN ('span_start', 'span_end', 'handoff', 'wait_start', 'wait_end', 'heartbeat', 'push', 'pr', 'preview', 'merge', 'stage')),
	CONSTRAINT "ticket_events_reason" CHECK(reason IN ('', 'lock', 'builder', 'mcp', 'human', 'other'))
);
--> statement-breakpoint
CREATE INDEX `ticket_events_ticket_at` ON `ticket_events` (`ticket_id`,`at`);--> statement-breakpoint
CREATE INDEX `ticket_events_project_at` ON `ticket_events` (`project_id`,`at`);--> statement-breakpoint
ALTER TABLE `projects` ADD `stall_minutes` integer DEFAULT 30 NOT NULL CHECK (`stall_minutes` BETWEEN 1 AND 1440);