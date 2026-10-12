ALTER TABLE `tasks` ADD `parent_id` integer REFERENCES tasks(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `tasks_parent` ON `tasks` (`parent_id`);