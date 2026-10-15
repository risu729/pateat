# ADR 0039: An allowlist of sites, and a vault timeout

Status: proposed, implemented pending the owner's approval. The plan's phase 4 item
"Settings to limit Pateat as an extension that handles personal data: only allowed sites
(an allowlist), and a choice of how long the vault stays unlocked, as the official
Bitwarden extension offers" is the owner's; every choice below is Claude's default,
pending the owner's confirmation. The owner asked on 2026-10-15 at 11:06 UTC for work
from the plan without asking (「Planに従って、実機後でやる前提で実装しかしてもいい」)
and at 11:10 UTC for complex designs to be implemented first and asked about on the pull
request
(「設計が複雑で聞いたほうがいいのは、とりあえず実装してこうしたがいいか？と後でプルリク出してから確認をして」).
Amends [ADR 0006](0006-atomic-local-vault-cache.md) (automatic unlock can now end on a
timeout the person chooses; the default keeps it) and
[ADR 0009](0009-install-time-https-site-access.md) (admission also needs the allowlist's
consent while it is on). No installed-Chrome or real-account check has been run.

Date: 2026-10-15

## Context

Pateat has install-time access to every HTTPS site ([ADR
0009](0009-install-time-https-site-access.md)) and, once a vault is connected, keeps its
unlock key on the device across browser restarts ([ADR
0006](0006-atomic-local-vault-cache.md)). The only limits were exclusion rules per
hostname and turning automatic unlock off by hand. The official Bitwarden extension
offers a vault timeout (immediately, 1, 5, 15 or 30 minutes, 1 or 4 hours, on system
idle, sleep or lock, on browser restart, never, or a custom time) that locks or logs
out; unlocking a locked Bitwarden vault needs only the master password, offline.

## Decision

### Allowlist

- The synced settings gain `allowedSites`, a list of the same rules as `excludedSites`
  (a hostname, optionally with its subdomains). While it is present, Pateat acts only on
  sites one of its rules covers; absent, it acts on every site no exclusion covers.
  An empty list allows no site. There is no separate on/off flag, so turning the
  allowlist off removes its rules.
- Exclusions win: a site an exclusion covers is refused whether or not it is allowed.
- A login that crosses hosts, such as a sign-in entry whose link leads to another host
  or a login form in a frame of another host, needs each host allowed, as each must not
  be excluded today.
- One check, `isSiteExcluded` in `packages/contracts/src/settings.ts`, now covers both,
  so every place that already stops on an excluded site (document admission, logins,
  sign-in entries, recipe generation, passkey answers, vault URI matches and the popup's
  account list) also stops outside the allowlist. `siteAccess` tells the two apart:
  admission logs `site-not-allowed` and the settings page says a default is unused
  because its site is not allowed.
- The list syncs through the service like the exclusions
  ([ADR 0013](0013-service-held-recipes-and-settings.md)). Whether it is on merges like
  one entry: a change on the service since the last sync wins, else a local change;
  its rules merge per hostname.
- The settings page has an "Allowed sites" panel: a "Run only on allowed sites" switch,
  the rules with Remove, and a form to allow a site, optionally with its subdomains.
  The popup's "Pateat on this site" switch follows the allowlist: turning it on adds
  the hostname's exact rule, turning it off removes that rule, or excludes the hostname
  when a rule with subdomains or a parent domain allows it. A site that is not allowed
  says so under the switch.
- The toolbar badge shows nothing on a site that is not allowed, as on an excluded site,
  since nothing runs there.
- No new permission: the allowlist narrows what Pateat does with the access it has.

### Vault timeout

- A device setting, never synced, stored in `chrome.storage.local`
  (`pateat.vault-timeout.v1`): never (the default, so ADR 0006's automatic unlock
  across restarts is unchanged), on browser restart, or after 1, 5, 15 or 30 minutes,
  1 or 4 hours unused. Every choice but never also locks on browser restart, as
  Bitwarden's do. Bitwarden's system idle, sleep and lock choices need the `idle`
  permission and are left out; "immediately" is left out because Pateat could then never
  fill a login.
- Locking is the settings page's "Disable automatic unlock" for every vault on the
  device: the retained unlock key and the sync sign-in are removed, and the person signs
  in again with the master password to unlock. Pateat has no offline unlock yet, so
  this is closer to Bitwarden's "log out" than to its "lock".
- Unused means no field read for a login and no passkey signed since the vault was last
  used or unlocked (a sign-in on the settings page counts). Opening pages, matching
  vault URIs and syncing do not count, since they happen on every page and would keep
  the vault unlocked while the person browses. Changing the setting starts the time
  again.
- A browser restart is detected by the absence of a `chrome.storage.session` record that
  holds the last use; that storage is also cleared when the extension is reloaded or
  updated, so those lock too. The worker checks at each start, on a `chrome.alarms`
  alarm set for the moment the timeout would pass, before each restore of a vault (every
  login, passkey answer and settings read builds the vault catalog first) and before
  each vault sync, automatic or from the settings page. A check that cannot tell whether
  the time passed, or a lock that fails, keeps logins, passkey answers and syncs from
  using the vault, and the lock is tried again a minute later. A sign-in starts the time
  again before it begins, so a check during it cannot lock the vault it unlocks. After a
  lock, a vault that unlocks automatically again was signed in to, so the time counts
  from then even when that sign-in could not report itself. Until the next check, a key
  the timeout would remove stays on the disk, also while the browser is closed.
- The settings page writes the setting to `chrome.storage.local` directly; the worker
  follows its changes. No new permission (`alarms` and `storage` were already granted).

## Consequences

- A person who wants Pateat only on a few sites can say so once, and a site added to the
  vault later does not start logging in by itself.
- Turning the allowlist on with no rules stops every login until a site is allowed.
- A timed-out vault needs a full sign-in, which may ask for two-step login, before the
  next login. A short timeout makes Pateat ask often.
- The vault timeout cannot remove a key from a browser that is not running; it removes
  it at the next start, before any vault use.

## Alternatives

- A separate on/off flag beside a kept allowlist would keep the rules while it is off,
  but adds a second field to merge and a state where rules exist yet do nothing.
- Allow rules as a kind of exclusion rule (one list with a `mode`) would change the
  exclusion shape everywhere it is read.
- Keeping the unlock key only in `chrome.storage.session` for the restart choice would
  never leave it on disk, but splits the vault record of
  [ADR 0006](0006-atomic-local-vault-cache.md) into two stores; checking at start keeps
  one record.
- A local unlock with the master password, as Bitwarden has, would make a short timeout
  practical; it is left for later.
