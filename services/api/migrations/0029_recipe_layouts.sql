-- Recipes are stored as up to three layouts from here on (ADR 0060). Existing recipes are
-- discarded rather than migrated (the owner's decision in ADR 0060): every revision and
-- head goes, and with them every row of the judged pages, generation attempts and
-- first-login results, whose `branch` named a route the old way. Devices of this build
-- drop their cached recipes and sync again from the start; the request log and login
-- records stay. `recipe_unit_sources` records which call made each part of a recipe from
-- here on; it starts empty, as every recipe is generated again.
CREATE TABLE `recipe_layout_uses` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`layout` text NOT NULL,
	`last_used_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`, `layout`),
	FOREIGN KEY (`owner_id`,`recipe_id`) REFERENCES `recipe_heads`(`owner_id`,`recipe_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recipe_unit_sources` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`layout` text,
	`unit` text NOT NULL,
	`digest` text NOT NULL,
	`revision` integer NOT NULL,
	`origin` text NOT NULL,
	`provider` text,
	`model` text,
	`effort` text,
	`speed` text,
	`prompt_version` text,
	`build` text NOT NULL,
	`device_id` text,
	`log_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`recipe_id`) REFERENCES `recipe_heads`(`owner_id`,`recipe_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recipe_unit_sources_origin_check" CHECK("recipe_unit_sources"."origin" IN ('generated', 'judged', 'device'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_unit_sources_unit_unique` ON `recipe_unit_sources` (`owner_id`,`recipe_id`,`layout`,`unit`);--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_unit_sources_entry_unique` ON `recipe_unit_sources` (`owner_id`,`recipe_id`,`unit`) WHERE "recipe_unit_sources"."layout" IS NULL;--> statement-breakpoint
CREATE INDEX `recipe_unit_sources_owner_unit` ON `recipe_unit_sources` (`owner_id`,`unit`);--> statement-breakpoint
ALTER TABLE `inference_log` ADD `layout` text;--> statement-breakpoint
DELETE FROM `recipe_revisions`;--> statement-breakpoint
DELETE FROM `recipe_heads`;--> statement-breakpoint
DELETE FROM `page_judgements`;--> statement-breakpoint
DELETE FROM `generation_attempts`;--> statement-breakpoint
DELETE FROM `login_outcomes`;
