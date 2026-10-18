-- ADR 0012 (owner's choice on 2026-10-18 at 08:04 UTC): a generation or judgement request
-- answered without a model call is logged too, with no provider or model. Number 0017 is
-- left to the login outcomes table of a change stacked beside this one.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_inference_log` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`role` text NOT NULL,
	`provider` text,
	`model_id` text,
	`prompt_version` text,
	`origin` text NOT NULL,
	`path` text NOT NULL,
	`request` text NOT NULL,
	`result` text,
	`answer` text,
	`outcome` text NOT NULL,
	`recipe_id` text,
	`branch` text,
	`base_revision` integer,
	`revision` integer,
	`recipe_page` text,
	`build` text,
	`observation_hash` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_micro_usd` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inference_log_role_check" CHECK("__new_inference_log"."role" IN ('generate', 'judge'))
);
--> statement-breakpoint
INSERT INTO `__new_inference_log`("id", "owner_id", "role", "provider", "model_id", "prompt_version", "origin", "path", "request", "result", "answer", "outcome", "recipe_id", "branch", "base_revision", "revision", "recipe_page", "build", "observation_hash", "input_tokens", "output_tokens", "cost_micro_usd", "created_at") SELECT "id", "owner_id", "role", "provider", "model_id", "prompt_version", "origin", "path", "request", "result", "answer", "outcome", "recipe_id", "branch", "base_revision", "revision", "recipe_page", "build", "observation_hash", "input_tokens", "output_tokens", "cost_micro_usd", "created_at" FROM `inference_log`;--> statement-breakpoint
DROP TABLE `inference_log`;--> statement-breakpoint
ALTER TABLE `__new_inference_log` RENAME TO `inference_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `inference_log_owner_created` ON `inference_log` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `inference_log_owner_recipe` ON `inference_log` (`owner_id`,`recipe_id`);--> statement-breakpoint
CREATE INDEX `inference_log_created` ON `inference_log` (`created_at`);
