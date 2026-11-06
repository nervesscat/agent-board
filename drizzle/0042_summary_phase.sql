-- Summary joins the phases the board ticks: the hand-off's summary check, written after the branch's
-- last commit. A ticket still at work that has the hand-off phases (at least one top-level Pushed, PR,
-- CI, Preview or Merged) and no top-level Summary gets it, unticked, right before its Merged (else at
-- the end); the board ticks it on the next read or poll. Archived tickets, a PR's own ticket, and
-- tickets in a done or cancelled stage are left alone: an open phase would take a closed one off 100%.
-- First the tasks from Merged on move one place down, to make room.
UPDATE `tasks`
  SET `position` = `position` + 1
  WHERE EXISTS (
    SELECT 1 FROM `tickets` AS `t`
    JOIN `tasks` AS `m` ON `m`.`id` = (
      SELECT `id` FROM `tasks` AS `x`
      WHERE `x`.`ticket_id` = `t`.`id` AND `x`.`parent_id` IS NULL
        AND lower(trim(`x`.`text`, ' ' || char(9, 10, 13))) = 'merged'
      ORDER BY `x`.`position`, `x`.`id` LIMIT 1
    )
    WHERE `t`.`id` = `tasks`.`ticket_id`
      AND `t`.`archived_at` IS NULL AND `t`.`pr_id` IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM `stages` AS `s`
        WHERE `s`.`project_id` = `t`.`project_id` AND `s`.`key` = `t`.`status`
          AND `s`.`kind` IN ('done', 'cancelled')
      )
      AND NOT EXISTS (
        SELECT 1 FROM `tasks` AS `y`
        WHERE `y`.`ticket_id` = `t`.`id` AND `y`.`parent_id` IS NULL
          AND lower(trim(`y`.`text`, ' ' || char(9, 10, 13))) = 'summary'
      )
      AND (`tasks`.`position` > `m`.`position` OR (`tasks`.`position` = `m`.`position` AND `tasks`.`id` >= `m`.`id`))
  );--> statement-breakpoint
-- Then Summary goes in the place Merged left (sorted after the tasks that share it, by its newer id),
-- or after every task of a ticket without Merged.
INSERT INTO `tasks` (`ticket_id`, `text`, `position`)
  SELECT `t`.`id`, 'Summary', coalesce(
    (
      SELECT `x`.`position` - 1 FROM `tasks` AS `x`
      WHERE `x`.`ticket_id` = `t`.`id` AND `x`.`parent_id` IS NULL
        AND lower(trim(`x`.`text`, ' ' || char(9, 10, 13))) = 'merged'
      ORDER BY `x`.`position`, `x`.`id` LIMIT 1
    ),
    (SELECT max(`position`) + 1 FROM `tasks` WHERE `ticket_id` = `t`.`id`)
  )
  FROM `tickets` AS `t`
  WHERE `t`.`archived_at` IS NULL AND `t`.`pr_id` IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM `stages` AS `s`
      WHERE `s`.`project_id` = `t`.`project_id` AND `s`.`key` = `t`.`status`
        AND `s`.`kind` IN ('done', 'cancelled')
    )
    AND EXISTS (
      SELECT 1 FROM `tasks` AS `p`
      WHERE `p`.`ticket_id` = `t`.`id` AND `p`.`parent_id` IS NULL
        AND lower(trim(`p`.`text`, ' ' || char(9, 10, 13))) IN ('pushed', 'pr', 'ci', 'preview', 'merged')
    )
    AND NOT EXISTS (
      SELECT 1 FROM `tasks` AS `y`
      WHERE `y`.`ticket_id` = `t`.`id` AND `y`.`parent_id` IS NULL
        AND lower(trim(`y`.`text`, ' ' || char(9, 10, 13))) = 'summary'
    );--> statement-breakpoint
-- A project's own list of default phases gets it only when the list is the old built-in one (in any
-- case or spacing): one with phases removed, renamed, reordered or added keeps its own list. A null
-- list follows the built-in one, which has Summary now.
UPDATE `projects`
  SET `default_phases` = (
    SELECT json_group_array(`value`) FROM (
      SELECT `value`, `key` * 2 AS `k` FROM json_each(`projects`.`default_phases`)
      UNION ALL SELECT 'Summary', 9
      ORDER BY `k`
    )
  )
  WHERE `default_phases` IS NOT NULL
    AND (
      SELECT json_group_array(`v`) FROM (
        SELECT lower(trim(`value`, ' ' || char(9, 10, 13))) AS `v` FROM json_each(`projects`.`default_phases`)
        ORDER BY `key`
      )
    ) = '["implementation","pushed","pr","ci","preview","merged"]';
