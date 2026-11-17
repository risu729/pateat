-- ADR 0029 amendment of 2026-11-17 (owner's choice on 2026-11-17 at 08:49 UTC): a path
-- that asks for a code sent to the person and then for an authenticator app's code, as
-- Luma's sign-in dialog does, keeps a judgement for each, keyed by where the page's code
-- comes from. Earlier rows keep an empty code source, which a page whose texts say
-- neither or both shares; a page that says one is judged again once.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_page_judgements` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`branch` text DEFAULT '' NOT NULL,
	`revision` integer NOT NULL,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`prompt_version` text DEFAULT '' NOT NULL,
	`code_source` text DEFAULT '' NOT NULL,
	`judged_at` integer NOT NULL,
	`verdict` text,
	`inputs` text,
	PRIMARY KEY(`owner_id`, `recipe_id`, `branch`, `revision`, `origin`, `path`, `prompt_version`, `code_source`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_page_judgements`("owner_id", "recipe_id", "branch", "revision", "origin", "path", "prompt_version", "code_source", "judged_at", "verdict", "inputs") SELECT "owner_id", "recipe_id", "branch", "revision", "origin", "path", "prompt_version", '', "judged_at", "verdict", "inputs" FROM `page_judgements`;--> statement-breakpoint
DROP TABLE `page_judgements`;--> statement-breakpoint
ALTER TABLE `__new_page_judgements` RENAME TO `page_judgements`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `page_judgements_day` ON `page_judgements` (`owner_id`,`recipe_id`,`judged_at`);