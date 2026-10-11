PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`document` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_device_id` text,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_settings`("owner_id", "revision", "document", "updated_at", "updated_by_device_id") SELECT "owner_id", "revision", "document", "updated_at", "updated_by_device_id" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
