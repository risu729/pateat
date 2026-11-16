-- ADR 0031, amended 2026-11-16: an entry recipe revision a device found leads nowhere,
-- kept per owner so every device's recipe sync skips it; one row per recipe head.
CREATE TABLE `recipe_entry_blocks` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`revision` integer NOT NULL,
	`reason` text NOT NULL,
	`device_id` text NOT NULL,
	`blocked_at` integer NOT NULL,
	`write_id` text NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`),
	FOREIGN KEY (`owner_id`,`recipe_id`) REFERENCES `recipe_heads`(`owner_id`,`recipe_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recipe_entry_blocks_reason_check" CHECK("recipe_entry_blocks"."reason" IN ('left-site', 'no-sign-in', 'sign-up'))
);
