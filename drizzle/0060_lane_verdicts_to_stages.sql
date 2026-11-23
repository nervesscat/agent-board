-- Lanes (tickets with a parent) are judged by their stage, not by an approval of their own: an
-- approved lane is one in Approved or Done, a rejected one is in Cancelled already (disapproving moved
-- it there). Top-level tickets keep the columns and their meaning; this touches lanes only, and not a PR
-- review (a lane tagged PR under the review queue), whose approval finishes it and stays.
--
-- A lane that was approved and sits in neither Approved nor a done or cancelled stage moves to the
-- project's Approved stage (key 'approved', a review stage), the place a ticket's approval puts it,
-- unplaced in the column like any other move. A project without that stage leaves its lanes where they
-- are, and a lane in a cancelled stage stays there: the stage is the latest word. To count the lanes
-- this moves, run a SELECT with the same WHERE on a copy of the data before the migration.
UPDATE `tickets` SET `status` = 'approved', `rank` = NULL
WHERE `parent_id` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM json_each(`tickets`.`tags`) WHERE lower(`value`) = 'pr')
  AND `approved_at` IS NOT NULL
  AND `status` <> 'approved'
  AND EXISTS (
    SELECT 1 FROM `stages` `a`
    WHERE `a`.`project_id` = `tickets`.`project_id` AND `a`.`key` = 'approved' AND `a`.`kind` = 'review'
  )
  AND NOT EXISTS (
    SELECT 1 FROM `stages` `s`
    WHERE `s`.`project_id` = `tickets`.`project_id` AND `s`.`key` = `tickets`.`status`
      AND `s`.`kind` IN ('done', 'cancelled')
  );
--> statement-breakpoint
-- No lane keeps a call: the approval and disapproval columns are cleared on every lane.
UPDATE `tickets` SET `approved_at` = NULL, `approved_by` = '', `disapproved_at` = NULL, `disapproved_by` = '', `closed_by_approval` = 0
WHERE `parent_id` IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM json_each(`tickets`.`tags`) WHERE lower(`value`) = 'pr')
  AND (`approved_at` IS NOT NULL OR `approved_by` <> '' OR `disapproved_at` IS NOT NULL OR `disapproved_by` <> '' OR `closed_by_approval` <> 0);
