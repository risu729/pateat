PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_recipe_revisions` (
	`owner_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`document` text,
	`created_at` integer NOT NULL,
	`created_by_device_id` text,
	PRIMARY KEY(`owner_id`, `recipe_id`, `revision`),
	FOREIGN KEY (`created_by_device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`,`recipe_id`) REFERENCES `recipe_heads`(`owner_id`,`recipe_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "recipe_revisions_document_check" CHECK(("__new_recipe_revisions"."state" = 'active' AND "__new_recipe_revisions"."document" IS NOT NULL) OR ("__new_recipe_revisions"."state" = 'revoked' AND "__new_recipe_revisions"."document" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_recipe_revisions`("owner_id", "recipe_id", "revision", "state", "document", "created_at", "created_by_device_id") SELECT "owner_id", "recipe_id", "revision", "state", "document", "created_at", "created_by_device_id" FROM `recipe_revisions`;--> statement-breakpoint
DROP TABLE `recipe_revisions`;--> statement-breakpoint
ALTER TABLE `__new_recipe_revisions` RENAME TO `recipe_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
