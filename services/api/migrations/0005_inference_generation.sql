CREATE TABLE `generation_attempts` (
	`owner_id` text NOT NULL,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`base_revision` integer NOT NULL,
	`attempted_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `origin`, `path`, `base_revision`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `inference_locks` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`lock_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `inference_log` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`role` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`request` text NOT NULL,
	`result` text,
	`outcome` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_micro_usd` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inference_log_role_check" CHECK("inference_log"."role" IN ('generate', 'judge'))
);
--> statement-breakpoint
CREATE INDEX `inference_log_owner_created` ON `inference_log` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `inference_log_created` ON `inference_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `inference_spend` (
	`owner_id` text NOT NULL,
	`period` text NOT NULL,
	`calls` integer NOT NULL,
	`cost_micro_usd` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `period`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
