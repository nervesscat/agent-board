CREATE TABLE `alert_mutes` (
	`project_id` integer NOT NULL,
	`type` text NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`project_id`, `type`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`type` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`buttons` text DEFAULT '[]' NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`seenAt` text,
	`dismissedAt` text,
	`snoozedUntil` text,
	`resolvedAt` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "alerts_severity" CHECK("alerts"."severity" IN ('info', 'warning', 'problem'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_project_type_subject` ON `alerts` (`project_id`,`type`,`subject`) WHERE "alerts"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_board_type_subject` ON `alerts` (`type`,`subject`) WHERE "alerts"."project_id" IS NULL;--> statement-breakpoint
CREATE INDEX `alerts_project` ON `alerts` (`project_id`);
