-- ADR 0007 (proposed 2026-10-15, pending the owner's approval): the settings document holds
-- the protections setting. A stored document gets the defaults, which keep the owner's
-- earlier choices: passkey presence and verification asserted, and Bitwarden's master
-- password re-prompt not honoured.
UPDATE `settings`
SET `document` = json_set(
  `document`,
  '$.protections',
  json_object(
    'passkeyPresence', 'always',
    'passkeyVerification', 'always',
    'masterPasswordReprompt', 'ignore'
  )
)
WHERE json_type(`document`, '$.protections') IS NULL;
