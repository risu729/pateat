-- Settings entries stored before account references named their server (ADR 0023) no
-- longer read, so the service's settings read failed on them. The owner chose to lose
-- them (2026-10-24): saved accounts, bindings and detail links without a server are
-- removed once, and are chosen again.
UPDATE `profiles` SET `document` = json_set(`document`, '$.siteDefaults', (
  SELECT json_group_array(json(`value`)) FROM json_each(`profiles`.`document`, '$.siteDefaults')
  WHERE json_type(`value`, '$.server') IS NOT NULL
))
WHERE json_valid(`document`) AND json_type(`document`, '$.siteDefaults') = 'array';
--> statement-breakpoint
UPDATE `settings` SET `document` = json_set(`document`, '$.bindings', (
  SELECT json_group_array(json(`value`)) FROM json_each(`settings`.`document`, '$.bindings')
  WHERE json_type(`value`, '$.server') IS NOT NULL
))
WHERE json_valid(`document`) AND json_type(`document`, '$.bindings') = 'array';
--> statement-breakpoint
UPDATE `settings` SET `document` = json_set(`document`, '$.detailLinks', (
  SELECT json_group_array(json(`value`)) FROM json_each(`settings`.`document`, '$.detailLinks')
  WHERE json_type(`value`, '$.server') IS NOT NULL
))
WHERE json_valid(`document`) AND json_type(`document`, '$.detailLinks') = 'array';
