# Privacy policy

::: warning Draft
This policy is a draft written for Pateat's first public release and the Chrome Web
Store listing. It describes the extension as it is built today, has not been reviewed by
a lawyer, and is not in effect yet.
:::

Pateat is a Chrome extension that logs in to websites with the accounts in your own
Bitwarden vault. It is developed by [risu729](https://github.com/risu729) as open source
software; its source code is on [GitHub](https://github.com/risu729/pateat). Questions
about this policy can be sent to [pateat@takuk.me](mailto:pateat@takuk.me).

Pateat has no analytics, advertising or tracking, and the developer receives no data
from the extension. Data leaves your device only to reach the services below: your
Bitwarden server, the Pateat service you pair with, which runs on Cloudflare and uses
Anthropic's Claude, Anthropic directly if you save your own Anthropic API key, and the
websites you log in to.

## On your device

Pateat stores the following in the extension's own storage in Chrome. Websites cannot
read it, and removing the extension deletes it.

- **Your vault, encrypted.** A copy of each connected Bitwarden vault, as Bitwarden
  encrypts it.
- **The unlock key.** A key that decrypts that copy while the vault is unlocked. With
  the vault timeout **Never**, it is kept in the extension's storage so that the vault
  unlocks by itself after Chrome restarts; your operating system's key store does not
  protect it. With any other timeout it is kept in memory only. **Lock** and
  **Log out** remove it.
- **The Bitwarden sync sign-in**, which lets Pateat sync the vault again without your
  master password. Your master password and verification codes are never stored. When
  you unlock a vault, or enter the master password for an item marked with re-prompt,
  Pateat checks it on your device and sends it nowhere.
- **Your Anthropic API key**, if you save one, with what it spent today and this month.
  It is stored without encryption and sent only to Anthropic.
- **Each connection's details**: its name, the Bitwarden server, your email address and
  the device identifier Pateat uses with Bitwarden.
- **Settings and recipes** synced with your Pateat service, among them the item and
  field limits you set for each vault and which vault item holds each personal detail a
  site asked for; the vault timeout, which stays on this device; and the pairing
  credential for the service.
- **Login progress**: for each tab and site, how far a login went, which account you
  picked, and whether you logged out or signed in with a passkey, kept so that a login
  is not repeated or resumed by mistake.
- **A diagnostics log** of what Pateat did, for bug reports. It records sites, page
  addresses with their parameter names but not their values, and tab IDs, and never
  vault values. Entries are kept for at most 14 days. Its warnings, errors and the
  reasons Pateat did nothing are also sent to your Pateat service, as described below;
  the rest stays on your device unless you download it and share it yourself.

Vault values are decrypted only on your device, by the official Bitwarden SDK running in
the extension. A value leaves the extension only into a login page of a site where that
item may be used: a site that matches the item's website in your vault, or one you chose
the item for. A personal detail from an identity or card item, such as a card number,
which has no website, goes only into the site of the login item you linked it to, after
you confirmed the link in the popup.

## Your Bitwarden server

Pateat talks to the Bitwarden server you chose (Bitwarden Cloud US, Bitwarden Cloud EU,
your own Bitwarden server or Vaultwarden) directly from your browser, the way
Bitwarden's own apps do: to look up your account's key settings, to sign in with your
email, a hash derived from your master password, any verification code you enter and a
device identifier and name (so Pateat appears in Bitwarden's list of your devices), to
ask the server to email you a verification code when you choose that method, to sync
your encrypted vault, and to read the server's version for the diagnostics page.
Bitwarden's [privacy policy](https://bitwarden.com/privacy/) covers what that server
keeps.

## Your Pateat service

Pateat syncs its settings and recipes with a Pateat service that you pair it with. Each
service is run by its owner, who can read what it stores; today every service is used
only by the person who runs it. The extension sends the service:

- **The device name** you enter when pairing, and the settings profile you chose or the
  name of a new one. The service also records when the device paired and when it was
  last used, and identifies you by the account you signed in to the service with.
- **Settings**: for each settings profile, the sites you excluded, the sites that ask
  for the master password, the sites whose passkey requests you hand to the browser, the
  default account for each site, which vault accounts, groups, items and fields Pateat
  may use, a fingerprint (hash) of each item's encrypted custom fields when you last
  reviewed them, and whether the popup shows **This page**; and, for all profiles, which
  vault field fills which part of a site's login and which vault item and field gives
  each personal detail a site asks for. Default accounts, item and field limits and
  field choices are identified by vault item and account IDs, with the item's, the
  connection's and the selected groups' names and the names of custom fields. A
  personal-detail link is identified by item and account IDs and the field (a custom
  field by its name) only, with no item name, and with the site's secret question in
  normalized form when you confirmed one. No vault values are sent.
- **Page descriptions**, when a site has no recipe yet, its recipe no longer matches
  the page, or a login needs the next page described. Pateat describes a login page, a
  page that lists accounts to choose from, a page that asks for a personal detail, and
  a page that only offers a way to the sign-in page, such as a site's home page with a
  **Sign in** button. A description holds the site's address without its query string
  or fragment, with parts of the path that look like IDs, tokens or email addresses
  replaced by `[id]`;
  the page's title, language and headings; for its form fields, checkboxes, buttons and
  links, their labels, names, placeholders, descriptions, input hints (such as an
  expected length or `autocomplete` value), their `id`, `name`, `data-testid` and
  `data-test` attributes, and their text; and the text of up to 8 accounts the page
  lists, such as `Taro [email] Last used`. A page's on-screen keyboard is described by
  its container's `id`, `data-testid` or class, never its keys, and a choice list by
  its label, never its options. Field values, hidden fields, the page's HTML and
  screenshots are never sent.
- **What is hidden before sending**: email addresses, masked text and long numbers in
  the page's text are replaced with placeholders, and so are your usernames for that
  site wherever they appear in it. A link or button whose address or name holds such a
  username is left out, and a page whose path holds one is not sent. A username stays
  visible when it is shorter than three characters, when only the part of an email
  address before the `@` is shown, when it is part of the site's host name (such as
  `taro.example.com`), when you excluded it from Pateat, or when the vault holding it
  could not be read. The `id`, `name` and `data-test` attribute values of a login page's
  controls are sent as the page has them. Other names shown on the page, such as a
  display name, cannot be detected and are sent as shown.
- **What the login needs from your vault**, alongside the description of a login page,
  a page that asks for a personal detail or a page after a login: the names of the
  custom fields that could fill the page and, for the username and for text custom
  fields, their shape: the length, which kinds of characters occur (such as digits or
  letters) and whether it is an email address. The values themselves are never sent,
  nor any shape of a hidden field. A page that lists accounts or only leads to the
  sign-in page is sent without them.
- **Signed-in pages.** After a login, the page shown is described the same way,
  together with its header text, the addresses of its links, any open dialog and the
  texts near a code field or the buttons, with every number replaced, so that the
  service can judge whether the login worked. Once a site's recipe works, each device
  still sends its signed-in page at most once every 30 days, to check later that the
  recipe keeps signing in.
- **Recipe use**: when a login on a recipe starts, including one that only fills, the
  recipe, its revision and the layout used, so that the service knows the recipe is
  still in use.
- **Login records**
  ([ADR 0055](https://github.com/risu729/pateat/blob/main/docs/adr/0055-login-records-sent-to-the-service.md)):
  when a login that follows a recipe ends,
  how it ended (a fixed code such as signed in or blocked, and why), the extension's
  version and how long it took, split into the time spent waiting for the service, for
  the network, for the site, and for you, such as while you typed a verification code.
  No address, page text, username or value is sent with a record, but the service knows
  the site from the recipe, so these records show when and on which sites you log in.
- **Problem reports**
  ([ADR 0066](https://github.com/risu729/pateat/blob/main/docs/adr/0066-problem-lines-sent-to-the-service.md)):
  automatically, each warning and error line of the diagnostics log, and each line that
  says why Pateat did nothing on a page, with its time, the extension's build and the
  log's random ID. A line holds only fixed codes, error names and positions in
  Pateat's own code, counts, flags, recipe IDs, tab IDs, the sites a passkey was asked
  for, and sites: a site you have not set up is sent as a code the service cannot turn
  back into the site. For some lines
  written before a login submitted anything, it holds the page's path, with IDs, tokens
  and email addresses replaced as in a page description; a username in such a path is
  not hidden. Values, page text and query strings are never sent. There is no setting
  to turn these reports off yet.

The service stores the recipes it writes, with which model wrote each part, when, and
from which device's request, until that part is removed. It removes a recipe, or one of
its alternative layouts, that has not been used for 90 days, and keeps a record that a
removed recipe existed. It keeps the page descriptions it receives, with Claude's answer
when Claude was asked, the login records and the problem reports, to show you on its
dashboard, to evaluate and improve recipe writing, and to find and fix Pateat's
failures. These are kept for one year. There is no scheduled removal: older entries are
removed when a later page description, login record, problem report or recipe sync
reaches the service. It also keeps, for each page Claude judged, the site, the page's
path, when and with what result, until the site's recipe changes; and, for ten minutes,
the site and path of each recipe it was asked to write, to avoid writing the same one
twice.

The developer may publish reviewed page descriptions from the developer's own service,
which holds only the developer's own logins, as evaluation data, with names and shapes
from the vault replaced by made-up ones. Nothing from anyone else's service is
published.

The device credential the service gives the extension expires after 90 days without
use.

## Cloudflare

A Pateat service runs on Cloudflare: its code on Cloudflare Workers, its data in
Cloudflare D1, and the sign-in to its pairing and management pages through Cloudflare
Access. Everything the extension sends to the service passes through and is stored at
Cloudflare, under the terms of the service owner's Cloudflare account, and Cloudflare
keeps the service's request logs, with the query part of each address removed.

## Anthropic

To write a recipe or judge a login, your Pateat service sends the page description and
what the login needs from your vault, as above, to Claude, Anthropic's AI model, using
the Claude credentials its owner set up, under the terms of that owner's Anthropic
account. The owner chooses the Claude model on the
service's **Claude** page; without a choice the service uses Claude Opus 5.5, and asks
Claude Sonnet 5.5 once when Opus 5.5 declines a request.

If you saved an Anthropic API key on your device, the service instead hands the request
it wrote back to the extension, which sends it to Anthropic with your key, and sends
Anthropic's answer back to the service, which keeps it as above. Anthropic then handles
the request under the terms of the account the key belongs to. The key is never sent to
the service.

Pateat never sends Anthropic vault values, login records, problem reports or the
signed-in pages sent once every 30 days.

## The websites you log in to

To log in, Pateat fills your username, password, one-time codes and other vault fields
into the site's login form, and answers the site's passkey requests with a passkey
signature. The site receives these as it would from you, under its own privacy policy.
On a plain HTTP page, which Pateat uses only for items saved with an `http://` address,
what it fills travels unencrypted
([permissions](./permissions.md#plain-http-pages)).

## Connection information

The services above, and the websites you log in to, receive your IP address and other
connection information whenever Pateat contacts them, as for any web request. They may
keep it in their own operational logs under their own policies; Pateat cannot delete it
there.

## Deleting your data

- **On your device**: delete a vault connection on the settings page, or remove the
  extension from Chrome. Removing the extension does not revoke its device on the
  service; disconnect it on the settings page first, or revoke it on the service's
  **Devices** page.
- **On the service**: its pages let you remove excluded sites, default accounts and
  field choices, and revoke recipes and their layouts, though a revoked recipe leaves a
  record that it was revoked. Sites that ask for the master password are removed in the
  extension. **Delete all** on the **Request log** page deletes every stored page
  description, login record and problem report, and removes the device and request from
  the record of which model wrote each recipe part. A settings profile no device uses,
  other than the last one, can be deleted on the **Profiles** page, which deletes its
  site settings, default accounts and item and field limits; the profile's name stays
  for the devices that used it. Disconnecting or revoking a device stops it from syncing
  but keeps its record. These have no delete control: personal-detail links, device
  records, deleted profiles' names, the records of judged pages and recipe repairs, the
  record of which model wrote each recipe part, and the record of spending on Claude.
  The service's owner can delete them from its database.
- **Your Anthropic API key**: **Remove key** on the settings page deletes the key from
  your device; its spend count stays until you remove the extension.
- **On a lost device**: revoking it on the service stops it from reaching the service,
  but cannot erase the vault copy, unlock key and recipes already on it.
- **At Bitwarden, Cloudflare and Anthropic**: under their own policies.

## Chrome Web Store Limited Use

The use and transfer of information that Pateat receives complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies),
including the
[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
requirements. In particular:

- Pateat uses the authentication information and website content it handles only to
  provide and improve its single purpose: logging you in to the sites you choose and
  showing you what it did.
- It transfers that information only as this policy describes, for that purpose: vault
  sign-in and sync to your Bitwarden server; your username, password, one-time codes,
  personal details, other vault fields and passkey signatures to the site you log in
  to; settings, page descriptions, login records and problem reports to the Pateat
  service you paired with, which runs on Cloudflare; and page descriptions, with the
  names of custom fields and the shape of usernames and text fields, to Anthropic,
  through that service or, with your own Anthropic API key, directly from your
  device.
- It does not sell user data, does not use or transfer it for advertising, and does not
  use or transfer it to determine creditworthiness or for lending.
- The developer receives and reads no data from other people's use of Pateat. A Pateat
  service's owner can read what their own service stores; today every service is used
  only by the person who runs it, so that is their own data.

## Changes

Changes to this policy are made in Pateat's public repository, where its history shows
every earlier version. Send questions to
[pateat@takuk.me](mailto:pateat@takuk.me).
