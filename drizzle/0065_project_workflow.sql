ALTER TABLE `projects` ADD `workflow_preset` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `workflow_tweaks` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `workflow_preset` text;