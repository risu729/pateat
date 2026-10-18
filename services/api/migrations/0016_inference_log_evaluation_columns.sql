-- ADR 0012 (owner's choice on 2026-10-18 at 06:08 UTC): the request log keeps what a
-- real-page evaluation corpus needs: the recipe, branch and revisions a call is for, the
-- service build, a hash of the observation and the model's own answer. Earlier rows keep
-- null in these columns; nothing is filled in for them.
ALTER TABLE `inference_log` ADD `answer` text;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `recipe_id` text;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `base_revision` integer;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `revision` integer;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `recipe_page` text;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `build` text;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `observation_hash` text;--> statement-breakpoint
CREATE INDEX `inference_log_owner_recipe` ON `inference_log` (`owner_id`,`recipe_id`);
