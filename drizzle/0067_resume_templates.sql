ALTER TABLE `projects` ADD `resume_template` text DEFAULT '' NOT NULL CHECK (`resume_template` IN ('', 'claude-code', 'codex-exec', 'opencode-run'));--> statement-breakpoint
ALTER TABLE `projects` ADD `resume_template_by` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `resume_template_at` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `ticket_resumes` ADD `template` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `ticket_resumes` ADD `model` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `ticket_resumes` ADD `effort` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `ticket_resumes` ADD `choice` text DEFAULT '' NOT NULL;