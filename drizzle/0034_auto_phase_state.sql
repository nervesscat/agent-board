ALTER TABLE `prs` ADD `local_ci_sha` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `merged_phase_checked` integer DEFAULT false NOT NULL;