CREATE INDEX `activity_ref` ON `activity` (`ref_id`,`ref_type`);--> statement-breakpoint
CREATE INDEX `tasks_ticket` ON `tasks` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `tickets_project` ON `tickets` (`project_id`);--> statement-breakpoint
CREATE INDEX `updates_ticket` ON `updates` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `updates_open_decisions` ON `updates` (`createdAt`) WHERE decision is not null and decided_at is null;--> statement-breakpoint
CREATE INDEX `workspaces_ticket` ON `workspaces` (`ticket_id`);