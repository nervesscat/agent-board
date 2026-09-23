CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`github_repo` text,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `prs` ADD `repo_id` integer REFERENCES repos(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `prs_repo` ON `prs` (`repo_id`);--> statement-breakpoint
ALTER TABLE `review_results` ADD `repo_id` integer REFERENCES repos(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `tickets` ADD `repo_id` integer REFERENCES repos(id) ON DELETE set null;--> statement-breakpoint
-- Every existing project had exactly one checkout: it becomes that project's first repo, keeping its id.
INSERT INTO `repos` (`id`, `project_id`, `name`, `repo_path`, `github_repo`, `base_branch`, `createdAt`)
	SELECT `id`, `id`,
		CASE WHEN `github_repo` IS NOT NULL THEN substr(`github_repo`, instr(`github_repo`, '/') + 1) ELSE `name` END,
		`repo_path`, `github_repo`, `base_branch`, `createdAt`
	FROM `projects`;--> statement-breakpoint
UPDATE `prs` SET `repo_id` = `project_id`;--> statement-breakpoint
UPDATE `review_results` SET `repo_id` = `project_id`;--> statement-breakpoint
UPDATE `tickets` SET `repo_id` = `project_id`;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `repo_path`;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `github_repo`;--> statement-breakpoint
ALTER TABLE `projects` DROP COLUMN `base_branch`;
