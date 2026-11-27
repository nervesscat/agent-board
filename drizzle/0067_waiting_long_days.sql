-- How many days a ticket may sit in a review stage, or in To do, before Needs you lists it, 1 to 365.
-- The CHECK is the range, as stall_minutes has it: a table CHECK would have drizzle rebuild projects.
ALTER TABLE `projects` ADD `waiting_long_days` integer DEFAULT 3 NOT NULL CHECK (`waiting_long_days` BETWEEN 1 AND 365);
