CREATE TABLE `agent_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`title` text NOT NULL,
	`request` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`step` text,
	`result` text,
	`href` text,
	`startedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updatedAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finishedAt` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_cards_kind" CHECK("agent_cards"."kind" IN ('tracked', 'notice')),
	CONSTRAINT "agent_cards_state" CHECK("agent_cards"."state" IN ('running', 'succeeded', 'failed', 'notice'))
);
--> statement-breakpoint
CREATE INDEX `agent_cards_project` ON `agent_cards` (`project_id`);
