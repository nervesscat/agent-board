CREATE TABLE `ticket_resumes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ticket_id` integer NOT NULL,
	`post_id` integer,
	`trigger` text NOT NULL,
	`state` text NOT NULL,
	`pid` integer,
	`pid_identity` text,
	`command` text DEFAULT '' NOT NULL,
	`exit_code` integer,
	`reason` text DEFAULT '' NOT NULL,
	`log_path` text DEFAULT '' NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`post_id`) REFERENCES `updates`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "ticket_resumes_state" CHECK("ticket_resumes"."state" IN ('queued', 'running', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `ticket_resumes_ticket` ON `ticket_resumes` (`ticket_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `resume_command` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `resume_timeout_minutes` integer DEFAULT 240 NOT NULL;
--> statement-breakpoint
ALTER TABLE `updates` ADD `answer_delivered` text DEFAULT '' NOT NULL;
