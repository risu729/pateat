# ADR 0009: Install-time HTTPS site access for login pages

Status: accepted by the owner on 2026-10-10 and implemented in the production document
admission PR. No real-site or installed-profile acceptance has been run yet.
Amended by [ADR 0013](0013-service-held-recipes-and-settings.md): recipes come from
the synced service cache.

Date: 2026-10-10

## Decision

Declare `https://*/*` as a required host permission and register one static,
isolated-world content script on every top-level HTTPS document. Do not add the
`scripting` or `activeTab` permission. Plain HTTP pages are never admitted outside the
synthetic loopback probe build.

The content script only announces its document. The background admits a document only
when its exact origin (scheme, host and port) has a saved site default, the site is not
excluded, and Chrome still reports host access for that origin. Every other document
gets only this local admission check: no attempt, observation, policy catalog or vault
access. An admitted document still needs a cached recipe for that origin
([ADR 0013](0013-service-held-recipes-and-settings.md)), looked up before the policy
catalog is opened, and a valid account binding; every policy check of the declarative
executor applies unchanged. Until the recipe cache exists,
admitted documents stop with `recipe-not-found` without opening the catalog or vault.

Probe-only behavior stays confined to the probe build: the loopback origin grant, the
probe recipe and binding, probe control messages and attempt status echoed to the page.

## Alternatives and consequences

Per-site optional host permissions with programmatic injection through `scripting`
would request access only for sites the user configures, at the cost of a permission
prompt per site and an extra API permission. The owner chose install-time access to
all HTTPS sites instead, so configuring a site needs no further browser prompt.

Chrome shows a broad "read and change your data on all websites" warning at install,
and the content script runs on every HTTPS page. Admission therefore depends on local
settings, not on the browser grant. Users can still withhold site access in Chrome's
extension settings; the background respects that per origin.

The grant also covers provider HTTPS hosts, so connection setup prompts for host access
only when the user has withheld site access. Chrome lets the extension re-request a
withheld required host, so no `optional_host_permissions` entry is declared; Chrome
would omit it as redundant with a warning. The provider transport still enforces the
configured origin, method and service path; the broader browser grant does not widen
which endpoints a connection may call.
