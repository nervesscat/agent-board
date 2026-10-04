ALTER TABLE `tickets` ADD `started_at` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `resume_note` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `resume_at` text;--> statement-breakpoint
ALTER TABLE `tickets` ADD `resume_by` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `resume_sha` text;--> statement-breakpoint
ALTER TABLE `updates` ADD `handoff` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Tickets already being worked: their work started when they were first claimed, else with the first
-- thing logged on them after they were opened.
UPDATE `tickets` SET `started_at` = coalesce(
  (SELECT min(`a`.`createdAt`) FROM `activity` `a`
    WHERE `a`.`ref_type` = 'ticket' AND `a`.`ref_id` = `tickets`.`id`
      AND (`a`.`text` LIKE 'claimed %' OR `a`.`text` LIKE 'took over %')),
  (SELECT min(`a`.`createdAt`) FROM `activity` `a`
    WHERE `a`.`ref_type` = 'ticket' AND `a`.`ref_id` = `tickets`.`id`
      AND `a`.`text` NOT LIKE 'created ticket %' AND `a`.`text` NOT LIKE 'opened lane %'),
  `tickets`.`createdAt`)
WHERE `status` IN (SELECT `s`.`key` FROM `stages` `s`
  WHERE `s`.`project_id` = `tickets`.`project_id` AND `s`.`kind` IN ('active', 'blocked', 'review'))
  -- A project that never had its stages read still has the default ones.
  OR (`status` IN ('in_progress', 'blocked', 'review')
    AND NOT EXISTS (SELECT 1 FROM `stages` `s` WHERE `s`.`project_id` = `tickets`.`project_id`));