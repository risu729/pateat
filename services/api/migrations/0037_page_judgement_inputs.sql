-- The digest of the inputs a judged page's description showed (ADR 0029 amendment of
-- 2026-11-06); null on rows kept before it, which a later `challenge` page judges again.
ALTER TABLE `page_judgements` ADD `inputs` text;