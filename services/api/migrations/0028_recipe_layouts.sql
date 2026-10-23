-- Recipes are stored as up to three layouts from here on (ADR 0060). Existing recipes are
-- discarded rather than migrated (the owner's decision in ADR 0060): every revision and
-- head goes, and with them every row of the judged pages, generation attempts and
-- first-login results, whose `branch` named a route the old way. Devices of this build
-- drop their cached recipes and sync again from the start; the request log and login
-- records stay.
CREATE TABLE `recipe_layout_uses` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`layout` text NOT NULL,
	`last_used_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`, `layout`),
	FOREIGN KEY (`owner_id`,`recipe_id`) REFERENCES `recipe_heads`(`owner_id`,`recipe_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `inference_log` ADD `layout` text;--> statement-breakpoint
DELETE FROM `recipe_revisions`;--> statement-breakpoint
DELETE FROM `recipe_heads`;--> statement-breakpoint
DELETE FROM `page_judgements`;--> statement-breakpoint
DELETE FROM `generation_attempts`;--> statement-breakpoint
DELETE FROM `login_outcomes`;
