-- ADR 0041: a device asks to repair a generated recipe at most once a UTC day;
-- each recipe and device keeps its last repair call.
CREATE TABLE `recipe_repairs` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`device_id` text NOT NULL,
	`revision` integer NOT NULL,
	`repaired_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`, `device_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
