-- Whose key made each logged model call (ADR 0040): the owner's credential on the service, or
-- a paired device's own key. Every row before this one was the service's.
ALTER TABLE `inference_log` ADD `source` text DEFAULT 'service' NOT NULL;
