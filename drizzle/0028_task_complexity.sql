-- A new column, not a rebuild of tickets: the migrator runs in a transaction, where PRAGMA foreign_keys=OFF does nothing,
-- so a DROP TABLE tickets would cascade into the rows that refer to it (comments, tasks, attachments, needs).
ALTER TABLE `tickets` ADD `complexity` text DEFAULT 'mid' NOT NULL CONSTRAINT `tickets_complexity` CHECK (`complexity` IN ('low', 'mid', 'high'));