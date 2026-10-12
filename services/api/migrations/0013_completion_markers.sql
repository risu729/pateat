-- ADR 0029 (owner's choice on 2026-10-12 at 18:07 UTC): a recipe's completion becomes a
-- list of signed-in markers without a path, so each stored completion becomes a
-- one-marker list. A marker whose locator another element of the recipe also uses would
-- now prove a sign-in wherever that element shows, so that completion is left out instead:
-- the recipe then completes on the sign-in state, as one with no marker does.
UPDATE `recipe_revisions`
SET `document` = CASE
  WHEN EXISTS (
    SELECT 1 FROM json_tree(`recipe_revisions`.`document`) AS `node`
    WHERE `node`.`type` = 'object'
      AND `node`.`fullkey` NOT LIKE '%.completion%'
      AND json_extract(`node`.`value`, '$.by') = json_extract(`recipe_revisions`.`document`, '$.completion.target.by')
      AND json_extract(`node`.`value`, '$.value') = json_extract(`recipe_revisions`.`document`, '$.completion.target.value')
  ) THEN json_remove(`document`, '$.completion')
  ELSE json_set(`document`, '$.completion', json_array(json_remove(json_extract(`document`, '$.completion'), '$.path')))
END
WHERE `document` IS NOT NULL AND json_type(`document`, '$.completion') = 'object';
--> statement-breakpoint
UPDATE `recipe_revisions`
SET `document` = CASE
  WHEN EXISTS (
    SELECT 1 FROM json_tree(`recipe_revisions`.`document`) AS `node`
    WHERE `node`.`type` = 'object'
      AND `node`.`fullkey` NOT LIKE '%.completion%'
      AND json_extract(`node`.`value`, '$.by') = json_extract(`recipe_revisions`.`document`, '$.chooser.afterAccount.completion.target.by')
      AND json_extract(`node`.`value`, '$.value') = json_extract(`recipe_revisions`.`document`, '$.chooser.afterAccount.completion.target.value')
  ) THEN json_remove(`document`, '$.chooser.afterAccount.completion')
  ELSE json_set(`document`, '$.chooser.afterAccount.completion', json_array(json_remove(json_extract(`document`, '$.chooser.afterAccount.completion'), '$.path')))
END
WHERE `document` IS NOT NULL AND json_type(`document`, '$.chooser.afterAccount.completion') = 'object';
--> statement-breakpoint
UPDATE `recipe_revisions`
SET `document` = CASE
  WHEN EXISTS (
    SELECT 1 FROM json_tree(`recipe_revisions`.`document`) AS `node`
    WHERE `node`.`type` = 'object'
      AND `node`.`fullkey` NOT LIKE '%.completion%'
      AND json_extract(`node`.`value`, '$.by') = json_extract(`recipe_revisions`.`document`, '$.chooser.afterOther.completion.target.by')
      AND json_extract(`node`.`value`, '$.value') = json_extract(`recipe_revisions`.`document`, '$.chooser.afterOther.completion.target.value')
  ) THEN json_remove(`document`, '$.chooser.afterOther.completion')
  ELSE json_set(`document`, '$.chooser.afterOther.completion', json_array(json_remove(json_extract(`document`, '$.chooser.afterOther.completion'), '$.path')))
END
WHERE `document` IS NOT NULL AND json_type(`document`, '$.chooser.afterOther.completion') = 'object';
