DROP TABLE `review_runs`;--> statement-breakpoint
DROP TABLE `review_schedules`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_review_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`repo_id` integer,
	`pr_number` integer NOT NULL,
	`sha` text NOT NULL,
	`verdict` text NOT NULL,
	`checks` text DEFAULT '{}' NOT NULL,
	`counts` text DEFAULT '{}' NOT NULL,
	`summary_md` text DEFAULT '' NOT NULL,
	`author` text NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_review_results`("id", "project_id", "repo_id", "pr_number", "sha", "verdict", "checks", "counts", "summary_md", "author", "createdAt") SELECT "id", "project_id", "repo_id", "pr_number", "sha", "verdict", "checks", "counts", "summary_md", "author", "createdAt" FROM `review_results`;--> statement-breakpoint
DROP TABLE `review_results`;--> statement-breakpoint
ALTER TABLE `__new_review_results` RENAME TO `review_results`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `review_results_pr` ON `review_results` (`project_id`,`pr_number`);