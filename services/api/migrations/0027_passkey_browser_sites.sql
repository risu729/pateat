-- ADR 0007 (owner's request on 2026-10-23 at 12:15 UTC): the settings document gains the
-- synced `passkeyBrowserSites` list, the hostnames whose passkey requests Pateat hands to
-- the browser. Every stored document is validated on read and the list is required, so
-- each one written before it gets an empty list; no site is listed until a person chooses
-- "Always for this site" in the passkey chooser.
UPDATE `settings`
SET `document` = json_set(`document`, '$.passkeyBrowserSites', json_array())
WHERE json_type(`document`) = 'object' AND json_type(`document`, '$.passkeyBrowserSites') IS NULL;
