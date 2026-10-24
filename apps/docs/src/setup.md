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
   one, or **New profile with this device's site settings** with a **New profile name**.
   A profile holds the sites paused until turned back on, the allowed sites, the sites
   that ask for the master password, the default accounts and whether Pateat logs in
   automatically in private windows, and devices that share a profile share them.
   Choosing an existing profile replaces this device's own lists with the profile's.
   Pateat asks first (**Pair and replace**) when this device has paused sites, allowed
   sites or default accounts, or has **Run only on allowed sites** on, but not when it
   has only sites that ask for the master password.

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

### Allowed sites

To limit Pateat to a few sites, turn **Run only on allowed sites** on in the settings
page's **Allowed sites** section and add each site with **Allow site**, where
**Allow subdomains too** covers its subdomains. Pateat then logs in, fills and answers
passkey requests only on those sites, and does nothing at all on any other site, not
even from the toolbar popup. A paused site stays paused while it is allowed. With the
switch on and no site allowed, Pateat does nothing anywhere. Turning the switch off
keeps the list. On a site that is not allowed, the toolbar popup offers
**Allow** followed by the site's name, which adds the site with its subdomains. The list
starts empty and off, and belongs to the settings profile, like the paused sites.

### Private windows

Pateat does not log in by itself in private (incognito) windows unless you turn on
**Log in automatically in private windows** on the settings page. While it is off, a
login page in a private window lists its matching accounts in the toolbar popup, and an
account you pick there still logs in. The choice is part of the settings profile.

### AI key

Under **AI key**, you can save an **Anthropic API key** from the Claude Console. While
this device is paired, it asks Claude with this key instead of the service's
credentials: the service writes each request, and the extension sends it to Anthropic
itself. The key stays on this device and is sent to Anthropic only, never to the
service. While no service is paired, the extension writes recipes with this key itself,
with Claude's default models, and keeps them on this device. **Daily limit (USD)** and
**Monthly limit (USD)**, $5 and $100 unless you change them, stop requests at either
limit. **Remove key** deletes the key.

### Export and import

Under **Export and import**, **Export to a file** saves a JSON file with what a paired
Pateat service would keep: the site settings, the item and field limits of each vault
with the vault's account and item names, the account chosen for each site, and the
recipes this device uses. It never holds vault keys or values, the service's sign-in or
the AI key. **Import from a file** on another device first shows what the file would
change, among them the sites where it decides which of your vault items Pateat uses;
press **Import** to import it. Import only a file you exported yourself or got from
someone you trust. Importing adds the file's settings to the device's own: everything
the device has stays, and where both hold the same entry, the file's wins. A recipe
replaces one the device keeps only when the file's is newer. A paired device uploads the
imported recipes to its service at its next sync, except those the service already
holds. Save or reload the settings page before you import.

## Using Pateat

Once both steps are done, open the login page of a site that has an item in your vault.
Pateat logs in when the site has a recipe for that page. When it has none, Pateat sends
a sanitized description of the page to the service, and a recipe is written with
Claude. That needs an [AI key](#ai-key) on this device or Claude credentials set up on
the service, as the
[service guide](https://github.com/risu729/pateat/blob/main/services/api/README.md#claude-credentials)
describes; without either, the service still keeps the description it received.

The toolbar popup shows what Pateat did on the current page, unless you uncheck
**Show "This page" in the popup** on the settings page, which also hides
**Switch account**; the pause stays. It also lets you choose the
account to log in with when several match, pause automatic login on the site for
**10 minutes**, **1 hour** or **Until turned back on** (**Resume** ends the pause), turn
**Ask for the master password** on for a site, and, when a page asks for a personal
detail such as a card's number, link the vault item that holds it and press **Fill**.
The service's **Sites** page lists every site with a recipe, a default account or a
pause, one settings profile at a time.

On a site's page that waits for no account choice, **Switch account** in the popup lists
the site's matching accounts. **Switch to this account** logs the tab out of the site,
then logs in with that account; **Make it the default** keeps it as the site's default
account. The first switch on a site asks your Pateat service which control logs out, and
the clicks it finds are kept for the next switch. A site you log in to through another
account, such as a company or Google sign-in, may log you out of that account too.

When you log out of a site yourself, Pateat logs in again on the next login page, with
the account it would use for an automatic login. To stay logged out, pause the site
first. If Pateat logged in to a site twice in the last 10 minutes, it asks for an
account instead of logging in a third time.
