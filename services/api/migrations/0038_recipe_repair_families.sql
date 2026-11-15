-- ADR 0041 and the ADR 0026 amendment of 2026-11-12: a device repairs a recipe's native
-- routes and its SSO entries once a UTC day each; earlier repairs were native ones.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recipe_repairs` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`device_id` text NOT NULL,
	`family` text DEFAULT 'native' NOT NULL,
	`revision` integer NOT NULL,
	`repaired_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`, `device_id`, `family`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_recipe_repairs`("owner_id", "recipe_id", "device_id", "family", "revision", "repaired_at") SELECT "owner_id", "recipe_id", "device_id", 'native', "revision", "repaired_at" FROM `recipe_repairs`;--> statement-breakpoint
DROP TABLE `recipe_repairs`;--> statement-breakpoint
ALTER TABLE `__new_recipe_repairs` RENAME TO `recipe_repairs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;