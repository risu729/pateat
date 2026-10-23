-- The owner's model configuration for each Claude role (ADR 0014, owner 2026-10-23), and
-- the effort and speed each logged call asked for. Earlier rows keep null in both columns.
CREATE TABLE `inference_model_configs` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `inference_log` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `speed` text;
