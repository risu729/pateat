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
from the extension. Data leaves your device only to reach the services below, each of
which you choose and connect yourself.

## On your device

Pateat stores the following in the extension's own storage in Chrome. Websites cannot
read it, and removing the extension deletes it.

- **Your vault, encrypted.** A copy of each connected Bitwarden vault, as Bitwarden
  encrypts it.
- **The unlock key.** A key that decrypts that copy, kept so that Pateat can unlock the
  vault after Chrome restarts. It is not protected by your operating system's key store;
  you can turn automatic unlock off to remove it.
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
or your own server) directly from your browser, the way Bitwarden's own apps do: to sign
in with your email, a hash derived from your master password and any verification code
you enter, and to sync your encrypted vault. Bitwarden's
[privacy policy](https://bitwarden.com/privacy/) covers what that server keeps.

## Your Pateat service

Pateat syncs its settings and recipes with a Pateat service that you pair it with. Each
service is run by its owner, who can read what it stores; today each service is run by
its owner for their own use. The extension sends the service:

- **The device name** you enter when pairing.
- **Settings**: the sites you excluded, the default account for each site and which
  vault field fills which part of a site's login, identified by vault item and account
  IDs with the item's and the connection's names. Login usernames, passwords and other
  vault values are never sent.
- **Login page descriptions**, when a site has no recipe yet or a login needs the next
  page described: the site's address without its query string, and the page's title,
  headings, the labels, names and placeholders of its form fields, and the text of its
  buttons, its links and the accounts it lists. Field values, hidden fields, the page's
  HTML and screenshots are never sent. Email addresses, masked text and long numbers in
  the page are replaced with placeholders before sending, and so are your usernames for
  that site. After a login, the page shown is described the same way, together with its
  header text, and every number is replaced, so that the service can judge whether the
  login worked.

The service stores the recipes it writes and keeps each page description it sent to
Claude, with Claude's answer, for 90 days, to evaluate and improve recipe writing. These
records show which sites you log in to.

## Anthropic

To write a recipe or judge a login, your Pateat service sends the page description to
Claude, Anthropic's AI model, using the Claude credentials its owner set up. Anthropic
receives the page description only, never vault values, and handles it under the terms
of that owner's Anthropic account.

## The websites you log in to

To log in, Pateat fills your username, password, one-time codes and other vault fields
into the site's login form, and answers the site's passkey requests with a passkey
signature. The site receives these as it would from you, under its own privacy policy.

## Deleting your data

- **On your device**: delete a vault connection on the settings page, or remove the
  extension from Chrome.
- **On the service**: disconnect the device, or revoke it on the service's **Devices**
  page. Its owner can delete the stored settings, recipes and logs.
- **At Bitwarden and Anthropic**: under their own policies.

## Chrome Web Store Limited Use

The use of information that Pateat receives complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies),
including the
[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
requirements. In particular:

- Pateat uses the authentication information and website content it handles only to log
  you in to the sites you choose and to show you what it did.
- It transfers that information only as this policy describes: vault sign-in and sync to
  your Bitwarden server, settings and login page descriptions to the Pateat service you
  paired with, and through that service to Anthropic, to provide Pateat's login feature.
- It does not sell user data, does not use or transfer it for advertising, and does not
  use or transfer it to determine creditworthiness or for lending.
- The developer reads no user data. A Pateat service's owner can read what their own
  service stores.

## Changes

Changes to this policy are made in Pateat's public repository, where its history shows
every earlier version. Questions can be asked on
[GitHub](https://github.com/risu729/pateat).
