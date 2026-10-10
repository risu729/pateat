# ADR 0009: Install-time HTTPS site access for login pages

Status: accepted by the owner on 2026-10-10 and implemented in the production document
admission PR. No real-site or installed-profile acceptance has been run yet.
Amended by [ADR 0013](0013-service-held-recipes-and-settings.md): recipes come from
the synced service cache, and admission no longer requires a saved site default. The
same HTTPS access also carries the passkey bridge of
[ADR 0007](0007-existing-passkey-assertions.md): a MAIN-world and an isolated-world
document-start script on every top-level HTTPS document, in addition to the login
script below.

Date: 2026-10-10

## Decision

Declare `https://*/*` as a required host permission and register one static,
isolated-world content script on every top-level HTTPS document. Do not add the
`scripting` or `activeTab` permission. Plain HTTP pages are never admitted outside the
synthetic loopback probe build.

The content script only announces its document. The background admits a document only
when the site is not excluded and Chrome still reports host access for its origin. A
saved site default is not required: since ADR 0013 an account can also be chosen by a
single provider URI match. An admitted document still needs a cached recipe for its
exact origin (scheme, host and port), looked up before the policy catalog is opened;
without one it gets no attempt, observation, policy catalog or vault access. Every
policy check of the declarative executor applies unchanged. The cache is the synced
service copy ([ADR 0013](0013-service-held-recipes-and-settings.md)); without a paired
service or a cached recipe, admitted documents stop with `recipe-not-found` without
opening the catalog or vault.

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
