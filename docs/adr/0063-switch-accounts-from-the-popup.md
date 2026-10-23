# ADR 0063: Switch accounts from the popup

Status: accepted by the owner on 2026-10-23 and implemented in
[PR #866](https://github.com/risu729/pateat/pull/866), built with
[ADR 0062](0062-log-in-again-after-a-logout.md) at the owner's request of 2026-10-23
(05:28 UTC, 14:28 JST) to build on the likely answers and decide later. On 2026-10-23:

- 11:57 UTC (20:57 JST): build the switch in the same pull request as ADR 0062
  (「切替は一緒にやってしまいましょう」).
- 11:58 UTC (20:58 JST), how Pateat logs out
  (「方法1でいいです。ただし、多くなりそうなので、機械的にログアウトがどれかはっきりわかるときは送らないようにしたい。…ログアウトっぽいボタンを押して一定時間(5秒とか？)反応が無ければAIに送る感じで」):
  through the model, but a clear match of a logout control in the page is clicked first
  without a model call; when the page shows no reaction within about 5 seconds, several
  controls match, or a menu or dialog opens, the page goes to the model, with the local
  click.
- 11:59 UTC (20:59 JST), how long a pick that is not made the default lasts
  (「既定にするがオフの時は、毎回聞く、でいいです。自動ログインできない」): the site
  asks every time, logging in by itself no more, until a pick is made the default or the
  saved default changes. This replaces the proposal's pick kept for the browser session.

Builds the account switch that
[ADR 0021](0021-account-choice-outside-settings.md#later) kept for later and keeps the
owner's rules recorded there: a switch starts only from the person's choice in the
popup, and it also works on a site where Pateat has not logged in (owner, 2026-10-12
19:19 UTC). The re-generation of a missing logout target, the `accessible-name` locator
and moving a pick with a replaced tab are the agent's, not confirmed by the owner.

Date: 2026-10-23

## Context

With [ADR 0062](0062-log-in-again-after-a-logout.md), a logout is followed by an
automatic login with the same account, so logging out no longer offers another one. A
person who wants another account needs a way to ask for it while signed in.

Logging out is different on every site, and Pateat writes no site-specific code
([ADR 0033](0033-no-site-specific-features.md)). Pages are judged by the AI first
(owner, 2026-10-12 04:36 UTC), but most sites name their logout control in plain words.
The extractor leaves out hidden elements, so a logout item inside a closed account menu
is not in the observation until the menu is open.

## Decision

### Switching

- In a tab without a waiting choice, the popup's "Switch account" section lists the
  site's matching items, each with "Switch to this account". The item of the tab's last
  authenticated login is marked "Used in this tab"; Pateat does not otherwise know which
  account is signed in. A "Make it the default for {host}" checkbox starts unticked.
- Pressing it logs the site out and then logs in with that item. The pick is kept for
  the tab and site for two minutes in `pateat.login-switch-picks.v1`
  (`chrome.storage.session`), so the login after the logout uses it; it ends when it
  starts a login, when the switch fails or when the tab closes, and moves to the tab
  that replaces its tab (`tabs.onReplaced`, as a prerender does). A switch pick comes
  first in the account choice, then a popup pick; then a paused site or an asking tab
  asks; then the saved default, then the only match.
- A switch is refused when the tab has no page, a choice waits, a switch or login runs,
  another tab's login holds the site (`site-held`, as a login waiting for a code in a
  tab that shares its cookies does,
  [ADR 0022](0022-login-attempts-per-tab-and-origin.md)), the settings cannot be read,
  the item is not a candidate, or no paired service can answer. A paused site, also one
  an exclusion rule or a private window pauses
  ([ADR 0062](0062-log-in-again-after-a-logout.md)), still switches: the switch is the
  person's pick.
- The logout first runs the site's stored logout recipe for the page's origin and path.
  Past its end, or without one, the page's one shown control that says it logs out of
  this site is looked for in the page (`apps/extension/src/page/logout-controls.ts`):
  "log out", "sign out", "log off" and the like as whole words, or ログアウト,
  サインアウト, ログオフ, サインオフ, on a button, link, menu item or other control;
  words for logging out other devices, sessions or accounts do not count, and no site is
  named. When exactly one control matches, it is clicked without a model call and the
  page is watched for 5 seconds (`LOGOUT_REACTION_MS`). A sign-in input or a recipe's
  first step afterwards, or a new page that offers no logout control, ends the logout.
  When the page did not react, the click is not kept and the page goes to the model;
  when a dialog or menu opened, or the page changed and still shows the account, the
  page goes to the model with that click (`local`), and the recipe the model answers
  starts with it. Several matching controls, or none, also send the page to the model.
- The model request: the tab's top page is observed and sent to the service with only
  what finds its logout: the page's title and the shown buttons, links and menu items of
  its open dialogs and menus, header, navigation and account areas (an element whose ID,
  class or label names the account, user or profile), and elsewhere only a control whose
  name says it logs out, at most 48, those of an open dialog or menu first, each by its
  label. No heading, description or other text of the page is sent, the texts are
  redacted as a login page's are, numbers removed, and the request log keeps no more
  than it keeps of a login page's request. The service's model answers the control that
  logs out or, when none is shown, the control that opens a menu holding it. After a
  click the page is observed and sent again, also for a confirmation dialog, for at most
  three clicks, through `POST /v1/recipes/logout`. The answer is a logout recipe, a
  signed-out page, or an abstention (`no-logout-control`, `ambiguous`,
  `insufficient-evidence`, `unsafe-instructions`). After each click Pateat waits for the
  page to be quiet for 1.5 seconds, at most 15 seconds.
- A stored click whose control is gone, or no longer alone, is asked for once more in
  its place (`base.keep`): the service replaces the recipe's clicks from there with the
  answer. A switch fails with `no-logout-control`, `still-signed-in`, `page-unreadable`,
  `target-missing` (also after that second try), `page-changed`, `left-site` or
  `service-unavailable`.
- After the logout, the login page logs in with the picked item. A site that lands on a
  page with a sign-in entry recipe ([ADR 0031](0031-sign-in-entry-pages.md)) has its
  entry pressed, without the `no-return-target` and `site-record` checks, only for this
  switch.
- The popup says when no logout control was found, when the page still looks signed in
  after three clicks, and when another tab's login holds the site. It also says that a
  site signing in through an identity provider
  ([ADR 0026](0026-sign-in-through-identity-providers.md)) may sign in to the same
  account again, since the provider's session stays.
- The log shows `login.switch` with its stage (`start`, `click`, `end`), outcome and
  reason, and for each click its `purpose` and `source` (`recipe`, `model` or `local`),
  a failure as a warning, under [ADR 0019](0019-local-diagnostics-and-logs.md).

### Logout recipes

- A stored recipe gains a `logout` member, `{path, targets}`, whose at most three
  targets are clicks (`{kind: "click", path, target, purpose}` with `purpose` `menu`,
  `logout` or `confirm`). A target uses the login recipes' locators `id`, `name`,
  `test-id`, `data-test` and `text`, or `accessible-name` (its `aria-label` or `title`)
  for a control that shows no text of its own, such as an icon-only account menu, or a
  menu item; a text or name that holds a number or an `@` is never one, as it may be the
  account's, and the service refuses a local click named by an account's text. Its ID is
  salted with `["logout", origin, path]`, and the automatic recipe removal of
  [ADR 0058](0058-automatic-recipe-removal.md) leaves it alone. Stored recipes are told
  apart by their members, as `entry` and `chooser` are. The service keeps logout recipes
  apart from login recipes, so a logout recipe on `/` does not replace an ADR 0031 entry
  recipe there.
- A model request costs about as much as a login page's (about $0.007). A site whose
  logout control says so in plain words needs none; others make one to three on their
  first switch. It counts against the same daily and monthly limits as recipe
  generation. The prompt names no site.

### Picks that are not made the default

A pick with "Make default" off, in the ADR 0021 B choice or in a switch, of an account
other than the saved default, makes its registrable site ask every time once its login
is confirmed signed in, separately for incognito, until the browser closes
(`pateat.login-ask-every-time.v1` in `chrome.storage.session`, at most 200 sites). No
automatic login starts there: each login page is refused `account-asked` with detail
`one-time-pick` and lists the accounts, filling nothing, also while the tab asks for
another reason, and the person's own passkey requests open the chooser with the
default treated as unset (handed on as `default-unset` where it cannot open). The
asking ends when a pick is made the default or the saved default itself is picked, or
when the site's saved defaults change, saved, changed or removed anywhere. Before, such
a pick lasted one login; with ADR 0062 the next automatic login after an expiry or
logout would otherwise return to the default account without the person noticing.
"Make default" on saves the default after a confirmed sign-in, as
[ADR 0021](0021-account-choice-outside-settings.md) already does.

## Considered alternatives

- Clear the site's cookies and storage with `chrome.browsingData.remove` (`origins`):
  needs no logout control, but adds the `browsingData` permission, clears cookies for
  the whole registrable domain including "remember this device", which makes banks ask
  for a device check again, signs out every account of the site and leaves the
  server-side session alive.
- Find the logout control only by fixed words, as the former logout-click detection
  did: no model call, but it misses controls inside menus, icon-only controls and words
  in other languages, as ADR 0031 found for entry links. The words now only decide
  clear cases before the model.
- Always ask the model: one to three paid requests on every site's first switch, also
  where a "Log out" link is plain.
- Ask the [ADR 0029](0029-local-sign-in-state.md) judge for the logout control: it runs
  only for some logins, so most sites would still need the request above.
- A pick that lasts one login, as before, or the proposal's pick kept for the browser
  session, which automatic logins would use without asking.

## Consequences

- A control with no lasting `id`, `name` or test ID, no text or accessible name of its
  own that names it alone, or whose text holds a number or an `@`, has no locator, so a
  logout through it cannot be learned.
- A stored logout recipe whose control is gone is asked for once more; only a second
  miss fails the switch with `target-missing`.
- A plain logout control may be clicked without the model even where the model would
  have chosen another; a page that does not react goes to the model.
- The first switch on a site without such a control spends one to three model requests.
- After a one-time pick the site asks on every login page until the browser closes or a
  default is set, which may be more often than a person expects.
- A switch on a site whose logout passes through another site that Pateat reads, or
  whose logout control is inside a closed shadow root or a cross-origin frame, fails
  with a message in the popup.
