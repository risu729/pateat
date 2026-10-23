---
layout: home

hero:
  name: Pateat
  text: Auto Login for Chrome
  tagline:
    Logs in to websites and answers passkey sign-ins from your own Bitwarden vault, kept on
    this device.
  image:
    src: /icon.svg
    alt: Pateat
  actions:
    - theme: brand
      text: Install
      link: /installation
    - theme: alt
      text: Set up
      link: /setup
    - theme: alt
      text: GitHub
      link: https://github.com/risu729/pateat

features:
  - title: Your vault stays on your device
    details:
      Pateat syncs your Bitwarden vault and decrypts it in the extension with the
      official Bitwarden SDK. TOTP secrets and passkey private keys never leave it, and a
      password leaves it only into a login page of a site you use that item for.
  - title: Logins described, not recorded
    details:
      Each site gets a recipe of fixed steps, such as fill and click, which an AI writes
      from a sanitized description of the login page. Recipes hold no secrets.
  - title: Passwords, TOTP and passkeys
    details:
      Pateat fills passwords, custom fields, one-time codes and personal details such as
      a card's number, and signs in with the passkeys stored in your vault, even in
      background tabs.
---

::: warning Not released yet
Pateat is in development. There is no release to download yet, and some parts have only
been tested with one Bitwarden Cloud account. The
[implementation plan](https://github.com/risu729/pateat/blob/main/docs/plan.md) lists
what has been verified.
:::

## What Pateat does

Pateat is a Chrome extension that completes the login forms of the sites you choose,
using the accounts in your own [Bitwarden](https://bitwarden.com/) vault. It supports
only Bitwarden for the time being.

- On a login page that matches an item in your vault, Pateat follows the site's recipe:
  it fills the username, password and other fields, enters a one-time code and presses
  the buttons, page after page. On a plain HTTP page, only an item saved with an
  `http://` address is used ([permissions](./permissions.md#plain-http-pages)).
- When a site asks for a passkey, Pateat can answer with a passkey stored in your vault.
- When a site has no recipe yet, Pateat sends a sanitized description of the page, never
  your vault values, to your Pateat service, and a recipe is written with Claude, using
  the service's Claude credentials or an Anthropic API key saved on your device.

Settings and recipes live on a Pateat service that you pair the extension with. The
extension keeps a copy, so logins keep working while the service is offline.

## Protections Pateat does not fully honour yet

- **Passkey user presence and verification.** When Pateat answers a site's passkey
  request, it sets the user presence (UP) and user verification (UV) flags, although it
  performs no presence test or verification of its own. Unlocking the vault on this
  device and the account you chose for the site are the only authorization
  ([ADR 0007](https://github.com/risu729/pateat/blob/main/docs/adr/0007-existing-passkey-assertions.md#presence-and-verification)).
  This is planned to become a setting before Pateat is public.
- **Bitwarden's master password re-prompt** is honoured only on the sites you list
  ([setup](./setup.md#sites-that-ask-for-the-master-password)), and only for login items
  and their passkeys. Elsewhere, and for personal details from linked card or identity
  items, Pateat uses items marked with re-prompt without asking for the master password.

## Next steps

1. [Install](./installation.md) the extension.
2. [Set it up](./setup.md): connect Bitwarden and pair with a Pateat service.
3. Read what its [permissions](./permissions.md) are for, and the
   [privacy policy](./privacy.md).
