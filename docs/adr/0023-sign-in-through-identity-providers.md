# ADR 0023: Signing in to a site through an identity provider

Status: accepted by the owner on 2026-10-11 (12:20 UTC) as policy; not implemented. The
owner set it as low priority: this record fixes the direction, and implementation waits.
Builds on [ADR 0022](0022-login-attempts-per-tab-and-origin.md). Researched from public
documentation only; no real site or account has been used.

Date: 2026-10-11

## Context

Many sites offer "Continue with Google" or "Sign in with Microsoft" instead of, or next
to, their own password form. The owner wants Pateat, on such a site's login page, to
press the entry the owner uses for that site and to carry on through the identity
provider (IdP), without granting anything new.

Today Pateat cannot do this. A recipe needs at least one slot and one step
(`loginRecipeSchema` in `packages/contracts/src/login.ts`), and neither `siteDefaults`
nor a vault item can say "this site signs in with Google". Links are clicked only as a
recipe's `accountSwitch`. An IdP page that is the first login of its tab, such as a
popup, already works like any other site with its own recipe and vault item.

Public documentation of Google, Microsoft, GitHub, Okta, Auth0, Keycloak, LINE, Apple
and Yahoo! JAPAN shows:

- With an existing grant and session most IdPs return to the site without any page.
  Pages that do appear are account choosers (Google "Choose an account", Microsoft "Pick
  an account"), "Stay signed in?" (Microsoft, Okta), LINE's "次のアカウントでログイン"
  and Apple's Face ID or password check, which is operating system UI.
- A site can force the permission page on every sign-in with `prompt=consent`; it then
  looks the same as a first grant.
- Some sites create an account on the first return without any page, such as a Slack
  workspace whose admin set up Google Workspace sign-in.
- A content script's click carries no user activation, so SSO buttons that open a popup,
  Google's button inside its iframe, One Tap and FedCM (Chrome's own dialog) are out of
  reach (expected; not checked in Chrome).

## Decision

The owner chose, on 2026-10-11:

- **The per-site choice lives in Bitwarden.** The site gets its own item with an empty
  password, the IdP account as its username and a text or hidden custom field named
  `SSO` holding the IdP's origin:

  | Item          | URI                           | Username            | Password | Custom field                          |
  | ------------- | ----------------------------- | ------------------- | -------- | ------------------------------------- |
  | Notion        | `https://www.notion.so`       | `taro@gmail.com`    | empty    | `SSO` = `https://accounts.google.com` |
  | Google (taro) | `https://accounts.google.com` | `taro@gmail.com`    | set      | none                                  |
  | Google (work) | `https://accounts.google.com` | `taro@corp.example` | set      | none                                  |

  The IdP item used is the one matching the IdP's origin whose username equals the site
  item's username, ignoring surrounding spaces and letter case. None or several stop the
  login. The IdP origin's `siteDefaults` entry is neither used nor saved by such a
  login, so direct logins to the IdP keep their own default. Several site accounts are
  several site items, chosen as today
  ([ADR 0021](0021-account-choice-outside-settings.md)).
- **Field rules.** Exactly one `SSO` field; its value is read as a URL and reduced to
  its origin; an unreadable value or a duplicate field stops. The value is never filled
  into a page or sent to the service or a model. An excluded `SSO` field means no SSO.
  An item with `SSO` is never a candidate on the IdP's pages and never used by a
  password recipe or by recipe generation, even when it has a password.
- **First IdPs: Google and Microsoft**, including personal Microsoft accounts. Pateat
  knows each IdP's origins (`https://accounts.google.com`;
  `https://login.microsoftonline.com` and `https://login.live.com`) and the pages it may
  act on there.
- **On the site.** The site's recipe lists its SSO buttons or links per IdP. Pateat
  presses one only when the chosen item has `SSO` for that IdP, exactly one element
  matches, on the same path, within 10 seconds, and it navigates the same tab. A link is
  pressed only when its `href` origin is the site's or the IdP's; a button that submits
  a form only when the form's target origin is the site's or the IdP's. Entries that
  open a new window are never pressed. SSO that first asks for a work email or company
  domain on the site is out of scope.
- **On the IdP.** After the press, Pateat remembers the tab, the site and IdP origins
  and the username while the tab's top-level page stays on the IdP's origins. There it
  acts only on pages it recognises by origin, path and heading, never by a button id
  alone:
  - the login form, filled from the IdP item above with the IdP's recipe;
  - the account chooser entry whose email equals the username exactly (no partial
    match); a chooser that says the account's details will be shared with the site stops
    until it has been checked in Chrome;
  - "Stay signed in?" and LINE's "次のアカウントでログイン", which are pressed.
- **Everything else stops**: any permission page, including one forced by
  `prompt=consent`; Apple's "Share My Email / Hide My Email"; account creation pages on
  either side; chains where the IdP itself signs in through another IdP.
- **Success** is the site's own login check after the return.

## Alternatives

- Keep the per-site IdP and account in Pateat's settings (the service web UI). Rejected:
  the owner wants it next to the other credentials in Bitwarden.
- Short IdP names such as `google` in the field. Rejected: they cannot name a company's
  own IdP such as `https://example.okta.com` later.
- Continue through permission pages that were granted before. Rejected: a forced
  `prompt=consent` page cannot be told apart from a first grant.

## Consequences

- Until this is implemented, an item in this shape is used like any other: Pateat may
  generate and run a recipe that fills the email on the site. Such items should not be
  created before the implementation.
- A site that creates accounts without asking still does so if the item's username is
  not an account the site already knows.
- Left to implementation: the recipe shape for SSO-only sites (no slots), generating SSO
  entries (ADR 0016's input condition replaced by an item with `SSO`), the per-IdP page
  list, how long the remembered press stays valid, and `origin-busy` on IdP pages.
- Google and Microsoft password pages also need recipe continuation after an `advance`
  step ([ADR 0018](0018-recipe-generation-route.md)) or hand-written IdP recipes.
- Real-site checks need real accounts and therefore separate owner approval.
