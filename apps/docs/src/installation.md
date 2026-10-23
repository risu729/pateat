# Installation

::: warning Not released yet
No Pateat release has been published, and how releases are packaged is not decided yet.
The steps below assume a ZIP file on
[GitHub Releases](https://github.com/risu729/pateat/releases), loaded into Chrome as an
unpacked extension. Until then, [build it from source](#build-from-source).
:::

## Requirements

- Google Chrome 145 or later on a desktop computer. Pateat targets Chrome installed on
  your own computer; other Chromium browsers and hosted browsers are not tested.
- A Bitwarden account on Bitwarden Cloud (US or EU), on a self-hosted Bitwarden server,
  or on the latest release of [Vaultwarden](https://github.com/dani-garcia/vaultwarden),
  reached over HTTPS (or plain HTTP on `localhost` or `127.0.0.1`). On Bitwarden's own
  servers, only one Bitwarden Cloud US account has been tested so far; Vaultwarden is
  tested automatically against a recent release.
- A Pateat service to pair with, which holds your settings and recipes. See
  [the Pateat service](./setup.md#the-pateat-service) before you install.

## Install a release

1. Download the Chrome ZIP file from the release on
   [GitHub Releases](https://github.com/risu729/pateat/releases).
2. Extract it into a folder that you keep. Chrome loads the extension from that folder
   each time it starts, so do not delete or move it.
3. Open `chrome://extensions` and turn on **Developer mode** in the top-right corner.
4. Press **Load unpacked** and choose the extracted folder, the one that holds
   `manifest.json`.
5. Pin Pateat to the toolbar from the extensions menu (the puzzle-piece icon), so that
   you can see what it did on each page.

Chrome does not show its usual permission prompt for an unpacked extension: Pateat gets
access to every HTTPS and plain HTTP site as soon as it is loaded.
[Permissions](./permissions.md) explains what that access is for and how to limit it.

Pateat's extension ID is fixed by the key in its manifest, so every release keeps the
same ID and the same data in Chrome.

## Update to a new release

1. Delete the contents of the folder you loaded, and extract the new release's ZIP file
   into the same folder.
2. On `chrome://extensions`, press the reload button on Pateat's card. Unless the
   [vault timeout](./setup.md#vault-timeout) is **Never**, this locks the vaults; unlock
   them on the settings page.

Do not press **Remove**: removing the extension deletes everything it stored in Chrome,
including the vault connection and the service pairing, and you would have to
[set it up](./setup.md) again. Removing it does not revoke its device on the Pateat
service; the device's credential stays valid until you revoke it on the service or it
expires after 90 days unused.

## Build from source

Building needs [mise](https://mise.jdx.dev/) and Git. In a clone of the
[repository](https://github.com/risu729/pateat):

```sh
mise install
mise run install
mise run //apps/extension:build
```

The extension is written to `apps/extension/.output/chrome-mv3/`. Load that folder with
**Load unpacked** as above. The
[development guide](https://github.com/risu729/pateat/blob/main/docs/development.md)
covers the rest of the toolchain.

## Source code and license

The Pateat extension is free software under the GNU General Public License version 3
only. It includes the official Bitwarden SDK, used under its GPLv3 option. A release
comes with its
[Corresponding Source](https://github.com/risu729/pateat/blob/main/docs/sdk-source.md):
the Pateat source at the released commit and the exact Bitwarden SDK source it was built
from. See [licensing](https://github.com/risu729/pateat/blob/main/LICENSING.md).

## Chrome Web Store

Pateat may also be published on the Chrome Web Store if the store's policies allow it.
A store item gets an extension ID assigned by the store, so moving from an unpacked
install to the store item means setting it up and pairing again.
