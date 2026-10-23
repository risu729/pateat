CREATE TABLE `profiles` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`document` text,
	`deleted_at` integer,
	PRIMARY KEY(`owner_id`, `id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Settings profiles (ADR 0024, ADR 0075). Each owner gets one profile named Default,
-- with the owner's ID and no document, and every device takes it. Stored settings are
-- reset, not converted (owner decision 2026-10-23): the first device to sync writes its
-- own settings into Default again.
INSERT INTO `profiles` (`owner_id`, `id`, `name`) SELECT `id`, `id`, 'Default' FROM `owners`;--> statement-breakpoint
DELETE FROM `settings`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer DEFAULT 0 NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`profile_id`) REFERENCES `profiles`(`owner_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_devices`("id", "owner_id", "profile_id", "token_hash", "label", "created_at", "last_used_at", "revoked_at") SELECT "id", "owner_id", "owner_id", "token_hash", "label", "created_at", "last_used_at", "revoked_at" FROM `devices`;--> statement-breakpoint
DROP TABLE `devices`;--> statement-breakpoint
ALTER TABLE `__new_devices` RENAME TO `devices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `devices_owner_idx` ON `devices` (`owner_id`);