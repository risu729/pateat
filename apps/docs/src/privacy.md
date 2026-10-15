# Privacy policy

::: warning Draft
This policy is a draft written for Pateat's first public release and the Chrome Web
Store listing. It describes the extension as it is built today, has not been reviewed by
a lawyer, and is not in effect yet.
:::

Pateat is a Chrome extension that logs in to websites with the accounts in your own
Bitwarden vault. It is developed by [risu729](https://github.com/risu729) as open source
software; its source code is on [GitHub](https://github.com/risu729/pateat).

Pateat has no analytics, advertising or tracking, and the developer receives no data
from the extension. Data leaves your device only to reach the services below: your
Bitwarden server, the Pateat service you pair with, which runs on Cloudflare and uses
Anthropic's Claude, and the websites you log in to.

## On your device

Pateat stores the following in the extension's own storage in Chrome. Websites cannot
read it, and removing the extension deletes it.

- **Your vault, encrypted.** A copy of each connected Bitwarden vault, as Bitwarden
  encrypts it.
- **The unlock key.** A key that decrypts that copy, kept so that Pateat can unlock the
  vault after Chrome restarts. It is not protected by your operating system's key store.
  Turning automatic unlock off removes it, and Pateat then cannot use that vault until
  you sign in again with automatic unlock on.
- **The Bitwarden sync sign-in**, which lets Pateat sync the vault again without your
  master password. Your master password and verification codes are never stored.
- **Settings and recipes** synced from your Pateat service, which item and field limits
  you set for each vault, and the pairing credential for the service.
- **Login records**: for each tab and site, how far a login went, kept so that a login
  is not repeated or resumed by mistake.
- **A diagnostics log** of what Pateat did, for bug reports. It records sites and page
  addresses with their parameter names but not their values, and never vault values. It
  stays on your device unless you download it and share it yourself.

Vault values are decrypted only on your device, by the official Bitwarden SDK running in
the extension. A value leaves the extension only into a login page of a site where that
item may be used: a site that matches the item's website in your vault, or one you chose
the item for.

## Your Bitwarden server

Pateat talks to the Bitwarden server you chose (Bitwarden Cloud US, Bitwarden Cloud EU
or your own server) directly from your browser, the way Bitwarden's own apps do: to look
up your account's key settings, to sign in with your email, a hash derived from your
master password, any verification code you enter and a device identifier and name (so
Pateat appears in Bitwarden's list of your devices), and to sync your encrypted vault.
Bitwarden's [privacy policy](https://bitwarden.com/privacy/) covers what that server
keeps.

## Your Pateat service

Pateat syncs its settings and recipes with a Pateat service that you pair it with. Each
service is run by its owner, who can read what it stores; today each service is run by
its owner for their own use. The extension sends the service:

- **The device name** you enter when pairing. The service also records when the device
  paired and when it was last used, and identifies you by the account you signed in to
  the service with.
- **Settings**: the sites you excluded, the default account for each site and which
  vault field fills which part of a site's login, identified by vault item and account
  IDs with the item's and the connection's names and the names of custom fields.
- **Login page descriptions**, when a site has no recipe yet or a login needs the next
  page described: the site's address without its query string, and the page's title,
  headings, the labels, names and placeholders of its form fields, and the text of its
  buttons, its links and the accounts it lists. Field values, hidden fields, the page's
  HTML and screenshots are never sent. Email addresses, masked text and long numbers in
  the page are replaced with placeholders before sending, and so are your usernames for
  that site where they appear in the page's text. A username stays visible when it is
  shorter than three characters, when only the part of an email address before the `@`
  is shown, when it is part of the site's address, when the vault holding it could not
  be read, or on a page that only offers a link to the sign-in page. Other names shown
  on the page, such as a display name, cannot be detected and are sent as shown. After a
  login, the page shown is described the same way, together with its header text, any
  open dialog and the texts near a code field or the buttons, with every number
  replaced, so that the service can judge whether the login worked.
- **What the login needs from your vault**, alongside a page description: the names of
  the custom fields that could fill the page and, for the username and for text custom
  fields, their shape: the length, which kinds of characters occur (such as digits or
  letters) and whether it is an email address. The values themselves are never sent.

The service stores the recipes it writes and keeps each request it sent to Claude, with
Claude's answer, to evaluate and improve recipe writing. Requests are kept for 90 days;
they are removed when a later sync reaches the service after that. These records show
which sites you log in to. A service's owner may publish reviewed page descriptions from
their own service's log as evaluation data, with names and shapes from the vault
replaced by made-up ones; the developer does this only with the developer's own service.

## Cloudflare

A Pateat service runs on Cloudflare: its code on Cloudflare Workers, its data in
Cloudflare D1, and its sign-in through Cloudflare Access. Everything the extension sends
to the service passes through and is stored at Cloudflare, under the terms of the
service owner's Cloudflare account, and Cloudflare keeps the service's request logs.

## Anthropic

To write a recipe or judge a login, your Pateat service sends the page description and
what the login needs from your vault, as above, to Claude, Anthropic's AI model, using
the Claude credentials its owner set up. Anthropic never receives vault values, and
handles what it receives under the terms of that owner's Anthropic account.

## The websites you log in to

To log in, Pateat fills your username, password, one-time codes and other vault fields
into the site's login form, and answers the site's passkey requests with a passkey
signature. The site receives these as it would from you, under its own privacy policy.

## Deleting your data

- **On your device**: delete a vault connection on the settings page, or remove the
  extension from Chrome.
- **On the service**: its pages let you remove excluded sites, default accounts and
  field choices, and revoke recipes, though a revoked recipe leaves a record that it was
  revoked. Disconnecting or revoking a device stops it from syncing but keeps its
  record. Requests sent to Claude stay until their 90 days run out. There is no page yet
  to delete device records or the request log; the service's owner can delete them from
  its database.
- **At Bitwarden and Anthropic**: under their own policies.

## Chrome Web Store Limited Use

The use of information that Pateat receives complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies),
including the
[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
requirements. In particular:

- Pateat uses the authentication information and website content it handles only to
  provide and improve its single purpose: logging you in to the sites you choose and
  showing you what it did.
- It transfers that information only as this policy describes, for that purpose: vault
  sign-in and sync to your Bitwarden server, settings and login page descriptions to the
  Pateat service you paired with, which runs on Cloudflare, and through that service to
  Anthropic.
- It does not sell user data, does not use or transfer it for advertising, and does not
  use or transfer it to determine creditworthiness or for lending.
- The developer reads no user data. A Pateat service's owner can read what their own
  service stores.

## Changes

Changes to this policy are made in Pateat's public repository, where its history shows
every earlier version. Questions can be asked on
[GitHub](https://github.com/risu729/pateat).
