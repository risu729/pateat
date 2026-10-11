-- Added in place: rebuilding `devices` would drop rows that settings, recipe revisions
-- and enrollments reference, which D1's always-on foreign keys refuse. Existing devices
-- count as last used when they were paired.
ALTER TABLE `devices` ADD `last_used_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `devices` SET `last_used_at` = `created_at`;
