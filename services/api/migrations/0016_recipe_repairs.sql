-- Proposed ADR 0041: a generated recipe whose start page no longer matches is repaired at
-- most once a UTC day; each recipe keeps its last repair call.
CREATE TABLE `recipe_repairs` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`revision` integer NOT NULL,
	`repaired_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
