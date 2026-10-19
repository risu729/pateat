-- ADR 0012 (amended on the owner's choice on 2026-10-18 at 08:38 UTC): how long each logged
-- request took before the model, in the token exchange, in the model and in the Worker.
-- Earlier rows keep null in these columns, as do the first three on a row answered
-- without a model call.
ALTER TABLE `inference_log` ADD `pre_model_ms` integer;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `token_ms` integer;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `model_ms` integer;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `server_ms` integer;
