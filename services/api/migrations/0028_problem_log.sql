CREATE TABLE `problem_log` (
	`owner_id` text NOT NULL,
	`device_id` text NOT NULL,
	`seq` integer NOT NULL,
	`extension_build` text NOT NULL,
	`level` text NOT NULL,
	`event` text NOT NULL,
	`fields` text NOT NULL,
	`logged_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`device_id`, `seq`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `problem_log_owner_created` ON `problem_log` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `problem_log_created` ON `problem_log` (`created_at`);
