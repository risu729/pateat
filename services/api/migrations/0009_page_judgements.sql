CREATE TABLE `page_judgements` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`revision` integer NOT NULL,
	`path` text NOT NULL,
	`judged_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`, `revision`, `path`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `page_judgements_day` ON `page_judgements` (`owner_id`,`recipe_id`,`judged_at`);
