ALTER TABLE `comments` ADD `edited_at` text;--> statement-breakpoint
ALTER TABLE `updates` ADD `progress` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `updates` ADD `edited_at` text;--> statement-breakpoint
-- Comments straight on a ticket become posts on it (not progress). A temporary column remembers which
-- comment each post came from, so replies and files can follow.
ALTER TABLE `updates` ADD `from_comment` integer;--> statement-breakpoint
INSERT INTO `updates` (`ticket_id`, `author`, `via`, `body`, `progress`, `createdAt`, `from_comment`)
  SELECT c.`parent_id`, c.`author`, c.`via`, c.`body`, 0, c.`createdAt`, c.`id` FROM `comments` c
  WHERE c.`parent_type` = 'ticket'
    AND c.`parent_id` IN (SELECT `id` FROM `tickets`)
    AND (c.`reply_to` IS NULL
      OR c.`reply_to` NOT IN (SELECT `id` FROM `comments` WHERE `parent_type` = 'ticket' AND `reply_to` IS NULL));--> statement-breakpoint
-- Replies to those comments become replies under the new post.
UPDATE `comments`
  SET `parent_type` = 'update',
      `parent_id` = (SELECT u.`id` FROM `updates` u WHERE u.`from_comment` = `comments`.`reply_to`),
      `reply_to` = NULL
  WHERE `parent_type` = 'ticket'
    AND `reply_to` IN (SELECT `from_comment` FROM `updates` WHERE `from_comment` IS NOT NULL);--> statement-breakpoint
-- Files follow the comment they were attached to.
UPDATE `attachments`
  SET `update_id` = (SELECT u.`id` FROM `updates` u WHERE u.`from_comment` = `attachments`.`comment_id`),
      `comment_id` = NULL
  WHERE `comment_id` IN (SELECT `from_comment` FROM `updates` WHERE `from_comment` IS NOT NULL);--> statement-breakpoint
DELETE FROM `comments` WHERE `parent_type` = 'ticket';--> statement-breakpoint
ALTER TABLE `updates` DROP COLUMN `from_comment`;
