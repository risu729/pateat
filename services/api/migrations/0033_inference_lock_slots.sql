-- Up to five model calls at a time per owner (ADR 0018): a lock held now keeps slot 0.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_inference_locks` (
	`owner_id` text NOT NULL,
	`slot` integer NOT NULL,
	`lock_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `slot`),
	FOREIGN KEY (`owner_id`) REFERENCES `owners`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_inference_locks`("owner_id", "slot", "lock_id", "expires_at") SELECT "owner_id", 0, "lock_id", "expires_at" FROM `inference_locks`;--> statement-breakpoint
DROP TABLE `inference_locks`;--> statement-breakpoint
ALTER TABLE `__new_inference_locks` RENAME TO `inference_locks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
