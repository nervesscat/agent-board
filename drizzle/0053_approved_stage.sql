-- Approved, right after In review: the human approved the ticket and the merge is left. It is a
-- review-kind stage, so nothing sends a ticket there by kind; the verdict (or a move) does.
-- Every project that has In review gets it in that place; a project without one keeps its own layout.
-- The stages after In review move down one place, in their order; none is renamed or moved otherwise.
UPDATE `stages` SET `position` = `position` + 1
WHERE EXISTS (SELECT 1 FROM `stages` `r` WHERE `r`.`project_id` = `stages`.`project_id` AND `r`.`key` = 'review')
  AND NOT EXISTS (SELECT 1 FROM `stages` `a` WHERE `a`.`project_id` = `stages`.`project_id` AND `a`.`key` = 'approved')
  AND `position` > (SELECT `r`.`position` FROM `stages` `r` WHERE `r`.`project_id` = `stages`.`project_id` AND `r`.`key` = 'review');
--> statement-breakpoint
INSERT INTO `stages` (`project_id`, `key`, `name`, `kind`, `color`, `position`)
SELECT `r`.`project_id`, 'approved', 'Approved', 'review', 'teal', `r`.`position` + 1
FROM `stages` `r`
WHERE `r`.`key` = 'review'
  AND NOT EXISTS (SELECT 1 FROM `stages` `a` WHERE `a`.`project_id` = `r`.`project_id` AND `a`.`key` = 'approved');
