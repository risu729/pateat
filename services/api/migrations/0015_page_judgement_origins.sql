-- ADR 0022 (owner's choice on 2026-10-12 at 21:18 UTC): a page of another origin of a
-- recipe's site is judged too, so each judged page is keyed by its origin as well. Pateat
-- is unreleased: earlier rows are dropped rather than given an origin, and those pages
-- are judged again when they show.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_page_judgements` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`revision` integer NOT NULL,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`prompt_version` text DEFAULT '' NOT NULL,
	`judged_at` integer NOT NULL,
	`verdict` text,
	PRIMARY KEY(`owner_id`, `recipe_id`, `branch`, `revision`, `origin`, `path`, `prompt_version`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
DROP TABLE `page_judgements`;--> statement-breakpoint
ALTER TABLE `__new_page_judgements` RENAME TO `page_judgements`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `page_judgements_day` ON `page_judgements` (`owner_id`,`recipe_id`,`judged_at`);
