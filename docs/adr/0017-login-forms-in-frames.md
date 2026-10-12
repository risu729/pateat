# ADR 0017: Login forms inside frames

Status: accepted by the owner on 2026-10-11 and implemented in the frame login PR.
Amends [ADR 0009](0009-install-time-https-site-access.md). Tested on synthetic
loopback fixtures only; no real site or account has been used.

Date: 2026-10-11

## Context

Some sites render their login form inside an `<iframe>`, either from the same site
(`https://www.bank.example/` embedding `https://www.bank.example/login-frame`) or from
another host of the same service (`https://login.bank.example/frame`). Before this
change the login content script ran only in the top-level document, and the background
refused every sender with `frameId !== 0`, so these forms were never filled.

Filling a frame by its own URL alone is unsafe: `https://evil.example/` could embed the
bank's real login frame, and an automatic login would then run inside a page the user
never chose to trust.

The official Bitwarden browser client has the same problem. Its
`apps/browser/src/autofill/services/autofill.service.ts` (`inUntrustedIframe()`, read
on main on 2026-10-11) fills a frame only when the frame's URL also matches the item's
saved URIs, given that the tab's URL already matched, and autofill on page load stops
with "Autofill on page load was blocked due to an untrusted iframe."

## Decision

The owner chose, on 2026-10-11, to fill a login form inside a frame only when **both**
the frame's URL and the tab's URL match the chosen vault item:

| Tab URL | Frame URL | Item URI (base domain) | Result |
| --- | --- | --- | --- |
| `https://www.bank.example/` | `https://www.bank.example/login-frame` | `bank.example` | fills |
| `https://www.bank.example/` | `https://login.bank.example/frame` | `bank.example` | fills |
| `https://evil.example/` | `https://login.bank.example/frame` | `bank.example` | refused with `frame-top-mismatch` |

- The login content script runs in every HTTPS frame (`all_frames: true`). A frame is
  admitted only when its own site and the tab's page are both admitted under ADR 0009:
  HTTPS, not excluded, and site access granted. An excluded site on either side stops
  it before any recipe, policy catalog or vault access. Intermediate frames of nested
  frames are not checked, as in the Bitwarden client.
- The recipe's `origin` and step `path`s are the frame's own. The recipe format does
  not change. A saved site default (`siteDefaults[].origin`) is also the frame's origin.
- The chosen item must match the tab's URL as well, either by its static allowed origins
  or by a live provider URI match of the tab's full URL. Otherwise the attempt is
  refused with `frame-top-mismatch` before any field is read. Each fill or click is
  authorized only while the tab still shows the origin the attempt matched. Without a
  saved choice, the single automatic choice is made only among items matching both
  URLs. As for any automatic choice, it is saved as the frame origin's site default
  after `authenticated` (ADR 0013), so a later visit to that origin uses it even where
  the frame's URL alone matches several items.
- A tab still runs one attempt at a time (its records are kept per origin since
  [ADR 0022](0022-login-attempts-per-tab-and-origin.md)). While a frame holds it, the
  page around the frame and any other frame (an advertisement, a widget) are refused
  with `tab-busy`. The same applies to frames while the top-level page holds the
  attempt. A record of another site than the tab's page holds neither (amended by ADR
  0022 on 2026-10-12). A new top-level document ends an attempt held by a frame only
  when that frame no longer answers, because a frame of the new page may announce before
  its own page does. A prerendered page, which Chrome also reports with a nonzero frame
  ID, is not treated as a frame.
- Completion and rejection are judged inside the same frame. When the whole tab
  navigates after a login inside a frame, the attempt ends `blocked` with outcome
  `cancelled`, whatever origin the new page has. It is neither resubmitted nor counted
  as `authenticated`, so the account choice is not saved. Recognizing such a navigation
  as success is later work.
- A frame keeps the URL it loaded with. A same-document URL change inside a frame
  (`history.pushState`) does not change the path the executor sees; a form that
  appears later in the frame on the same path still starts an attempt.
- This does not widen [ADR 0016](0016-recipe-generation-trigger.md): automatic recipe
  generation still considers top-level documents only.

## Alternatives

- Fill only frames on the tab's own origin. This refuses the second row of the table
  above, a common layout for bank logins.
- Check only the frame's URL. The third row would then log in inside a page on another
  site, which the owner rejected.

## Consequences

Every HTTPS frame now announces itself once on load. A frame on an origin without a
recipe stops there, as a top-level page without one does, so an advertisement frame
costs one message. The probe build lets a loopback page on another port act as the
tab's page so the refusal can be tested without an external site.
