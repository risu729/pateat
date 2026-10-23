# Setup

Setting up Pateat takes two steps on its settings page: connect your Bitwarden vault,
then pair the extension with a Pateat service. Open the settings page with the toolbar
popup's **Open settings** button (the sliders icon), or through **Details** then
**Extension options** on Pateat's card in `chrome://extensions`.

Pateat's pages follow Chrome's language, English or Japanese, and the settings page has
a **Language** setting to choose one. This page quotes the English labels.

## Connect Bitwarden

1. Under **Add a connection**, choose the **Server**: **Bitwarden Cloud US**,
   **Bitwarden Cloud EU** or **Self-hosted**, which covers your own Bitwarden server and
   the latest Vaultwarden. For a self-hosted server, enter its **Server address**, such
   as `https://vault.example.com`. It must use HTTPS, except on `localhost` or
   `127.0.0.1`.
2. Give the connection a **Name**, such as `Personal`, and enter your Bitwarden
   **Email** and **Master password**.
3. Leave **Use this connection** on, then press **Connect Bitwarden**.
4. If Bitwarden asks for verification, a **Manual verification** form appears. Choose
   the **Verification method**: **Authenticator code** for the code from your
   authenticator app, or **Email code**, which asks the server to email you a code
   (**Resend code** asks for another). For a new device, Bitwarden emails a
   new-device verification code by itself. Enter the code within 5 minutes, without
   closing the settings page, then press **Verify code**. Other two-step login methods
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
the connection's menu. Pateat needs the unlock key to use and sync the vault, so this
also forgets the sync sign-in, and the connection stops working at once until you sign
in again with **Enable automatic unlock on this device** checked.

Each connection is a row with its main action, **Sync**, or **Sign in again** when the
vault needs a sign-in first. Its menu also holds **Disable automatic unlock**,
**Forget sync sign-in** and **Delete connection**, which, after you confirm with
**Delete connection** again, removes the connection, its vault copy, unlock key and sync
sign-in from this device. None of these signs out your other Bitwarden sessions. You can
add more than one connection, such as a personal and a work vault.

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
**Devices** page, for example when a computer is lost. Revoking a lost computer stops it
from reaching the service, but cannot erase the vault copy, unlock key and recipes
already on it.

### The Pateat service

The service is a small Cloudflare Worker. Its pairing and management pages are behind
Cloudflare Access; the extension reaches it with its device credential. It stores your
settings, site defaults and recipes, and asks Claude to write a recipe for a login page
that has none. It also keeps, for one year, the page descriptions it receives and a
record of each login that followed a recipe; the
[privacy policy](./privacy.md#your-pateat-service) lists them. It never receives vault
values or keys. Its pages are **Dashboard**, **Sites**, **Devices**, **Models** (which
Claude model to use) and **Request log**.

Today each service is run by its owner for themselves: the service at `pateat.takuk.me`
belongs to Pateat's developer and is not open to other people. A service accepts
pairing only from the extension IDs its operator lists, so running your own means
listing Pateat's ID, or the ID of your own build if you sign it with your own key. The
[development guide](https://github.com/risu729/pateat/blob/main/docs/development.md#extension-id)
describes both. A mode without the service is planned.

## Using Pateat

Once both steps are done, open the login page of a site that has an item in your vault.
Pateat logs in when the site has a recipe for that page. When it has none, Pateat sends
a sanitized description of the page to the service, which asks Claude to write one.
Writing one needs Claude credentials set up on the service, as the
[service guide](https://github.com/risu729/pateat/blob/main/services/api/README.md#claude-credentials)
describes; without them, the service still keeps the description it received.

The toolbar popup shows what Pateat did on the current page. It also lets you choose the
account to log in with when several match, and turn **Pateat on this site** off for a
site. The service's **Sites** page lists every site with a recipe, a default account or
an exclusion.
