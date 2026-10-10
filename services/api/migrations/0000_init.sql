CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `devices_owner_idx` ON `devices` (`owner_id`);--> statement-breakpoint
CREATE TABLE `owners` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recipe_heads` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`sequence` integer NOT NULL,
	`write_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recipe_heads_state_check" CHECK("recipe_heads"."state" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_heads_owner_sequence_unique` ON `recipe_heads` (`owner_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `recipe_revisions` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`document` text,
	`created_at` integer NOT NULL,
	`created_by_device_id` text NOT NULL,
	PRIMARY KEY(`owner_id`, `recipe_id`, `revision`),
	FOREIGN KEY (`created_by_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`recipe_id`) REFERENCES `recipe_heads`(`owner_id`,`recipe_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recipe_revisions_document_check" CHECK(("recipe_revisions"."state" = 'active' AND "recipe_revisions"."document" IS NOT NULL) OR ("recipe_revisions"."state" = 'revoked' AND "recipe_revisions"."document" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`document` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by_device_id` text NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
