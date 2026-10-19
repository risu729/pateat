-- Added in place: rebuilding `recipe_heads` would drop rows that recipe revisions
-- reference, which D1's always-on foreign keys refuse. Existing recipes count as last used
-- at the newest of their last write and their last reported login (ADR 0058).
ALTER TABLE `recipe_heads` ADD `last_used_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `recipe_heads` SET `last_used_at` = MAX(`updated_at`, COALESCE((SELECT MAX(`created_at`) FROM `login_timings` WHERE `login_timings`.`owner_id` = `recipe_heads`.`owner_id` AND `login_timings`.`recipe_id` = `recipe_heads`.`recipe_id`), 0));
