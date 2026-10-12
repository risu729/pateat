PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_generation_attempts` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`base_revision` integer NOT NULL,
	`attempted_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`, `branch`, `path`, `base_revision`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_generation_attempts`("owner_id", "recipe_id", "branch", "origin", "path", "base_revision", "attempted_at") SELECT "owner_id", "recipe_id", '', "origin", "path", "base_revision", "attempted_at" FROM `generation_attempts`;--> statement-breakpoint
DROP TABLE `generation_attempts`;--> statement-breakpoint
ALTER TABLE `__new_generation_attempts` RENAME TO `generation_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_page_judgements` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`revision` integer NOT NULL,
	`path` text NOT NULL,
	`judged_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`, `branch`, `revision`, `path`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_page_judgements`("owner_id", "recipe_id", "branch", "revision", "path", "judged_at") SELECT "owner_id", "recipe_id", '', "revision", "path", "judged_at" FROM `page_judgements`;--> statement-breakpoint
DROP TABLE `page_judgements`;--> statement-breakpoint
ALTER TABLE `__new_page_judgements` RENAME TO `page_judgements`;--> statement-breakpoint
CREATE INDEX `page_judgements_day` ON `page_judgements` (`owner_id`,`recipe_id`,`judged_at`);
