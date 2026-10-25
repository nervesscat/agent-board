CREATE TABLE `run_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`install` text DEFAULT '' NOT NULL,
	`build` text DEFAULT '' NOT NULL,
	`start` text DEFAULT '' NOT NULL,
	`env` text DEFAULT '{}' NOT NULL,
	`port` integer,
	`health_path` text DEFAULT '' NOT NULL,
	`copy_data` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_configs_type" CHECK("run_configs"."type" IN ('preview', 'job'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_configs_repo_name` ON `run_configs` (`repo_id`,`name`);--> statement-breakpoint
CREATE TABLE `ticket_repos` (
	`ticket_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`pr_number` integer,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`ticket_id`, `repo_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_repos_repo` ON `ticket_repos` (`repo_id`);--> statement-breakpoint
ALTER TABLE `repos` ADD `runs_seeded` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `repo_id` integer REFERENCES repos(id) ON DELETE set null;--> statement-breakpoint
INSERT INTO `ticket_repos` (`ticket_id`, `repo_id`, `branch`, `base_branch`, `pr_number`, `position`)
SELECT `id`, `repo`, `branch`, `base_branch`, `pr_number`, 0 FROM (
	SELECT t.`id`, t.`branch`, t.`base_branch`, t.`pr_number`, COALESCE(
		(SELECT r.`id` FROM `repos` r WHERE r.`id` = t.`repo_id`),
		(SELECT r.`id` FROM `repos` r WHERE r.`project_id` = t.`project_id` ORDER BY r.`name`, r.`id` LIMIT 1)
	) AS `repo`
	FROM `tickets` t
) WHERE `repo` IS NOT NULL;--> statement-breakpoint
UPDATE `workspaces` SET `repo_id` = (
	SELECT tr.`repo_id` FROM `ticket_repos` tr WHERE tr.`ticket_id` = `workspaces`.`ticket_id` AND tr.`position` = 0
);
