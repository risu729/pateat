# Setup

Setting up Pateat takes two steps on its settings page: connect your Bitwarden vault,
then pair the extension with a Pateat service. Open the settings page from the settings
(gear) button in the toolbar popup, or from **Details** then **Extension options** on
Pateat's card in `chrome://extensions`.

## Connect Bitwarden

1. Under **Add a connection**, choose the **Server**: **Bitwarden Cloud US**,
   **Bitwarden Cloud EU** or **Self-hosted HTTPS**. For a self-hosted server, enter its
   address, such as `https://vault.example.com`.
2. Give the connection a **Name**, such as `Personal`, and enter your Bitwarden
   **Email** and **Master password**.
3. Leave **Use this connection** on, then press **Connect Bitwarden**.
4. If Bitwarden asks for verification, a **Manual verification** form appears. Enter the
   code from your authenticator app, an email code you already received, or the
   new-device verification code that Bitwarden emailed you, then press **Verify code**.
   Pateat cannot ask Bitwarden to send an email code, and other two-step login methods
   are not supported yet.

Pateat signs in to the Bitwarden server directly from your browser, syncs the vault and
decrypts it on your device with the official Bitwarden SDK. The master password and
verification codes are not saved. What stays on this device is:

- an encrypted copy of the vault;
- an unlock key, so that Pateat can unlock the vault again after Chrome restarts without
  asking for the master password (automatic unlock);
- a sync sign-in, so that Pateat can sync the vault again later.

The unlock key is kept in the extension's own storage in Chrome, not in your operating
system's key store. Anyone who can read your Chrome profile's files can use it to
decrypt the vault copy. If you do not want that, choose **Disable automatic unlock** in
the connection's menu. Pateat needs the unlock key to use and sync the vault, so that
connection stops working at once, until you sign in again with
**Enable automatic unlock on this device** checked.

Each connection is a row with its main action, **Sync**, or **Sign in again** when the
vault needs a sign-in first. Its menu also holds **Forget sync sign-in** and
**Delete connection**, which, after you press **Confirm delete**, removes the
connection, its vault copy, unlock key and sync sign-in from this device. Neither signs
out your other Bitwarden sessions. You can add more than one connection, such as a
personal and a work vault.

### Choose what Pateat may use

Each connection row also controls which items Pateat may use:

- **Use this vault** turns the whole connection on or off for Pateat.
- **Items for Pateat** is either **All except exclusions** or
  **Selected groups and items only**.
- **Excluded items and fields** lists the items, and the fields of items, that Pateat
  must never fill. Exclusions win over selected groups and items.

When an item with excluded custom fields changes so that Pateat can no longer tell which
field an exclusion meant, Pateat holds the item back until you review its fields on this
page.

These limits apply to Pateat only and do not change anything in Bitwarden.

## Pair with a Pateat service

1. Under **Sync service**, enter the **Service address**, such as
   `https://pateat.example.com`, and a **Device name**, which the service shows in its
   device list.
2. Press **Pair this device**.
3. If you are not signed in to the service yet, Pateat opens its sign-in page in a new
   tab. Sign in there, then return to the settings page; Pateat tries again by itself.
   **Try again** and **Open sign-in page** repeat either step.

When pairing succeeds, the page says **This device is paired.** Pateat then syncs your
settings and recipes from the service and keeps a copy on this device.

The service gives this device its own credential, which the extension keeps in its own
storage and sends only to the service. It expires after 90 days without use. You can
press **Disconnect this device** on the settings page, or revoke it on the service's
**Devices** page, for example when a computer is lost.

### The Pateat service

The service is a small Cloudflare Worker behind Cloudflare Access. It stores your
settings, site defaults and recipes, and asks Claude to write a recipe for a login page
that has none. It never receives vault values or keys.

Today each service is run by its owner for themselves: the service at `pateat.takuk.me`
belongs to Pateat's developer and is not open to other people. A service accepts
pairing only from the extension IDs its operator lists, so running your own means
listing Pateat's ID, or the ID of your own build if you sign it with your own key. The
[development guide](https://github.com/risu729/pateat/blob/main/docs/development.md#extension-id)
describes both. A mode without the service is planned.

## Using Pateat

Once both steps are done, open the login page of a site that has an item in your vault.
Pateat logs in when the site has a recipe for that page. When it has none, Pateat sends
a sanitized description of the page to the service, which asks Claude to write one; this
needs Claude credentials set up on the service.

The toolbar popup shows what Pateat did on the current page. It also lets you choose the
account to log in with when several match, and turn **Pateat on this site** off for a
site. The service's **Sites** page lists every site with a recipe, a default account or
an exclusion.
