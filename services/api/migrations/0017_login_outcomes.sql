-- ADR 0019 and ADR 0012 (owner's choice on 2026-10-18 at 06:08 UTC): how the first login of
-- each recipe revision ended, as value-free result codes a device sends, kept one year with
-- the request log and deleted with it.
CREATE TABLE `login_outcomes` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`revision` integer NOT NULL,
	`outcome` text NOT NULL,
	`cause` text,
	`step` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`, `branch`, `revision`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `login_outcomes_created` ON `login_outcomes` (`created_at`);
