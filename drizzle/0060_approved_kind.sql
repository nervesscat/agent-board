-- Approved gets a stage kind of its own (the human's go-ahead to merge), and Release, where a merged
-- ticket waits for a release, counts as finished: kind done. Only a stage keyed `approved` or `release`
-- that still has the kind `review` changes; any other stage, and either key with another kind, is kept.
UPDATE `stages` SET `kind` = 'approved' WHERE `key` = 'approved' AND `kind` = 'review';
--> statement-breakpoint
UPDATE `stages` SET `kind` = 'done' WHERE `key` = 'release' AND `kind` = 'review';
