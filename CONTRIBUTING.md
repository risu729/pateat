# Contributing

Pateat is in development and not released. This page is for anyone, people or agents,
who reports a problem: check first whether the behaviour is intended, then report it in
the format below. Code changes follow [AGENTS.md](AGENTS.md) and
[CI and server delivery](docs/delivery.md).

## Before reporting a bug

### Is it intended?

Several reported "bugs" were behaviour the design asks for. Search the documents for the
page's words, the popup's text or the outcome name (`challenge`, `no-route`, ...) before
filing:

```sh
git grep -n -i "send code" -- docs README.md
```

Intended behaviour is recorded in:

| Where | What it says |
| --- | --- |
| [README](README.md) | What works today and the protections not honoured yet |
| [Implementation plan](docs/plan.md) | What has been verified, what is open and which phase it belongs to |
| [Architecture](docs/architecture.md) | Product scope and how the parts behave |
| [ADRs](docs/README.md#decision-records) | Each decision, with what is not handled |
| [Differences from Bitwarden](docs/bitwarden-differences.md) | Where Pateat deliberately differs from the official extension |
| [Operations](docs/operations.md#extension-and-sign-in-failures) | Known symptoms with their checks and recovery |

Some behaviour that is intended and has been reported as a bug:

- SMS and email codes are not handled: the login ends as `challenge`, and Pateat does
  not press a control that sends a code
  ([ADR 0027](docs/adr/0027-per-account-login-routes.md),
  [ADR 0048](docs/adr/0048-password-method-button.md)).
- A passkey assertion has the user presence and user verification flags set without a
  check of its own
  ([ADR 0007](docs/adr/0007-existing-passkey-assertions.md#presence-and-verification)).
- No rule is written for one site; a problem seen on one site is fixed as a general page
  rule ([ADR 0033](docs/adr/0033-no-site-specific-features.md)).
- An `http:` page is used only for items saved with an `http://` URI
  ([ADR 0050](docs/adr/0050-http-pages-for-http-items.md)).
- Only Bitwarden vaults are supported, and of self-hosted Vaultwarden only its latest release
  ([ADR 0059](docs/adr/0059-latest-vaultwarden-server.md)).

When a document says the behaviour is intended and you think it is wrong, report it as a
change to that decision (a feature request) and link the document, not as a bug.

### Did it happen?

A report from a browser agent can describe something Pateat did not do: an agent once
reported that Pateat pressed a button the recipe never presses. Before filing, confirm
what Pateat did:

- Reproduce it yourself on the current build, in real Chrome or in cloud Chromium, and
  say which.
- Read the extension's log: settings, **Diagnostics**. The `login.attempt` lines say
  which step ran and how the login ended. **Copy for bug report** copies a report
  without vault values ([ADR 0019](docs/adr/0019-local-diagnostics-and-logs.md)).
- The owner can also read the service's records of the attempt on `/manage/problems`.

Search the [open and closed issues](https://github.com/risu729/pateat/issues?q=is%3Aissue)
for the site and the symptom before opening a new one.

## Reporting a bug

Use the **Bug report** issue form. A report has:

| Field | Example |
| --- | --- |
| Title | `accounts.example.com: password not filled after the email step` |
| Build | [`5467900`](https://github.com/risu729/pateat/commit/5467900) (link to the commit) |
| Where it was seen | Real Chrome, reproduced by hand; or cloud Chromium; or reported by a browser agent, not reproduced |
| Page | `https://accounts.example.com/signin/password`, with tokens and personal values in the query removed |
| Steps | 1. Open the page with one matching item. 2. Wait 20 seconds. |
| What happened | The words the popup and toolbar badge showed, quoted exactly, and what was filled or pressed |
| Expected | What should happen, and the document that says so, or "not documented" |
| Log | The **Copy for bug report** text, checked before posting |

Never include passwords, one-time codes, TOTP secrets, tokens, vault records, raw model
requests or full page captures. Issues are public. Write in English
([AGENTS.md](AGENTS.md)).

The form adds `type: bug`; labels for the area and for what the issue waits on are added
as in [Issue labels](docs/delivery.md#issue-labels). An issue that turns out to be
intended is closed with `resolution: by design` and a link to the document.
