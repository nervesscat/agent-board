ALTER TABLE `attachments` ADD `ticket_id` integer REFERENCES tickets(id) ON DELETE cascade;
