-- The owner web UI's theme, synced across the owner's browsers; null follows the
-- browser (architecture.md, Page styles and theme).
ALTER TABLE `owners` ADD `web_theme` text;
