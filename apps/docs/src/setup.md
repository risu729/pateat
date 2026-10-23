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
3. Leave **Use this vault** on, then press **Connect Bitwarden**.
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
- an unlock key, which decrypts that copy while the vault is unlocked;
- a sync sign-in, so that Pateat can sync the vault again later.

Each connection is a row with its main action: **Sync**, **Unlock** when the vault is
locked, or **Sign in again** when it needs a sign-in first. **Unlock** asks for the
master password and checks it on this device, without the server. The row's menu also
holds **Lock**, which forgets the unlock key and keeps the sync sign-in; **Log out**,
which forgets both; **Forget sync sign-in**; and **Delete connection**, which, after you
confirm with **Delete connection** again, removes the connection, its vault copy, unlock
key and sync sign-in from this device. None of these signs out your other Bitwarden
sessions. You can
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
4. If the service already holds settings, choose a **Settings profile**: an existing
   one, or **New profile with this device's site settings** with a
   **New profile name**. A profile holds the excluded sites, the sites that ask for the
   master password and the default accounts, and devices that share a profile share
   them. Choosing an existing profile replaces this device's own lists with the
   profile's. Pateat asks first (**Pair and replace**) when this device has excluded
   sites or default accounts, but not when it has only sites that ask for the master
   password.

When pairing succeeds, the page says **This device is paired.** Pateat then syncs its
profile's settings and the recipes from the service and keeps a copy on this device.

The service gives this device its own credential, which the extension keeps in its own
storage and sends only to the service. It expires after 90 days without use. You can
press **Disconnect this device** on the settings page, or revoke it on the service's
**Devices** page, for example when a computer is lost. Revoking a lost computer stops it
from reaching the service, but cannot erase the vault copy, unlock key and recipes
already on it.

### The Pateat service

The service is a small Cloudflare Worker. Its pairing and management pages are behind
Cloudflare Access; the extension reaches it with its device credential. It stores your
settings profiles, which vault field fills which part of each site's login, and
recipes, and writes a recipe with Claude for a login page that has none. It also keeps,
for one year, the page descriptions it receives, a record of each login that followed a
recipe and the problems the extension reports;
the [privacy policy](./privacy.md#your-pateat-service) lists them. It never receives
vault values or keys. Its pages are **Dashboard**, **Sites**, **Profiles**,
**Devices**, **Claude** (its Claude credentials and which models to use), **Problems**
(the warnings, errors and reasons for doing nothing that devices reported) and
**Request log**.

Today each service is run by its owner for themselves: the service at `pateat.takuk.me`
belongs to Pateat's developer and is not open to other people. A service accepts
pairing only from the extension IDs its operator lists, so running your own means
listing Pateat's ID, or the ID of your own build if you sign it with your own key. The
[development guide](https://github.com/risu729/pateat/blob/main/docs/development.md#extension-id)
describes both. Writing recipes on a device that is not paired is planned.

## More settings

### Vault timeout

The **Vault timeout** section decides how long the vaults stay unlocked, counted from
the last login filled, passkey signed, unlock or sign-in: 1, 5, 15 or 30 minutes, 1 or
4 hours, **On system idle**, **On system lock**, **On browser restart**, **Never** (the
default) or **Custom** minutes. **Timeout action** is **Lock** or **Log out**. The
setting stays on this device.

With **Never**, the unlock key is kept in the extension's storage in Chrome, so the
vaults unlock by themselves after Chrome restarts. The key is not protected by your
operating system's key store: anyone who can use your Chrome profile, or read its
files, can use the vaults. With any other timeout the key stays in memory only, so
restarting Chrome, or reloading or updating the extension, also locks the vaults.

### Sites that ask for the master password

Bitwarden's master password re-prompt is honoured on the sites you list. Turn
**Ask for the master password** on in the toolbar popup on a site, or add the site with
**Ask for the master password** in the settings page's **Sites** section, where
**Include subdomains** covers its subdomains and **Stop asking** removes it. On those
sites, a login item marked for re-prompt, and its passkeys, are used only after you
enter the master password in Pateat's window. Elsewhere such an item is used like any
other. Re-prompt is checked on the login item only: a personal detail from a linked
card or identity item is filled without asking, even when that item is marked. The list
starts empty.

### AI key

Under **AI key**, you can save an **Anthropic API key** from the Claude Console. While
this device is paired, it asks Claude with this key instead of the service's
credentials: the service writes each request, and the extension sends it to Anthropic
itself. The key stays on this device and is sent to Anthropic only, never to the
service. **Daily limit (USD)** and **Monthly limit (USD)**, $5 and $100 unless you
change them, stop requests at either limit. **Remove key** deletes the key.

## Using Pateat

Once both steps are done, open the login page of a site that has an item in your vault.
Pateat logs in when the site has a recipe for that page. When it has none, Pateat sends
a sanitized description of the page to the service, and a recipe is written with
Claude. That needs an [AI key](#ai-key) on this device or Claude credentials set up on
the service, as the
[service guide](https://github.com/risu729/pateat/blob/main/services/api/README.md#claude-credentials)
describes; without either, the service still keeps the description it received.

The toolbar popup shows what Pateat did on the current page. It also lets you choose the
account to log in with when several match, turn **Pateat on this site** off or
**Ask for the master password** on for a site, and, when a page asks for a personal
detail such as a card's number, link the vault item that holds it and press **Fill**.
The service's **Sites** page lists every site with a recipe, a default account or an
exclusion, one settings profile at a time.
