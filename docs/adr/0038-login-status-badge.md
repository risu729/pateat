# ADR 0038: The toolbar badge and popup show what a login did

Status: accepted by the owner on 2026-10-13 at 19:28 UTC, answering the four questions
of the reviewed proposal: 「1. 一旦点字 2. 赤！ 3. 緑数秒 4.
warningっぽいの数秒、詳しくはポップアップでよい」. Amends
[ADR 0021](0021-account-choice-outside-settings.md) (the waiting-choice badge and the
[site count badge](0021-account-choice-outside-settings.md#site-count-badge)) and
replaces the spinning toolbar icon the owner chose at 14:04 UTC the same day.

Date: 2026-10-13

## Context

Since main 2425307 the toolbar icon of a tab spun while a model request for its page was
in flight. The owner tried it in installed Chrome and wrote at 18:56 UTC that the
spinning icon was not what they expected, and asked whether the badge could turn
instead. At 19:10 UTC the owner asked to see, without reading the diagnostics log,
whether a page has a recipe and whether it was applied at login, partly for debugging,
to be hidden by a setting later. Until now the badge showed only a waiting account
choice, and the popup showed no recipe, attempt or failure.

Chrome's badge holds only text and colours (`setBadgeText`, `setBadgeBackgroundColor`,
`setBadgeTextColor`, per tab), so a turning badge is drawn by changing its text. A
survey of other extensions on 2026-10-13 found per-tab count badges common (Bitwarden,
Proton Pass, KeePassXC, uBlock Origin, Privacy Badger), a bare `!` for errors rare
(Privacy Badger red, uBlock Origin yellow), and animation almost unused.

## Decision

### Badge

One state shows per tab, the first that applies:

| State                      | Badge                                      | Colours (background / text)  |
| -------------------------- | ------------------------------------------ | ---------------------------- |
| A login waits for a choice | the candidates, e.g. `2`                   | amber `#8a5a00` / white      |
| A model request in flight  | braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, 100 ms each | indigo `#4f46e5` / white     |
| The last login failed      | `!`, until it is cleared                   | red `#b91c1c` / white        |
| The last login signed in   | `✓`, for 4 seconds                         | green `#15803d` / white      |
| The last result is unknown | `!`, for 4 seconds                         | yellow `#facc15` / `#1e293b` |
| Otherwise                  | none (the phase 2 count when it exists)    |                              |

1. **Model requests.** A first page or a continuation sent for generation, a sign-in
   entry page, or a page sent to the judge spins its tab's badge from the request's
   send until it returns, and at most two minutes. The toolbar icon shows only the lock
   state again; the spin's icon frames are removed. The owner chose braille "for now"
   (一旦); whether Windows Chrome draws it must be checked in installed Chrome.
2. **Failed.** A login that ends `blocked` with `credential-rejected`,
   `structural-mismatch`, `timeout`, `retry-limit`, `submission-limit`,
   `value-mismatch`, `fill-rejected`, `wrong-account` or `account-not-listed`; a
   refusal for `storage-unavailable`; or a generation that came back `failed` or
   `unavailable`.
3. **Unknown.** A submission whose result settled as `unknown-submit`, a second factor
   the page asks for (`challenge`), and a login that ended `blocked` with one of those
   (a watch that ran out) or with `challenge-abandoned`, `watch-abandoned` or
   `left-origin`.
4. **No result badge.** `cancelled`, `account-switched`, `interrupted` and
   `policy-changed` end a login without one, and a new login clears the last result.
   The vault's lock stays shown by the gray icon only (ADR 0021).
5. **Lifetime.** A result belongs to the tab. It is cleared when the tab starts another
   login, when the tab's top page loads with another origin than at its previous load
   (a page Pateat cannot read counts as another origin), or when the tab closes; the
   held-login tooltip and a waiting choice go with it. A login in a frame of another
   origin keeps its result while the top page stays. Chrome resets tab-specific badges
   when a tab commits a navigation, so the badge is written again after each commit and
   load. Results and spinning tabs are kept in `chrome.storage.session`
   (`pateat.login-badge.v1`), so a restarted worker redraws them and clears a spin that
   died with it; a result that changed since the start is not restored over.
6. **Tooltip.** The title names the state and, for a result, the outcome as the log
   names it, such as `Pateat: the login did not succeed (credential-rejected). Open
   Pateat for details.` The strings are English until the Japanese localisation.
7. **Waiting choice.** Its amber colour, decided for the site count badge, applies now.

### Popup

The popup gets a section for the current page, always shown for now; a setting to hide
it comes later. It says whether the site has a recipe, and if not whether the AI was
asked, is making one, or could not, and why; and whether this page's login started,
is running, signed in, or why it did not start or did not succeed. Outcomes get a
plain sentence; others show their log name. It ends with a link to the diagnostics
page, and shows no value, recipe content or URL query.

The section sits under the popup's header and asks the worker with `login.status.get`
every second while the popup is open. The worker answers from three sources:

- the recipe cache: a recipe, list of accounts or sign-in entry that starts on the top
  page's path (`page`), only on other paths, or none;
- its record of the top page, while the tab still shows that path: watching, sent for
  generation or refused with a reason, why its sign-in input did not start a login, and
  why it was last not sent for generation;
- the tab's last login and last model request, which the badge keeps from the log
  reports with its result's lifetime (item 5), also in `pateat.login-badge.v1`.

A page sent with no answer recorded, as after a worker restart, says so rather than
showing the AI as still busy. For `structural-mismatch`, `timeout` and `retry-limit` the
section adds that the recipe is not made again automatically.

## Consequences

- The site count badge, when built in phase 2, sits below the spin and the results, and
  a brief result goes back to the count.
- The worker writes the badge on each frame of a spin and after each page load; writes
  for one tab are ordered and send only changed fields.
- No permission or library is added: `tabs.onUpdated` gives the URL only for pages
  Pateat can read, and a result is kept when the URL is unknown.
