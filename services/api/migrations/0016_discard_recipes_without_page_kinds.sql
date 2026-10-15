-- ADR 0035: every route recipe and chooser branch now records its page's kind. A recipe
-- stored before it has none and no longer parses, so it is discarded with its generation
-- attempts and page judgements, and a later visit generates it again
-- (docs/development.md#compatibility-before-release). Entry recipes and choosers without
-- a branch keep their shape and stay.
DELETE FROM `generation_attempts` WHERE (`owner_id`, `recipe_id`) IN (
  SELECT `owner_id`, `recipe_id` FROM `recipe_revisions`
  WHERE (json_type(`document`, '$.steps') IS NOT NULL AND json_type(`document`, '$.pageKind') IS NULL)
    OR (json_type(`document`, '$.chooser.afterAccount') IS NOT NULL AND json_type(`document`, '$.chooser.afterAccount.pageKind') IS NULL)
    OR (json_type(`document`, '$.chooser.afterOther') IS NOT NULL AND json_type(`document`, '$.chooser.afterOther.pageKind') IS NULL)
);--> statement-breakpoint
DELETE FROM `page_judgements` WHERE (`owner_id`, `recipe_id`) IN (
  SELECT `owner_id`, `recipe_id` FROM `recipe_revisions`
  WHERE (json_type(`document`, '$.steps') IS NOT NULL AND json_type(`document`, '$.pageKind') IS NULL)
    OR (json_type(`document`, '$.chooser.afterAccount') IS NOT NULL AND json_type(`document`, '$.chooser.afterAccount.pageKind') IS NULL)
    OR (json_type(`document`, '$.chooser.afterOther') IS NOT NULL AND json_type(`document`, '$.chooser.afterOther.pageKind') IS NULL)
);--> statement-breakpoint
DELETE FROM `recipe_revisions` WHERE (`owner_id`, `recipe_id`) IN (
  SELECT `owner_id`, `recipe_id` FROM `recipe_revisions`
  WHERE (json_type(`document`, '$.steps') IS NOT NULL AND json_type(`document`, '$.pageKind') IS NULL)
    OR (json_type(`document`, '$.chooser.afterAccount') IS NOT NULL AND json_type(`document`, '$.chooser.afterAccount.pageKind') IS NULL)
    OR (json_type(`document`, '$.chooser.afterOther') IS NOT NULL AND json_type(`document`, '$.chooser.afterOther.pageKind') IS NULL)
);--> statement-breakpoint
DELETE FROM `recipe_heads` WHERE NOT EXISTS (
  SELECT 1 FROM `recipe_revisions`
  WHERE `recipe_revisions`.`owner_id` = `recipe_heads`.`owner_id`
    AND `recipe_revisions`.`recipe_id` = `recipe_heads`.`recipe_id`
);
