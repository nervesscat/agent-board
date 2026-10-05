CREATE TABLE `report_settings` (
	`project_id` integer PRIMARY KEY NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`cadence` text DEFAULT 'off' NOT NULL,
	`weekday` integer DEFAULT 5 NOT NULL,
	`due_time` text,
	`format` text DEFAULT 'text' NOT NULL,
	`since` text DEFAULT '' NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`cadence` text NOT NULL,
	`period` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`author` text NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reports_project_period` ON `reports` (`project_id`,`period`);--> statement-breakpoint
ALTER TABLE `attachments` ADD `report_id` integer REFERENCES reports(id) ON DELETE cascade;