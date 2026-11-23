-- A step's hand-off instruction is no longer edited on the Workflow page (a step's instructions are the
-- Team agent's), so the `instructions` a human saved on a step of a preset leave projects.workflow_tweaks.
-- Each preset keeps its `order`, `rounds` and every step's `enabled` and `effort` exactly; a step left with
-- nothing is `{}`, which the reader treats as no tweak. A NULL, a value that is not JSON and a value that
-- is not an object are left as they are, and so is any row that holds no instruction.
UPDATE `projects` SET `workflow_tweaks` = (
	SELECT json_group_object(
		`p`.`key`,
		CASE
			WHEN `p`.`type` = 'object' AND json_type(`p`.`value`, '$.steps') = 'object' THEN
				json_set(`p`.`value`, '$.steps', json((
					SELECT json_group_object(
						`s`.`key`,
						CASE
							WHEN `s`.`type` = 'object' THEN json(json_remove(`s`.`value`, '$.instructions'))
							ELSE json(CASE `s`.`type` WHEN 'text' THEN json_quote(`s`.`value`) WHEN 'null' THEN 'null' WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE `s`.`value` END)
						END
					)
					FROM json_each(`p`.`value`, '$.steps') AS `s`
				)))
			ELSE json(CASE `p`.`type` WHEN 'text' THEN json_quote(`p`.`value`) WHEN 'null' THEN 'null' WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' ELSE `p`.`value` END)
		END
	)
	FROM json_each(`projects`.`workflow_tweaks`) AS `p`
)
WHERE json_valid(`workflow_tweaks`) AND json_type(`workflow_tweaks`) = 'object' AND `workflow_tweaks` LIKE '%"instructions"%';
