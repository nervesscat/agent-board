CREATE TABLE `run_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`ticket_id` integer NOT NULL,
	`agent` text NOT NULL,
	`round` integer,
	`branch` text DEFAULT '' NOT NULL,
	`head_sha` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`effort` text DEFAULT '' NOT NULL,
	`briefed_by` text DEFAULT '' NOT NULL,
	`started_at` text,
	`ended_at` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`duration_source` text DEFAULT 'self' NOT NULL,
	`reported_duration_ms` integer,
	`time` text DEFAULT '{}' NOT NULL,
	`difficulty` integer,
	`confidence` integer,
	`steps` text DEFAULT '[]' NOT NULL,
	`counts` text DEFAULT '{}' NOT NULL,
	`sections` text DEFAULT '{}' NOT NULL,
	`author` text NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_reports_project_agent` ON `run_reports` (`project_id`,`agent`,`createdAt`);--> statement-breakpoint
CREATE INDEX `run_reports_ticket` ON `run_reports` (`ticket_id`,`agent`);--> statement-breakpoint
ALTER TABLE `agents` ADD `report_template` text DEFAULT '' NOT NULL;