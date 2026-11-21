CREATE TABLE `ticket_need_dismissals` (
	`ticket_id` integer NOT NULL,
	`needs_id` integer NOT NULL,
	`held` text DEFAULT '' NOT NULL,
	`createdAt` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`ticket_id`, `needs_id`),
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`needs_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `ticket_needs` ADD `auto` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `ticket_needs` ADD `held` text DEFAULT '' NOT NULL;
