-- ADR 0055 amendment of 2026-11-18 (owner's choice on 2026-11-18 at 02:59 UTC): each
-- login record names the route it ran, the sign-in methods it used and its item holds,
-- and why it did not use the best of them. Earlier rows keep null.
ALTER TABLE `login_timings` ADD `route` text;--> statement-breakpoint
ALTER TABLE `login_timings` ADD `used` text;--> statement-breakpoint
ALTER TABLE `login_timings` ADD `held` text;--> statement-breakpoint
ALTER TABLE `login_timings` ADD `route_why` text;