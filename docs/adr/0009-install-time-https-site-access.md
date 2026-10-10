# ADR 0009: Install-time HTTPS site access for login pages

Status: accepted by the owner on 2026-10-10 and implemented in the production document
admission PR. No real-site or installed-profile acceptance has been run yet.

Date: 2026-10-10

## Decision

Declare `https://*/*` as a required host permission and register one static,
isolated-world content script on every top-level HTTPS document. Do not add the
`scripting` or `activeTab` permission. Plain HTTP pages are never admitted outside the
synthetic loopback probe build.

The content script only announces its document. The background admits a document only
when its exact origin (scheme, host and port) has a saved site default, the site is not
excluded, and Chrome still reports host access for that origin. Every other document
gets no attempt, observation, settings read or vault lookup; its announcement is
refused before any state is created. An admitted document still needs a saved local
recipe and a valid account binding, and every policy check of the declarative executor
applies unchanged. Until local recipe storage exists, admitted documents stop with
`recipe-not-found` without reading the vault.

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

The grant also covers provider HTTPS hosts, so connection setup no longer needs a
runtime host prompt. The provider transport still enforces the configured origin,
method and service path; the broader browser grant does not widen which endpoints a
connection may call.
