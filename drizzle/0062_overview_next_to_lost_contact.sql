-- The Overview's Next card became the Lost contact card: a saved layout keeps that card's place (and
-- whether it shows) under its new id.
UPDATE `projects` SET `layout` = REPLACE(`layout`, '"overview.next"', '"overview.lostContact"') WHERE `layout` LIKE '%"overview.next"%';
