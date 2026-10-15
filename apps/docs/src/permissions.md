# Permissions

Pateat asks Chrome for as little as its job allows. This page lists each permission in
its manifest and what Pateat does with it.

| Permission | What Pateat uses it for |
| --- | --- |
| Access to all HTTPS sites (`https://*/*`) | Finding and completing login pages, answering passkey requests, and reaching your Bitwarden server and Pateat service |
| `storage` | Keeping its settings, recipe copy, vault connection records and service pairing in Chrome |
| `offscreen` | Running the Bitwarden SDK in a hidden extension page, where it decrypts the vault and signs passkey requests |
| `alarms` | Checking every 5 minutes, even while its service worker sleeps, whether the vault is due to sync again |

Pateat does not request `tabs`, `scripting`, `activeTab`, `cookies`, `webRequest`,
`history`, `nativeMessaging` or any other permission. It never acts on plain HTTP pages.

## Access to all HTTPS sites

Pateat declares access to every HTTPS site when it is installed, rather than asking for
each site later
([ADR 0009](https://github.com/risu729/pateat/blob/main/docs/adr/0009-install-time-https-site-access.md)).
Adding a site therefore needs no further Chrome prompt. In exchange, Chrome warns that
Pateat can read and change your data on all websites, and Pateat's scripts load on every
HTTPS page:

- A login script runs in every HTTPS page and frame. It only announces the page to
  Pateat's service worker until the page is admitted for a login.
- Two passkey scripts run at the start of every top-level HTTPS page. One wraps the
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
that has a recipe for the page, and that still has site access in Chrome. It fills only
the fields its recipe names for that exact origin, in that tab, frame and page. A page
without a recipe can be described to your Pateat service so that one is written; what
that description holds is in the [privacy policy](./privacy.md).

The same access lets Pateat reach your Bitwarden server and your Pateat service. Even
so, Pateat calls only the fixed Bitwarden endpoints it needs, on the server you chose.

## Limiting site access

Chrome lets you withhold site access from any extension: on Pateat's card in
`chrome://extensions`, choose **Details**, then **Site access**. Pateat respects that
choice for each site. Where it has no access, it neither logs in nor answers passkey
requests, and its settings page asks for access to your Bitwarden server or Pateat
service when it needs to reach them.

To stop Pateat on one site while keeping its access elsewhere, turn
**Pateat on this site** off in the toolbar popup instead. That adds an exclusion that
every device paired with your service follows.

## Storage

Pateat keeps its data in the extension's own storage in Chrome (`chrome.storage` and
IndexedDB). Websites cannot read it. Removing the extension from Chrome deletes all of
it.
