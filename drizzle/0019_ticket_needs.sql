CREATE TABLE `ticket_needs` (
	`ticket_id` integer NOT NULL,
	`needs_id` integer NOT NULL,
	PRIMARY KEY(`ticket_id`, `needs_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`needs_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_needs_needs` ON `ticket_needs` (`needs_id`);