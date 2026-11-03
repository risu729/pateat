-- Where Pateat's own time went in a login (ADR 0055 amendment of 2026-11-03); null in
-- rows of devices that sent none.
ALTER TABLE `login_timings` ADD `before_shown_ms` integer;--> statement-breakpoint
ALTER TABLE `login_timings` ADD `start_ms` integer;--> statement-breakpoint
ALTER TABLE `login_timings` ADD `await_ms` integer;--> statement-breakpoint
ALTER TABLE `login_timings` ADD `save_ms` integer;--> statement-breakpoint
ALTER TABLE `login_timings` ADD `status_ms` integer;--> statement-breakpoint
ALTER TABLE `login_timings` ADD `check_ms` integer;--> statement-breakpoint
ALTER TABLE `login_timings` ADD `vault_ms` integer;--> statement-breakpoint
ALTER TABLE `login_timings` ADD `command_ms` integer;
