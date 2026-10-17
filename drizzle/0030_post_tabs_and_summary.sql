-- New columns, not a rebuild of updates: the migrator runs in a transaction, where PRAGMA foreign_keys=OFF does nothing,
-- so a DROP TABLE updates would cascade into the rows that refer to it (attachments).
ALTER TABLE `updates` ADD `tab` text DEFAULT 'main' NOT NULL CONSTRAINT `updates_tab` CHECK (`tab` IN ('main', 'agents'));--> statement-breakpoint
ALTER TABLE `updates` ADD `summary` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `updates` ADD `summary_change` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Each existing post goes to the tab of the ticket's feed it would go to if posted now: a decision card stays in
-- main, as does a post by the human; a resume note's version goes to agents, and so do progress posts and posts made
-- as one of the project's agents. The rest (questions and answers) stay in main.
UPDATE `updates` SET `tab` = 'agents'
WHERE `decision` IS NULL
  AND (`handoff` = 1 OR (
    (`progress` = 1 OR `via` != '')
    AND `author` NOT IN (SELECT `name` FROM `actors` WHERE `kind` = 'human')
  ));
