ALTER TABLE `tasks` ADD `blocked_at` text;--> statement-breakpoint
UPDATE `tasks` SET `blocked_at` = (SELECT `updatedAt` FROM `tickets` WHERE `tickets`.`id` = `tasks`.`ticket_id`) WHERE `blocked` = 1;
