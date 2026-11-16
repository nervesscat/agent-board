-- Widens the tickets_complexity check to the fourth level the review budget has: rebuilding the table is
-- the only way to change a CHECK, and a rebuild needs foreign keys off, or DROP TABLE tickets cascades into
-- every row that refers to a ticket (tasks, updates, workspaces, ticket events, ticket repos, needs). The
-- migrator runs its migrations inside one transaction, where PRAGMA foreign_keys=OFF does nothing, so this
-- ends that transaction, rebuilds in one of its own with foreign keys off, and opens one for the migrator's
-- own bookkeeping. The rebuild being a copy of the table, running it again is harmless. Every ticket keeps
-- its id, its level and every column, and so do the rows that refer to it.
COMMIT;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
BEGIN;--> statement-breakpoint
CREATE TABLE `__new_tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`repo_id` integer,
	`parent_id` integer,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`rank` integer,
	`complexity` text DEFAULT 'mid' NOT NULL,
	`assignee` text DEFAULT '' NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`pr_number` integer,
	`pr_id` integer,
	`created_by` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`approved_at` text,
	`approved_by` text DEFAULT '' NOT NULL,
	`disapproved_at` text,
	`disapproved_by` text DEFAULT '' NOT NULL,
	`archived_at` text,
	`archived_by` text DEFAULT '' NOT NULL,
	`started_at` text,
	`merged_phase_checked` integer DEFAULT false NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pr_id`) REFERENCES `prs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tickets_complexity" CHECK("complexity" IN ('low', 'mid', 'high', 'max'))
);
--> statement-breakpoint
INSERT INTO `__new_tickets`("id", "project_id", "repo_id", "parent_id", "title", "body", "status", "rank", "complexity", "assignee", "branch", "base_branch", "pr_number", "pr_id", "created_by", "tags", "approved_at", "approved_by", "disapproved_at", "disapproved_by", "archived_at", "archived_by", "started_at", "merged_phase_checked", "createdAt", "updatedAt") SELECT "id", "project_id", "repo_id", "parent_id", "title", "body", "status", "rank", "complexity", "assignee", "branch", "base_branch", "pr_number", "pr_id", "created_by", "tags", "approved_at", "approved_by", "disapproved_at", "disapproved_by", "archived_at", "archived_by", "started_at", "merged_phase_checked", "createdAt", "updatedAt" FROM `tickets`;--> statement-breakpoint
DROP TABLE `tickets`;--> statement-breakpoint
ALTER TABLE `__new_tickets` RENAME TO `tickets`;--> statement-breakpoint
CREATE INDEX `tickets_parent` ON `tickets` (`parent_id`);--> statement-breakpoint
COMMIT;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
BEGIN;
