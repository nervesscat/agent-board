-- Hand-off post is no longer a phase: the hand-off's summary check already covers it. Its subtasks
-- are steps of that phase only, so they go first (not left to the foreign key's cascade). A subtask
-- named Hand-off post under another phase is a step someone chose, and stays.
DELETE FROM `tasks`
  WHERE `parent_id` IN (
    SELECT `id` FROM `tasks`
    WHERE `parent_id` IS NULL AND lower(trim(`text`, ' ' || char(9, 10, 13))) = 'hand-off post'
  );--> statement-breakpoint
DELETE FROM `tasks`
  WHERE `parent_id` IS NULL AND lower(trim(`text`, ' ' || char(9, 10, 13))) = 'hand-off post';--> statement-breakpoint
-- A project's own list of default phases loses it too, the other entries kept in their order. A list
-- that held only it becomes [] (no phases); a null list follows the built-in one.
UPDATE `projects`
  SET `default_phases` = (
    SELECT json_group_array(`value`) FROM (
      SELECT `value` FROM json_each(`projects`.`default_phases`)
      WHERE lower(trim(`value`, ' ' || char(9, 10, 13))) <> 'hand-off post'
      ORDER BY `key`
    )
  )
  WHERE `default_phases` IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM json_each(`projects`.`default_phases`)
      WHERE lower(trim(`value`, ' ' || char(9, 10, 13))) = 'hand-off post'
    );
