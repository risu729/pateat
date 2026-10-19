CREATE TABLE `login_timings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`revision` integer NOT NULL,
	`origin` text NOT NULL,
	`outcome` text NOT NULL,
	`cause` text,
	`extension_build` text NOT NULL,
	`total_ms` integer NOT NULL,
	`service_ms` integer NOT NULL,
	`network_ms` integer NOT NULL,
	`person_ms` integer NOT NULL,
	`page_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `login_timings_owner_created` ON `login_timings` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `login_timings_created` ON `login_timings` (`created_at`);
