-- Attempts last 24 hours and carry no recipe ID yet, so they are not copied.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_generation_attempts` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`base_revision` integer NOT NULL,
	`attempted_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`, `path`, `base_revision`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
DROP TABLE `generation_attempts`;--> statement-breakpoint
ALTER TABLE `__new_generation_attempts` RENAME TO `generation_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
