ALTER TABLE `tickets` ADD `parent_id` integer REFERENCES tickets(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `tickets_parent` ON `tickets` (`parent_id`);