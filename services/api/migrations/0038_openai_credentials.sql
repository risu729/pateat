CREATE TABLE `openai_credentials` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
