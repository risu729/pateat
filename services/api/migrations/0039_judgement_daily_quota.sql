CREATE TABLE `judgement_quota_cutovers` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`day` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `judgement_reservations` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`device_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`branch` text NOT NULL,
	`revision` integer NOT NULL,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`prompt_version` text NOT NULL,
	`fingerprint` text NOT NULL,
	`started_at` integer NOT NULL,
	`day` integer NOT NULL,
	`state` text NOT NULL,
	`issued_count` integer DEFAULT 0 NOT NULL,
	`response_hash` text,
	`processing` integer DEFAULT true NOT NULL,
	`previous_at` integer,
	`previous_verdict` text,
	`previous_inputs` text,
	PRIMARY KEY(`owner_id`, `id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `judgement_reservations_day` ON `judgement_reservations` (`owner_id`,`recipe_id`,`day`);--> statement-breakpoint
ALTER TABLE `page_judgements` ADD `claim_id` text;
--> statement-breakpoint
-- Past repeated calls overwrote their cache rows, so their true count is unrecoverable.
-- Close existing recipe IDs for the remainder of the migration's UTC day only.
INSERT INTO judgement_quota_cutovers (owner_id, recipe_id, day)
SELECT owner_id, recipe_id, CAST(unixepoch('now') / 86400 AS INTEGER) * 86400000
FROM recipe_heads;
