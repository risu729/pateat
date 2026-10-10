CREATE TABLE `enrollments` (
	`challenge` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`label` text NOT NULL,
	`approved_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`redeemed_at` integer,
	`device_id` text,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "enrollments_redemption_check" CHECK(("enrollments"."redeemed_at" IS NULL) = ("enrollments"."device_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `enrollments_expires_idx` ON `enrollments` (`expires_at`);--> statement-breakpoint
CREATE TABLE `owner_identities` (
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`issuer`, `subject`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `owner_identities_owner_idx` ON `owner_identities` (`owner_id`);--> statement-breakpoint
ALTER TABLE `devices` ADD `label` text DEFAULT '' NOT NULL;