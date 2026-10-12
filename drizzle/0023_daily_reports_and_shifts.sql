-- report_settings: the template and the shift. The due time becomes the shift's end.
ALTER TABLE `report_settings` ADD `template` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `report_settings` ADD `shift_start` text DEFAULT '09:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `report_settings` ADD `shift_end` text DEFAULT '17:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `report_settings` ADD `workdays` text DEFAULT '[1,2,3,4,5]' NOT NULL;--> statement-breakpoint
ALTER TABLE `report_settings` ADD `alert_minutes` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
-- A due time of 00:00 was due as its day began. A shift ends after it starts and within its day (there is no
-- 24:00), so the nearest end the shift can have is 00:01: due one minute later, where 23:59 would be almost
-- a day later.
UPDATE `report_settings` SET `shift_end` = CASE `due_time` WHEN '00:00' THEN '00:01' ELSE `due_time` END WHERE `due_time` IS NOT NULL;--> statement-breakpoint
-- A shift starts before it ends: a due time not after the default start moves the start to midnight.
UPDATE `report_settings` SET `shift_start` = '00:00' WHERE `shift_end` <= `shift_start`;--> statement-breakpoint
ALTER TABLE `report_settings` DROP COLUMN `due_time`;--> statement-breakpoint
-- Every prompt or template change, kept with the value before it; origin's branches as last seen, each move,
-- and the repos the board has looked at.
CREATE TABLE `origin_looks` (
	`repo_id` integer PRIMARY KEY NOT NULL,
	`seenAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `origin_ref_moves` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`ref` text NOT NULL,
	`old_sha` text,
	`new_sha` text,
	`seenAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `origin_ref_moves_repo_seen` ON `origin_ref_moves` (`repo_id`,`seenAt`);--> statement-breakpoint
CREATE TABLE `origin_refs` (
	`repo_id` integer NOT NULL,
	`ref` text NOT NULL,
	`sha` text NOT NULL,
	`seenAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`repo_id`, `ref`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `report_settings_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`field` text NOT NULL,
	`old_value` text DEFAULT '' NOT NULL,
	`new_value` text DEFAULT '' NOT NULL,
	`changed_by` text NOT NULL,
	`by_agent` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'accepted' NOT NULL,
	`resolved_by` text DEFAULT '' NOT NULL,
	`resolved_at` text,
	`revert_of` integer,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `report_settings_changes_project` ON `report_settings_changes` (`project_id`,`createdAt`);--> statement-breakpoint
-- The daily summaries become report versions of their day (several on one day: versions in time order). The
-- board-wide ones belong to no project and go with the table.
INSERT INTO `reports` (`project_id`, `cadence`, `period`, `body`, `author`, `createdAt`)
  SELECT `project_id`, 'daily', `date`, `body`, `author`, `createdAt` FROM `daily_summaries`
  WHERE `project_id` IS NOT NULL ORDER BY `createdAt`, `id`;--> statement-breakpoint
DROP TABLE `daily_summaries`;