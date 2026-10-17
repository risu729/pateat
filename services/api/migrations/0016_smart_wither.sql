CREATE TABLE `profiles` (
	`owner_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`document` text,
	PRIMARY KEY(`owner_id`, `id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO profiles (owner_id, id, name, document)
SELECT o.id, o.id, 'Default', CASE WHEN s.document IS NULL THEN NULL ELSE
json_object('excludedSites', json_extract(s.document, '$.excludedSites'), 'siteDefaults', json_extract(s.document, '$.siteDefaults')) END
FROM owners o LEFT JOIN settings s ON s.owner_id = o.id;
--> statement-breakpoint
UPDATE settings SET document = json_object('bindings', json_extract(document, '$.bindings'));
--> statement-breakpoint
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