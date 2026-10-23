# Permissions

Pateat asks Chrome for as little as its job allows. This page lists each permission in
its manifest and what Pateat does with it.

| Permission | What Pateat uses it for |
| --- | --- |
| Access to all sites (`https://*/*` and `http://*/*`) | Finding and completing login pages, answering passkey requests, and reaching your Bitwarden server and Pateat service |
| `storage` | Keeping its settings, recipe copy, vault connection records, service pairing and Anthropic API key in Chrome |
| `offscreen` | Running the Bitwarden SDK in a hidden extension page, where it decrypts the vault and signs passkey requests |
| `alarms` | Checking every 5 minutes, even while its service worker sleeps, whether the vault is due to sync again, and ending a vault timeout |
| `idle` | Locking the vaults when the computer goes idle or is locked, if you chose that [vault timeout](./setup.md#vault-timeout); Chrome shows no warning for it |

Pateat does not request `tabs`, `scripting`, `activeTab`, `cookies`, `webRequest`,
`history`, `nativeMessaging` or any other permission.

## Access to all sites

Pateat declares access to every HTTPS and plain HTTP site when it is installed, rather
than asking for each site later
([ADR 0009](https://github.com/risu729/pateat/blob/main/docs/adr/0009-install-time-https-site-access.md),
[ADR 0050](https://github.com/risu729/pateat/blob/main/docs/adr/0050-http-pages-for-http-items.md)).
Adding a site therefore needs no further Chrome prompt. In exchange, Chrome warns that
Pateat can read and change your data on all websites, and Pateat's scripts load on every
HTTP and HTTPS page:

- A login script runs in every page and frame. It only announces the page to Pateat's
  service worker until the page is admitted for a login. A second, smaller script runs
  beside it in the page's own context; it reads nothing from the page and only follows a
  `javascript:` link when the login script asks it to, so that the link runs under the
  page's own security policy.
- Two passkey scripts run at the start of every top-level HTTPS page and every page on
  `http://localhost`, where browsers also allow passkeys. One wraps the
  page's passkey requests (`navigator.credentials.get` and `create`); the other relays a
  request to Pateat's service worker. A request that Pateat does not answer goes on to
  Chrome unchanged, so Chrome, your phone or another passkey provider can still answer
  it. Three requests are exceptions: one where Pateat's account chooser timed out
  without a choice fails as Chrome's own timed-out prompt does; a passkey suggestion
  that a page asks for after Pateat signed it in waits until the page cancels it; and a
  request to create a passkey that lists one of your vault's passkeys, right after
  Pateat signed the tab in, is declined.

Loading on a page does not mean acting on it. Pateat logs in only on a site that you
have not excluded, that matches an item in your vault or that you chose an item for,
that has a recipe for the page, and that still has site access in Chrome, and only
while the vault is unlocked. It fills only
the fields its recipe names for that exact origin, in that tab, frame and page. A page
without a recipe can be described to your Pateat service so that one is written; what
that description holds is in the [privacy policy](./privacy.md).

To show on its toolbar icon how many of your vault's items match the current tab, Pateat
compares the tab's address with your vault on your device. That needs no recipe, sends
nothing, and also happens on sites you excluded.

The same access lets Pateat reach your Bitwarden server, your Pateat service and, when
you saved an [AI key](./setup.md#ai-key), Anthropic's API
(`https://api.anthropic.com/v1/messages`). Even so, Pateat calls only the fixed
Bitwarden endpoints it needs, on the server you chose.

## Plain HTTP pages

On a plain HTTP page, Pateat logs in only with an item whose website is saved in your
vault with an explicit `http://` address, such as `http://192.168.1.1`. An item saved as
`https://example.com` or as a bare `example.com` is never used there, even on the same
site. That is stricter than Bitwarden, which also fills such an item after a warning:
an automatic login has no one to answer the warning. A login on an HTTP page fills and
submits as on HTTPS, but answers no passkey requests, except on `http://localhost`.

On plain HTTP, what Pateat fills, including the password, travels unencrypted: anyone on
the network between you and the site can read it, or change the page so that Pateat
fills a form they inserted. Save an item with `http://` only for a site that you trust
on that network, such as your router.

## Limiting site access

Chrome lets you withhold site access from any extension: on Pateat's card in
`chrome://extensions`, choose **Details**, then **Site access**. Pateat respects that
choice for each site. Where it has no access, it neither logs in nor answers passkey
requests, and its settings page asks for access to your Bitwarden server or Pateat
service when it needs to reach them.

To stop Pateat on one site while keeping its access elsewhere, turn
**Pateat on this site** off in the toolbar popup instead. That adds an exclusion that
every device using the same settings profile follows.

## Storage

Pateat keeps its data in the extension's own storage in Chrome (`chrome.storage` and
IndexedDB). Websites cannot read it. Removing the extension from Chrome deletes all of
it. An unlocked vault's key, unless the vault timeout is **Never**, is kept only in
memory (`chrome.storage.session`), which Chrome clears when it restarts.
