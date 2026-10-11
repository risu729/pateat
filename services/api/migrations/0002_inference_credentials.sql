CREATE TABLE `inference_credentials` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`federation_rule_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`service_account_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "inference_credentials_kind_check" CHECK("inference_credentials"."kind" IN ('wif'))
);
