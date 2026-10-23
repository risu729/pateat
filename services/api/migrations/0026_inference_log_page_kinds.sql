-- ADR 0035 delivery 1: a generation request's `signedIn` hint, and the page kind and
-- `irreversible` answer of the model's plan, for the evaluation of `confirm` pages. Earlier
-- rows keep null in these columns, as do rows whose request or answer had none.
ALTER TABLE `inference_log` ADD `signed_in` integer;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `page_kind` text;--> statement-breakpoint
ALTER TABLE `inference_log` ADD `irreversible` text;
