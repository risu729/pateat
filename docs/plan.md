# Implementation plan

Status on 2026-10-11 (main `b00b5b7`): M0 completed in
[PR #1](https://github.com/risu729/pateat/pull/1). The production extension connects a
real Bitwarden account, admits HTTPS sites
([ADR 0009](adr/0009-install-time-https-site-access.md)), runs synced or generated
recipes and signs with stored passkeys; passkey sign-ins have passed on real sites. A
generated recipe has run in installed Chrome only on `https://www.npmjs.com`, where the
attempt stopped as `policy-changed` before
[#234](https://github.com/risu729/pateat/pull/234). The service runs at
`pateat.takuk.me` with automatic releases, hosted smoke checks, the owner web UI and
Claude recipe generation under spending caps; the deployed service first called
Anthropic on 2026-10-11 at 12:27 UTC. Work follows the [roadmap](#roadmap) below, which
assigns the milestone gates still open to its phases.

This plan is the single work tracker until the remaining tasks move to issues in
[phase 4](#phase-4-issues-and-work-as-needed). Issues and PRs link to these gates rather
than maintaining a second roadmap.

## Roadmap

The owner set these phases on 2026-10-11 (18:11 UTC): first make Pateat complete enough
to use, then use it and fix what comes up, then release it publicly, then track the rest
as issues. The milestone table under [ordered milestones](#ordered-milestones) still
defines what each milestone delivers. Every milestone gate that was open on 2026-10-11
is listed in one phase below; placing the gates the owner's message did not mention (the
Bitwarden account checks in phase 3, and the rest in phase 4) is a proposal for the
owner to confirm.

The owner re-split the phases on 2026-10-12 (20:35 UTC), because phase 1 was finishing
slowly while phase 2 work had already started: phase 1 is now done when each kind of
login page works on at least one real site, rather than on every listed site, and the
untested daily-use sites, the Grok Bot sites still failing and the remaining
installed-Chrome checks moved to [phase 2](#phase-2-use-it-and-fix-what-comes-up).

### Phase 1: usable

Done when each kind of login page below works on the real site named for it, in the
owner's installed Chrome on a production build of main: Pateat signs in and its record
of the attempt ends `authenticated` (owner, 2026-10-12 20:35 UTC, replacing the
2026-10-11 rule that every daily-use site and every Grok Bot site must log in). Status
first written on 2026-10-12 (20:50 UTC); each row gives the date of its latest check:

| Kind of login page | Site | Status |
| --- | --- | --- |
| Identifier and password on one page | Vpass, リクルートID | Done |
| A value from a custom field | アパホテル (member ID) | Done |
| Email, then Next, then password (`advance`) | Grafana Cloud | Done: on `cdfa420` (2026-10-12 20:50 UTC) the signed-in page was judged `signed-in` and the record ended `authenticated`, also from a new tab after a logout |
| A list of saved accounts ([ADR 0028](adr/0028-account-chooser-login-pages.md)) | Cloudflare, Wise | Done. Cloudflare: on `cdfa420` (2026-10-12 20:59 UTC) Pateat pressed the default account's row, then the password and the passkey second factor, and the record ended `authenticated`. Wise: on `fdf57ef` (2026-10-13 02:25 UTC) a login from the list ended `authenticated` |
| A sign-in entry button ([ADR 0031](adr/0031-sign-in-entry-pages.md)) | pixiv | Done |
| A stored passkey | npm, pixiv | Done |
| The page's own passkey request, including `required`, and choosing again after a logout ([ADR 0034](adr/0034-answer-page-passkey-requests.md)) | Wise | Signed in with the passkey on `1df2d38`; no Bitwarden "Save passkey" window followed on `fdf57ef` (below); recheck the choice after a logout |
| A TOTP code from an authenticator app, the source said outside the code form or not at all | Resend | Done: on `2675f0f` with the service at `4ece681` (2026-10-13 05:06 UTC), Pateat went from `/login` through the email, Next and password, the judge answered `challenge`, Pateat typed the item's TOTP and submitted it, and the record ended `authenticated`; nobody typed the code. On `fdf57ef` the code had been dropped as `source-unknown`; a code page that says nothing about where the code comes from now keeps the code and types the item's TOTP once (ADR 0027, owner, 2026-10-13 04:01 UTC) |
| A TOTP code split into one-digit inputs | ニコニコ | Candidate from its public code (six `maxlength` 1 inputs, [research](research/2026-10-12-split-totp-inputs.md)). In the owner's Chrome on 2026-10-13 at 04:56 UTC the code was typed and submitted, but the signed-in `www.nicovideo.jp/` was judged `unclear` and the login ended `left-origin`: its only signed-in link, to `/my`, shows the nickname. A marker may now name a link by its path (owner's 「リンク先で見分ける」, 05:17 UTC) ([ADR 0029](adr/0029-local-sign-in-state.md)). Done in two runs: on `2675f0f` (04:56 UTC) Pateat typed the item's TOTP into the six inputs, and on `7226178` (07:38 UTC) the moved-to `www.nicovideo.jp` page was judged `signed-in` and the record ended `authenticated`, with no code page that time. Both in one run is not yet seen. Resend has one input (real-Chrome check, 2026-10-12) |
| Approval in an app, then the signed-in page ([ADR 0027](adr/0027-per-account-login-routes.md#watching-after-a-challenge)) | 三菱UFJダイレクト | Done |
| A software keyboard or extra PIN page, left to the person | エポスNet | On `7226178` (2026-10-13 07:35 UTC) the ID and password login ended `authenticated`, but the site did not ask for the card security code that time; the PIN page itself is not rechecked |
| A CAPTCHA the person solves, then the signed-in page | Q-move | Done: on `8b60ff2` (2026-10-13 06:56 UTC) the owner ticked the reCAPTCHA while Pateat watched, and the record ended `authenticated`. Earlier a disabled field had kept the signed-in page from the judge ([ADR 0029](adr/0029-local-sign-in-state.md)) |
| A signed-in page on another host of the same site | JAL (`jallogin.jal.co.jp` to `www.jal.co.jp`, after a passkey), モッピー (`ssl.pc.moppy.jp` to `pc.moppy.jp`, after a password) | Both records ended `left-origin`. JAL: done (signed in on `4deb95d` in the owner's Chrome, 2026-10-13 09:05 UTC: the `www.jal.co.jp` page was judged `signed-in`, marked `moved`, and the account choice was saved; started from JAL's own sign-in button in a fresh tab). モッピー: done; a password login completes when the new host's page shows the account's username, or, when it does not, a marker learned on that host shows or the judge answers `signed-in` once (signed in on `fdf57ef` in the owner's Chrome, 2026-10-13 02:53 UTC: the `pc.moppy.jp` page was judged `signed-in`, marked `moved`, and the account choice was saved) ([ADR 0022](adr/0022-login-attempts-per-tab-and-origin.md)) |
| A signed-in page on another site after a TOTP code | Microsoft (`login.microsoftonline.com` to `m365.cloud.microsoft`, Grok Bot) | Ended `left-origin` on 2026-10-12 22:05 UTC. A move to another site within 30 seconds of a submitted TOTP code now completes on the same checks as モッピー, the username or one judgement (owner's 「コード送信後だけ」, 2026-10-13 01:59 UTC; synthetic tests only; recheck on the Grok Bot) ([ADR 0022](adr/0022-login-attempts-per-tab-and-origin.md)) |
| A signed-in page on another site after a passkey second factor | Oracle Cloud (security key after the password on an `oraclecloud.com` sign-in host, then `cloud.oracle.com`) | Ended `left-origin` on 2026-10-13 02:59 UTC, 3 seconds after Pateat answered the security key. A move to another site within 30 seconds of a passkey Pateat answered after the item's password now completes on the same checks (owner's 「同じ扱い」, 2026-10-13 03:13 UTC). Done: on `4deb95d` in the owner's Chrome (2026-10-13 08:58 UTC) the sign-in page that went away before it was read kept the login ([#484](https://github.com/risu729/pateat/pull/484)), the IDCS login answered the security key, `cloud.oracle.com` was judged `signed-in`, marked `moved`, and the account choice was saved ([ADR 0022](adr/0022-login-attempts-per-tab-and-origin.md)) |
| Google's own sign-in (email first, account choice) | Google | Done: on `8b60ff2` (2026-10-13 07:24 UTC), from `accounts.google.com/AddSession` without signing out, Pateat answered with the item's passkey, returned to `myaccount.google.com`, and the record ended `authenticated`; nobody pressed anything |
| Choosing among several accounts of one site in the popup ([#187](https://github.com/risu729/pateat/pull/187)) | GitHub | Signed in; recheck the shortened item IDs and the silent stop while another tab's login holds the site, and that a pick of an item with a passkey signs in with it ([ADR 0034](adr/0034-answer-page-passkey-requests.md), local tests only) |
| Fill only after a logout | アパホテル | Done |
| Nothing on a site without a password or passkey sign-in | ABEMA | Done (judged from the code and the Grok Bot's log) |
| Pages that stopped before generation | モッピー, LinkedIn | Done. モッピー: generated and `authenticated` on `fdf57ef` (2026-10-13 02:53 UTC, row above). LinkedIn: on `c3dc87a` (2026-10-13 06:30 UTC) a new tab on the remembered-account password page generated a recipe, filled and submitted it, the judge answered `signed-in` and the record ended `authenticated` ([ADR 0037](adr/0037-fields-by-visible-name.md)) |

The rechecks share one extension reload. The UI polish also stays in this phase. The
site lists name the owner's own accounts, so they stay in the project's files rather
than in this repository.

- Sites where the owner has no password or passkey sign-in, only a code or link sent
  by email or an identity provider, are out of scope for phase 1 (owner, 2026-10-12
  14:01 and 14:21 UTC). Such a site counts as done once a check shows Pateat does
  nothing there, and waits for those sign-ins in
  [phase 4](#phase-4-issues-and-work-as-needed). Claude, where the owner signs in by
  email, Tailscale, Zenn and Vercel are recorded as such sites; the last three were
  judged from their usual sign-in pages, not checked. ABEMA is one too: its web site
  switches accounts only with a code sent by email, Google, Apple, or an ID and
  one-time password issued on another device (checked in cloud Chromium on 2026-10-12
  at 19:10 UTC, without Pateat). That Pateat does nothing there is judged from the code
  and from the Grok Bot's log of 2026-10-12, which has no ABEMA entry after the Bot
  opened `abema.tv/mylist` (build `a8350f5`).
  myUNSW is one too: it signs in through UNSW's single sign-on page
  (`sso.unsw.edu.au/cas/login`), which offers "Agree and sign on" with the account's
  address while the matching item's username is not an address (owner, 2026-10-13
  04:41 UTC). In the owner's Chrome on 2026-10-13 at 04:34 UTC, with build `2675f0f`
  ([#454](https://github.com/risu729/pateat/pull/454)), Pateat saved no recipe there
  and pressed nothing; the page was logged as `no-listed-account` with
  `no-email-username`.
- Done: login attempts whose result settled as unknown no longer hold settings writes
  for the next login, and a vault replacement no longer runs during a login
  ([declarative recipes](architecture.md#declarative-recipes-and-ai)); diagnostics log
  events for sync, page judgements, handlers and the cause of `policy-changed`
  ([local log](architecture.md#local-log)).
- [ADR 0027](adr/0027-per-account-login-routes.md) deliveries 1
  ([#240](https://github.com/risu729/pateat/pull/240)), 2
  ([#223](https://github.com/risu729/pateat/pull/223)) and 3
  ([#245](https://github.com/risu729/pateat/pull/245),
  [#246](https://github.com/risu729/pateat/pull/246)) are merged, and so is delivery 4
  except its deferred part, which is in [phase 4](#phase-4-issues-and-work-as-needed).
- Log in on pages that list accounts and show no form until one is chosen, such as
  Cloudflare's saved profiles at `https://dash.cloudflare.com/login`, Wise's "Welcome
  back" page and Instagram's saved profiles
  ([ADR 0028](adr/0028-account-chooser-login-pages.md), accepted 2026-10-12). The owner
  asked for it at 07:44 UTC 2026-10-12. Finding entries and the observation are in
  [#314](https://github.com/risu729/pateat/pull/314), and finding an account shown
  beside separate buttons (Wise, Instagram) is in
  [#323](https://github.com/risu729/pateat/pull/323), and the service stores, syncs and
  lists a chooser recipe, which the extension caches but never starts
  ([#327](https://github.com/risu729/pateat/pull/327)). The service answers a list page
  with a chooser recipe and generates and judges each branch's pages into it
  ([#334](https://github.com/risu729/pateat/pull/334)). The extension now sends list
  pages ten seconds after loading, skips the page right after a submitted password form,
  hides a username that is not an email as `[account]`, and stores the answer
  ([#335](https://github.com/risu729/pateat/pull/335)). It then runs the chooser: the
  account's entry, the `continue` button or `other`, then the branch, generated as any
  recipe after an `advance` step ([#332](https://github.com/risu729/pateat/pull/332)),
  or ends `account-not-listed` (local tests only). Next, the checks on Cloudflare, Wise
  and Instagram in the owner's Chrome. Since 2026-10-17 (owner, after Cloudflare's
  "Sign in with another profile" form started nothing), a form with an account field on
  the list's path is sent as the `other` branch's first page while the chooser has no
  such branch (local tests only).
- Press a site's sign-in link on a page the site sent the visitor to before signing in,
  shown by a query value naming another path of the same site, such as pixiv's top page
  `https://www.pixiv.net/en/?return_to=%2Fbookmark_new_illust.php`, whose "Login" leads
  to `https://accounts.pixiv.net/login` ([ADR 0031](adr/0031-sign-in-entry-pages.md),
  accepted 2026-10-12). Generation on that login page succeeds since build `e9144a6`
  (2026-10-12 07:24 UTC). The service stores, syncs and lists a recipe with only
  `entry`, and the extension caches it, never as a login (local tests only); ADR 0028's
  `chooser` builds on that contract. The service generates that recipe from an entry
  request, a page sent without slots, with the `entry` decision, its prompt line and
  plan checks (#336, local tests with fake models only). The extension sends such pages
  ten seconds after loading, presses a cached entry after the checks before the press,
  checks the page it leads to and blocks the revision on the device when that page left
  the site, showed no sign-in or identifier input (ADR 0016) or showed a sign-up form,
  logging `login.entry`; the entry path counts as a recipe start in `offersGeneration`
  only (local tests and a synthetic browser test only). Verified on pixiv in the owner's
  Chrome on build `a8350f5` (2026-10-12, reported 18:46 UTC): after a logout, Pateat
  signed in through the top page's "Login" button, and generation on the login page it
  led to sent the username as `[account]` and succeeded.
- [ADR 0029](adr/0029-local-sign-in-state.md) (accepted 2026-10-12): delivery 1 logs the
  local sign-in state of the page after a submission as `login.state`. Delivery 2's
  first part is implemented: evidence of a sign-in that a second reading a second later
  confirms completes a `password`-route login without a model call (owner's choice,
  2026-10-12 06:58 UTC, after アパホテル's login stayed unknown though its marker
  showed). The other rows of the ADR's outcome table are implemented too: a failure next
  to the fields rejects, also when the sign-in form comes back as the first new document
  after the submission with an invalid mark or an alert next to it and no recognised
  CAPTCHA, even once watched (owner, 22:03 UTC, after GitHub's login with the wrong
  account stayed unknown at 21:16:51 UTC), a sign of another sign-in step the
  judge does not decide goes to the person, and no sign and no evidence asks the judge
  once and completes when it cannot decide, never on a path judged `challenge` or
  `rejected` before or whose earlier request has no verdict (local tests only). The
  judged page also carries its header and navigation text (`headerText`, up to 1,000
  characters, local tests only).
  The title, headings and each candidate's label, placeholder and description are cut at
  120 characters once every number is hidden, as the header text is cut once at 1,000,
  so the start of a username cut at the limit stays the end of the text and is hidden
  (gap found in the review of the header text, 2026-10-12; fixed 2026-10-13, local tests
  only). Attributes are read whole and an element's rendered text up to 480 characters.
  The recipe's `completion` is a list of up to four signed-in markers without a path,
  and a later page the judge answers `signed-in` for adds its marker (local tests only).
  Pages that
  could not be sent are now sent: a token-like path segment goes as `[id]`, and a field
  no locator names is left out unless it may be a sign-in field (owner, 19:23 UTC, after
  Cloudflare, Grafana Cloud, Wise and JP BANKカードWEB stayed unknown; local tests
  only).
- SBI証券 after generation. Evidence, 2026-10-12, from the owner's Chrome and its local
  log: a recipe was generated at 13:54:41 UTC for `/login/entry` and a login started at
  once on the `passkey` route; the page's conditional passkey request was handed to
  Bitwarden (`passkey.request` `delegate` `unsupported-mediation`), and the login
  stopped with `login.exception` (state `reconciling`) at 13:55:39 UTC. A new tab at
  14:08 UTC logged in. Such a conditional request now waits for the login
  ([ADR 0034](adr/0034-answer-page-passkey-requests.md)), and the `reconciling`
  exception, also seen after submissions on other sites, moved to
  [phase 2](#phase-2-use-it-and-fix-what-comes-up).
- Start pages that replaced the sent page during generation. While looking into SBI証券,
  the code showed a race that was not its cause: a page that replaced the sent page in
  its tab, or the same page in another tab, announced while the request was in flight,
  logged `recipe.generate` `skipped` `sending`, then `recipe-not-found` at debug, and
  was never asked to announce again. Once a recipe returns, every tracked page of that
  origin and path that holds no login is now asked to announce again; a page that could
  not be asked logs `reconnect-failed`, and a page that resumes a login held after a
  submission and does nothing logs `not-started` with `stopped-login` (local tests
  only). Not fixed, and moved to [phase 2](#phase-2-use-it-and-fix-what-comes-up):
  `generate` in `apps/extension/src/service/generation.ts` ignores a failed sync after
  generation, so a page could still find no recipe.
- Prefer the item's passkey over the password on login pages that ask for a passkey by
  themselves, such as Wise's ([ADR 0034](adr/0034-answer-page-passkey-requests.md),
  accepted 2026-10-12 14:19 UTC): a page's `conditional` request is answered through
  the login of its page, which falls back to the password when the site does not sign
  in; pages without a recipe keep delegating. In the owner's Chrome on 2026-10-12
  (18:30 and 18:43 UTC) Wise's requests were `conditional`, but its login ran as a
  chooser login (ADR 0028), which the first implementation left on the password; a
  chooser login now answers too, before its click on the list (local tests only).
  The Bitwarden extension's passkey window, then Windows Security, came from Wise's "Log
  back in", which asks with `mediation: "required"`: on build `f971955` at 19:20 UTC
  Pateat logged that request as `passkey.request` `delegate` `unsupported-mediation`.
  As the owner chose on 2026-10-12 (19:32 UTC), Pateat now answers a `required` request
  as it answers an `optional` one
  ([ADR 0007](adr/0007-existing-passkey-assertions.md); local tests only). In the
  owner's Chrome on build `1df2d38` (2026-10-12, 20:17 to 20:43 UTC), Wise's "Welcome
  back" list and "Log back in" signed in with the passkey (`passkey.request`
  `assertion`), but the Bitwarden extension then sometimes opened its "Save passkey"
  window ("A passkey already exists for this application."). The cause: after the
  sign-in Wise asks to register a passkey (`navigator.credentials.create`), and its
  `excludeCredentials` lists the passkey Pateat just used, which Bitwarden's vault
  holds. As the owner chose at 20:56 UTC, Pateat now wraps `create` and refuses such a
  registration with Chrome's own `NotAllowedError`, as when Chrome's prompt is
  dismissed, within five minutes of Pateat's sign-in to that site in the same tab, and
  logs each checked registration as `passkey.create`
  ([ADR 0007](adr/0007-existing-passkey-assertions.md#registration-after-a-sign-in);
  confirmed in the owner's Chrome on build `fdf57ef`, 2026-10-13 02:25 UTC: Wise's
  `conditional` registration two seconds after the passkey sign-in was declined, the
  login reached signed in, and no Bitwarden window was reported).
- Redact the account's own username from every page observation sent to the service
  (generation, its continuation after an `advance` step, and the judge): each matching
  item's username of three or more characters is hidden as `[account]` wherever it shows
  as a whole text or as part of a longer one, ignoring case and width, under ADR 0028's
  rule for a listed name; a control whose locator holds one is left out, or the page is
  refused (`username-shown`) when that would leave it incomplete; and a failed username
  read refuses the page (`username-unread`). The username is read locally as for the
  username shape ([ADR 0016](adr/0016-recipe-generation-trigger.md#username-shape)) and
  never sent. The page after an `advance` step, like any judged page, can show the
  identifier just entered (continuation review, 2026-10-12). Implemented
  ([#369](https://github.com/risu729/pateat/pull/369); local tests, and on pixiv in the
  owner's Chrome on build `a8350f5`, where a generated page sent the username as
  `[account]`; [architecture](architecture.md#declarative-recipes-and-ai)). Not covered:
  an email username's local part shown alone, a username in the origin (a personal
  subdomain), and the usernames of items on a connection that could not answer. Sign-in
  entry pages ([ADR 0031](adr/0031-sign-in-entry-pages.md)) are not covered either,
  because that ADR reads nothing of the vault there beyond the URI match.
- Choosing again after a logout on the passkey side, placed in phase 1 by the owner on
  2026-10-12 (14:26 UTC): already implemented on 2026-10-11 by
  [#204](https://github.com/risu729/pateat/pull/204) (a username-less request after
  Pateat signed in the tab opens the chooser window, ADR 0021 D); the architecture page
  still said otherwise. On a page that asks for a passkey by itself
  ([ADR 0034](adr/0034-answer-page-passkey-requests.md)), the tab that asks after a
  logout now keeps the page's request until the popup pick, whose login answers it with
  the picked item's passkey, as the owner chose on 2026-10-12 (17:56 UTC). Still to
  check in the owner's Chrome: a logout and a pick on Wise.
- A popup pick of an item with a passkey on a page that asks for one by itself. Evidence
  from the owner's Chrome on build `cdfa420` (2026-10-12, UTC): at 21:12:36 GitHub's
  sign-in page matched three items without a site default and asked in the popup
  (`account-ambiguous`); at 21:12:38 the page's conditional request was handed on
  (`no-login`); the pick at 21:16:51 started the login on the `password` route; after
  a reload at 21:17:15, the saved default's login took the `passkey` route and Pateat
  answered the page's request. As the owner chose at 22:04 UTC
  ([ADR 0034](adr/0034-answer-page-passkey-requests.md) rule 5, amended), on a recipe
  without a passkey button the request now waits while the popup offers its page a
  choice in which an item holds a discoverable passkey, and the pick's login answers it;
  it is handed on three seconds after the choice goes away, or as `no-pick` four minutes
  after it came. Implemented (local tests only). Next, in the owner's Chrome: on GitHub
  without a site default, a pick of an item with a passkey signs in with it
  (`passkey.request` `assertion`, `login.attempt` on the `passkey` route).
- Installed-Chrome checks still open in this phase (the others moved to
  [phase 2](#phase-2-use-it-and-fix-what-comes-up)):
  - Watching a login after a step left to the person
    ([ADR 0027](adr/0027-per-account-login-routes.md#watching-after-a-challenge),
    owner's choice 2026-10-12 13:08 UTC): on 三菱UFJ銀行, after the app approval of the
    QR page (`LG_0001_PC10`), the signed-in page completed the login as `authenticated`
    on build `206f2a0` (2026-10-12 19:59 UTC). The expired-QR half moved to phase 2.
  - Continuing a generated recipe on the page after an `advance` step (email, then
    Next, then password), which the owner rated high priority, on Grafana Cloud (see the
    table above).
  - The badge and popup choice on a site with two matches
    ([#187](https://github.com/risu729/pateat/pull/187)). On 2026-10-12 on github.com
    with three matches, the first popup open showed no choice and a reopen did; recheck
    after the fix that keeps asking and waits for a restarted worker's newer
    announcement. The recheck that day showed shortened item IDs before the usernames
    and a silent stop when another tab's login held the site; recheck both after the
    fix that waits for the usernames and names the hold.
  - The `totp` handler ([ADR 0027](adr/0027-per-account-login-routes.md) delivery 4) on
    Resend's code page: one input (`autocomplete="one-time-code"`, numeric, six
    characters), with the sentence naming the authenticator app outside the form, which
    the judge reads as text near the code field (owner's option A, 2026-10-12 22:04
    UTC). On 2026-10-13 (build fdf57ef) the sentence sat more than three parents above
    the field, so the judge request had no `nearCode` and the code was dropped as
    `source-unknown`; the search now reaches six parents (local tests only). ニコニコ's
    page sent the notes of its device-name field instead, which the search now stops
    before. On both pages nothing near the code field says where the code comes from,
    so the owner decided on 2026-10-13 (03:30 UTC card, 04:01 UTC go-ahead) that such a
    code is kept too: the item's TOTP is typed once, a wrong code ends the login with no
    second code, and a code the page says was sent to the person or comes from another
    source, such as a recovery code, still adds nothing
    (ADR 0027; local tests only). A judged code page adds the handler, and the same
    login fills the code and clicks once. It needs a paid judge call and the owner's
    own code entry or approval.
    A code split into one-digit inputs (owner decision, 2026-10-12 19:21 UTC) still
    needs a real site; Resend was first recorded as one, wrongly. ニコニコ's code page
    fits the split rule in its public code and waits for a real-Chrome check; the other
    split pages found draw their inputs without `maxlength`
    ([research](research/2026-10-12-split-totp-inputs.md)).
- Polish the UI, in phase 1 so that phase 2's feedback is on the improved UI (owner,
  2026-10-11 18:33 UTC): the extension and the service web UI in one pass with
  [stop-describing-ui](https://github.com/artouc/stop-describing-ui), as the owner
  planned on 2026-10-11, and the base design tokens set with Claude Design. It starts
  now, alongside the rechecks above rather than after them (owner, 2026-10-12 20:35
  UTC).
  - Done: the colors, type, radii and focus ring come from the
    [Pateat design system](https://claude.ai/artifact/WRXAnVi9RDw9cVWccy2fxJ) the owner
    approved (2026-10-12 20:53 UTC). Both stylesheets
    (`apps/extension/entrypoints/options/style.css`, shared by every extension page, and
    `services/api/web/styles.css`) define its tokens once as `light-dark()` color pairs
    in CSS custom properties and Tailwind colors (`bg-surface`, `text-ink-muted`,
    `border-border-strong`), the Worker's script-free pages copy them, and
    `tests/options/design-tokens.test.tsx` compares all three copies and their resolved
    palettes. The pages use no other colors. Page titles are 28px.
  - Done: light and dark themes with a Theme select (Browser setting, Light, Dark) in
    the extension's settings page and the `/manage` footer; Browser setting, the
    default, follows the browser's `prefers-color-scheme` (owner, 2026-10-12 20:54 UTC).
    The choice is presentation only, kept in each program's `localStorage`
    (`pateat.theme`), and an open extension page follows a change made on another.
  - Done: the extension's settings page has the approved layout: a section list with
    the Theme select at its foot, panels, icon-led status lines and no intro
    paragraphs. Each Bitwarden connection is a row with its vault, sync sign-in and
    automatic-unlock lines, one main action (Sync, or Sign in again when syncing needs
    a sign-in first) and the other actions in a menu. Adding a connection is a
    disclosure, open while there is none, and the paired sync service is a row with its
    last sync.
  - Done: the settings page's Sites list. An exclusion rule matches a hostname, or a
    hostname and its subdomains, on every scheme and port, and a default names one
    exact origin, so the list has two kinds of row, sorted together by hostname. An
    origin row edits its default account in a select that offers the accounts matching
    that origin and No default, saved only by its Save button, and its Exclude button
    adds a rule for that exact hostname, without a trailing dot. A rule row is marked
    Excluded and its Allow button removes it; a default its rule excludes is kept and
    shown as unused under the most specific such rule, since exclusion is checked first,
    and its Remove default button deletes only the default. A default that cannot be
    used shows the reason. One add form takes an origin (or a hostname, to exclude), a
    default account and Exclude subdomains too.
  - Done: vault access inside each Bitwarden connection. Its row holds the Use this
    vault switch, Items for Pateat and the collapsed lists of included groups and items
    and of excluded items and fields; the separate vault access panel is gone. Saved
    entries without a connection row (the demo vaults, a connection this device no
    longer has) are listed under the rows, and the demo preview lists its vaults in a
    Demo vaults panel.
  - Approved: `lucide-react` for icons in the polish (owner, 2026-10-12 20:53 UTC); the
    first PR that uses it adds it.
  - Done: the settings page marks Bitwarden (its section in the menu and each connection
    row) with the `lucide-react` `Shield` icon (owner, 2026-10-13 15:02 UTC). The owner
    asked for Bitwarden's own logo, but Bitwarden's
    [trademark guidelines](https://github.com/bitwarden/server/blob/main/TRADEMARK_GUIDELINES.md)
    allow its logos only with written permission; the name stays as plain text
    ([Extension icon](architecture.md#extension-icon)).
  - Done: the diagnostics page keeps its structure, with only its visuals and copy
    changed (owner, 2026-10-12 21:08 UTC): icon-led check lines, two-column panels,
    and in Logs the retention, debug logging's end time with **Turn off debug
    logging**, and the privacy warning as a notice above the download.
  - Approved: the structural proposal (owner, 2026-10-12 21:08 UTC): a "Sites" list in
    the extension's settings that merges excluded sites and default accounts with inline
    editing, vault access moved into each Bitwarden connection, a "Pateat on this site"
    switch in the popup header in place of the popup's Exclude button, and `/manage`
    reorganised into Sites and Devices tabs with a page per site. Diagnostics keeps its
    structure; only its visuals and copy change.
  - Done: the toolbar popup. Its header shows the toolbar icon's mark, the hostname, the
    "Pateat on this site" switch and an Open settings icon button (a `lucide-react`
    icon). Turning the switch off adds an exclusion rule for the exact
    hostname without subdomains, and turning it on removes that rule. Whenever a rule
    for a parent domain, or one that includes subdomains, covers the hostname, the
    switch is disabled, "Excluded by a rule for other sites too" names the reason, and
    each such rule has a "Change in settings" link; before, the popup could remove the
    site's own exact rule while a parent rule kept it excluded. Default accounts and the
    account choice are native radios shown as cards: the username as the title, the item
    and its vault below, and a Default badge on the saved default. Without a saved
    default no card is selected until one is picked. A failed or conflicting save leaves
    the switch in its saved position, and every result shows in the popup's live region.
    The popup is 360px wide. Checked with synthetic data only: the Vitest and Playwright
    Chromium tests run in the default (light) theme, and screenshots of each popup state
    were compared in light and dark.
  - Done: the popup shows one list. The owner asked for it on 2026-10-13 at 03:54 UTC:
    two lists were the problem, and the switch's spacing needed another look. While the
    page waits for an account choice, the Default account list is hidden, so each
    account is shown once: the choice's cards carry the Default badge, its checkbox
    makes the pick the default once that login succeeds, a saved default can still be
    removed, and one that is not among the choice's accounts is named. The "Pateat on
    this site" switch is a row of its own under the hostname, with its label on the left
    and the switch on the right, and the sections use one spacing scale.
  - Done: the passkey chooser window is restyled with the same behavior: "Sign in to"
    the site, each passkey as a choice led by its user name, the site default marked
    **Default**, a one-line note after a Pateat sign-in from the tab, and the save
    checkbox above the list.
  - Done: the `/manage` header shows the logo beside "Pateat" and the sections as tabs;
    Devices is a list with a Revoke button, a Revoked or Expired badge and the idle
    expiry and data notes as icon-led lines; the footer holds the version, Source,
    GPL-3.0-only, Third-party notices and the Theme select. Icons come from
    `lucide-react` in `services/api`.
  - Done: `/manage` has two tabs, Sites and Devices (owner, 2026-10-12 21:08 UTC). Sites
    merges the former sites, account bindings and recipes pages into one list of origins
    with badges for their recipes, default account and bindings, the excluded hostnames
    with Allow and an exclude form, and the revoked recipes. Each origin opens its own
    page with a "Pateat on this site" switch, its default account, recipes and bindings
    ([owner web UI](architecture.md#owner-web-ui)).
  - Done: the Worker's script-free pages (`/pair/signed-in`, the Access and error pages
    and `/manage/claude`) use the same tokens, light or dark as the browser prefers,
    with the logo beside "Pateat" and the page in one panel. With this, every screen of
    the extension and the service has had its polish pass.
  - Done: the toolbar badge spins (braille frames) in a tab while a model request for
    that tab's page is in flight, and shows how the tab's last login ended: a red `!`
    for a failure, a green `✓` or a yellow `!` for 4 seconds for a sign-in or an
    unknown result ([ADR 0038](adr/0038-login-status-badge.md), owner 2026-10-13 19:28
    UTC). It replaced the spinning toolbar icon chosen at 14:04 UTC.
  - Done: the popup's "This page" section from ADR 0038 says whether the site has a
    recipe for the page, what the AI last answered for the tab or why the page was not
    sent, and whether the tab's last login is running, signed in, or why it did not
    start or succeed, with a link to the diagnostics page. It is always shown; a setting
    to hide it comes later.
  - Confirmed in installed Chrome on main f5df675 (reloaded 2026-10-13 22:26 UTC): on
    Netflix, whose only item has neither a password nor a passkey, the badge showed a
    red `!` titled `no-route: password-empty:no-passkey` and the "This page" lines; on
    a site without a recipe the section went from "This site has no recipe yet." and
    "The AI is making a recipe…" to "The AI made a recipe…"; GitHub's badge worked;
    and "Open the detailed log" opened the diagnostics page.
  - Next: check in installed Chrome that Windows draws the braille frames (not boxes),
    and see the yellow `!` and the amber choice count once.
- Done: `https://my.jcb.co.jp/Login` was generated again after delivery 3. The recipe
  revision the Grok Bot computer's device generated on 2026-10-12 (13:45 UTC) names both
  routes: the password steps and the passkey button on `/Login`, read from D1 at 14:26
  UTC ([ADR 0027](adr/0027-per-account-login-routes.md)).

### Phase 2: use it and fix what comes up

- First, right after phase 1 (owner, 2026-10-12 21:29 UTC):
  [ADR 0035](adr/0035-page-kinds-per-site.md) delivery 1. Generation answers each
  page's kind, recipes generated as `confirm` neither run nor count as logouts, a
  passkey re-verification after Pateat's login in the tab is handed on, and the logs for
  judging whether `confirm` can be split are kept.
- The toolbar badge counts the matching items on every HTTP(S) site (on an `http:` page
  only items saved with an `http://` URI;
  [ADR 0050](adr/0050-http-pages-for-http-items.md)): teal with the usable count, light
  gray when every match is excluded, amber while a login waits for a choice (owner,
  2026-10-13 14:42 UTC;
  [ADR 0021](adr/0021-account-choice-outside-settings.md#site-count-badge)).
- The owner uses Pateat on many sites and reports bugs; Claude may also fix problems it
  finds on its own. Reading the extension's error logs without a report needs a way for
  them to leave the device, which [ADR 0019](adr/0019-local-diagnostics-and-logs.md)
  keeps local; that is a design to bring to the owner first.
- Moved from phase 1 (owner, 2026-10-12 20:35 UTC): the daily-use sites not tested
  yet, about 50 in the project's list. They are no longer tested in batches; the
  owner uses them, and Claude fixes what fails, from the owner's reports, the local log
  and the service's D1 records. The Japanese government sites and Santander, which the
  owner wants to work although they look hard, are among them. So is Instagram: its
  saved-profile list shows a handle while the item's username is an email, which
  [ADR 0028](adr/0028-account-chooser-login-pages.md) does not match, and what to do
  there is not decided.
- Installed-Chrome checks moved from phase 1 (owner, 2026-10-12 20:35 UTC), checked
  when daily use reaches them:
  - A plain HTTP site whose item is saved with an `http://` URI logs in, submit
    included, and an item saved only for `https://` is not offered there (owner,
    2026-10-18 01:41 UTC; [ADR 0050](adr/0050-http-pages-for-http-items.md); synthetic
    tests only).
  - On 三菱UFJ銀行, after an expired QR code, the sign-in page in the same tab is filled
    without pressing anything, while a new tab logs in as before (owner, 2026-10-13:
    「このタブだけ」; ADR 0027).
  - M3's password login on a real site, and M4's sync against the deployed service:
    `https://www.npmjs.com` logs in with no action from the owner through a recipe the
    service generated, and a later login makes no Claude call (after
    [#234](https://github.com/risu729/pateat/pull/234)).
  - Choosing again after a logout on the password side
    ([#210](https://github.com/risu729/pateat/pull/210)).
  - The passkey chooser staying open across a settings sync
    ([#232](https://github.com/risu729/pateat/pull/232)); see
    [passkey progress](#passkey-progress).
  - Changing a site's exclusion or default in the toolbar popup.
  - A vault item edit picked up by the automatic sync
    ([#222](https://github.com/risu729/pateat/pull/222),
    [#224](https://github.com/risu729/pateat/pull/224)).
  - Added on 2026-10-13, not moved by the owner: a security-key second factor behind a
    button labelled only "Verify", as on Oracle Cloud. Confirmed in the owner's Chrome
    on `8b60ff2` (2026-10-13 06:48 UTC), after the Oracle recipe was revoked: the judge
    named Verify from the text near the buttons (ADR 0027), Pateat pressed it and
    answered with the item's passkey, and nobody pressed anything on that page. The
    login then ended `left-origin` on the move to `cloud.oracle.com`; since
    [#484](https://github.com/risu729/pateat/pull/484) that move completes (the
    cross-site row of the phase 1 table).
  - The `totp` handler on a site whose code page names an authenticator app, such as
    npmjs.com: a judged code page adds the handler and the
    same login types one code. It needs a paid judge call and a real account's code, so
    it waits for the owner's approval.
- A login form whose fields only per-load IDs name, such as 外資就活ドットコム's
  (Mantine), was generated again on every visit (2026-10-13). Such fields are now
  located by their visible name ([ADR 0037](adr/0037-fields-by-visible-name.md), owner,
  2026-10-13 04:50 UTC; synthetic tests only). Check in the owner's Chrome that the
  second visit logs in with the saved recipe and no generation call.
- Sign-in pages whose path carries a tenant or authorization server ID were never sent
  (2026-10-16): UNSW's single sign-on at
  `login.microsoftonline.com/<tenant UUID>/oauth2/authorize` on build `747d237` (03:35
  UTC), and UniSuper's `member.id.unisuper.com.au/oauth2/<auth server ID>/v1/authorize`
  entry page on `d4faf03` (14:12 UTC), both logged `recipe.generate` `skipped`
  `unsupported-page`. Since 2026-10-16 every observed page sends such a segment as
  `[id]`, a recipe is stored and matched under that path, and a handler may be learned
  there ([ADR 0039](adr/0039-redacted-token-path-segments.md), owner, 14:10 UTC; local
  tests only; the synthetic browser test now also covers an opaque authorization-server
  ID in a middle path segment and verifies recipe reuse without another model call.
  Both cases passed in isolated cloud Chromium on 2026-10-17). Check both sites in the
  owner's Chrome.
- UNSW's single sign-on page on Microsoft Entra
  (`login.microsoftonline.com/<tenant>/oauth2/authorize`) was logged `recipe.generate`
  `skipped` `incomplete-observation` with `unfillable-field` in the owner's Chrome on
  build `d29951d` (2026-10-17, about 01:40 UTC). In cloud Chromium 141 the extractor,
  run every 20 ms from the page's start, found no candidates at 459 ms, an incomplete
  page with 3 candidates from about 1,120 to 1,315 ms, and a complete one with 9 from
  about 1,400 ms: the email field sat under a container whose opacity faded in from 0,
  so it counted as transparent. The page's hidden password input for the browser
  (`aria-hidden`) was already skipped. That the fade stayed at 0 through the runtime's
  three reads a second apart because the tab was not rendered, as in a background tab,
  is inferred, not shown. Since 2026-10-17 an element that is fading in counts as
  opaque ([AI evaluation harness progress](#ai-evaluation-harness-progress); agent fix,
  local tests only). Check the page in the owner's Chrome.
- The same page was logged `skipped` `incomplete-observation` with `unfillable-field`
  again in the owner's Chrome on build `97ccbb8` (2026-10-17, 04:11:34 UTC, about 3 s
  after the page started), while a later visit on that build (04:18 UTC) was sent about
  2 s after the page started and logged in end to end. A timed read there showed the
  form inside two fading layers: one whose fade had ended about 1.0 s after navigation,
  and an inner one held at opacity 0, with no animation, until its fade began at 1.0 to
  1.5 s, so the email field stayed transparent until about 1.5 s on a warm load. In a
  cloud Chromium probe the content script offered the page, since its offer check
  ignores opacity and counts the page's off-screen password input kept for the browser,
  while its description still reported `unfillable-field`, so on a slow load the three
  reads a second apart could all see the transparent form (inferred from the 04:11 log;
  not reproduced). Since 2026-10-17 such a page is read a second apart, at most ten
  times ([ADR 0016](adr/0016-recipe-generation-trigger.md); agent fix applying ADR 0016,
  local tests only; that ten reads cover the slow load is not shown). A known cost of
  the longer window: a form whose description stays incomplete while the person moves
  on to its next step on the same path may have that step sent as the first page.
  Making the offer check ignore inputs the description does not count as visible would
  remove the early offer itself; it changes when pages are offered and is not done.
  Check the UNSW sign-in page in the owner's Chrome.
- On that page in the owner's Chrome on build `64d105b` (2026-10-17, 05:53 UTC), a login
  with its generated recipe (revision 4: the email, Next, the password and Sign in, all
  on one path) clicked Next, the page swapped in its password view in the same document,
  and about 10 seconds later the login settled `unknown-submit` (`login.state` decision
  `unknown`, `recipe.judge` `not-sent` with `sign-in-shown`) without typing the
  password. The email view keeps a password input off-screen, transparent and hidden
  from assistive technology for the browser to fill (read in the owner's Chrome at
  04:14 UTC), which the content script's
  visibility check counted as a writable field just before Next, so the advance whose
  next step is on its own path was never confirmed
  ([architecture](architecture.md#declarative-recipes-and-ai)). That the recipe's
  password locator named that input on the email view is inferred from the log and the
  code, not read on the live page. Since 2026-10-17 such an advance's next fields and
  buttons count only when they are also visible as the page's description reads them,
  before and after the advance (agent fix applying ADR 0013; since 2026-10-18 a probe
  E2E spec on `/identifier-swap` drives that structure with synthetic values). Check
  the UNSW sign-in page in the owner's Chrome.
- A login control that is a link whose `javascript:` URL alone submits never submitted:
  on 2026-10-17 (build `d29951d`, 01:55 UTC) the owner's Chrome filled SMBC Trust Bank's
  sign-on page and clicked サインオン, and Chrome refused the URL under the content
  script's own `script-src` policy. Such a click is now made in the page's main world
  ([architecture](architecture.md#declarative-recipes-and-ai); agent implementation
  choice under the owner's 2026-10-11 decision that script links are clicked as buttons;
  local DOM tests, a standalone extension in Chromium 141 and the synthetic browser test
  in CI). Check that page in the owner's Chrome.
- SMBC Trust Bank's sign-in page in the owner's Chrome on build `d29951d` (2026-10-17,
  01:54 to 02:16 UTC): the submit click had no effect, so the login settled as unknown
  in the same document and was watched
  ([ADR 0027](adr/0027-per-account-login-routes.md#watching-after-a-challenge)). After
  each worker restart (01:57, 01:58, 02:00 UTC) that document announced again and was
  read again (`login.state` with `reshownMiss` `no-effect`, `recipe.judge` `not-sent`
  with `watched`), and the popup said "Logging in…". Since 2026-10-17 a restarted worker
  does not read the watch's own document again, and the popup shows such a login as
  watched (agent fix applying ADR 0027, local tests only). Check the page in the owner's
  Chrome after a worker restart.
- Known faults moved from phase 1 (owner, 2026-10-12 20:35 UTC), fixed when a real site
  shows them again: the `reconciling` exception seen on SBI証券, and `generate` ignoring
  a failed sync after generation (both recorded under phase 1).
- Proposed: the worker drops a waiting account choice once its site is excluded.
  `choiceFor` in `apps/extension/src/login/runtime.ts` drops one for a site default
  saved since the refusal, but not for an exclusion, so the worker still answers the
  popup with it and would take a pick; since
  [#683](https://github.com/risu729/pateat/pull/683) the popup shows none.
- Claude also watches the service's D1 records, such as the inference request log
  ([ADR 0012](adr/0012-inference-request-log.md)), not only logs the owner sends from
  the device (owner, 2026-10-11 18:45 UTC).
- Browser agents that drive the owner's Chrome, such as Claude in Chrome and ChatGPT's
  agent in Chrome, must be logged in by Pateat and carry on with their task. This is the
  M1/M6 "Chrome use coexistence" gate, and it can only be checked by using them.
- Agents with their own cloud computer, such as ChatGPT Dots and Grok Bot, often decline
  to log in even with the user's permission, and passwords must not be given to them.
  Pateat installed in that computer's browser could log them in without the agent
  seeing a password (owner, 2026-10-11 18:52 UTC). Whether an extension can be
  installed there, and how these agents handle logins today (such as handing control
  to the user to sign in by hand), is researched first:
  [browser agents and logins](research/2026-10-11-browser-agent-logins.md) found no
  documented install for the ChatGPT cloud browser. On Grok Bot's computer the owner
  loaded the unpacked build on 2026-10-12, and it stayed after the computer slept and
  after a computer update. Pairing there is refused by the service's WARP-only Access
  policy; [ADR 0030](adr/0030-pairing-without-warp.md) adds a "pateat pair" Access
  application without WARP for pairing only. With it, the Grok Bot computer paired on
  2026-10-12 and Pateat logged in to Vpass there with the owner's existing Bitwarden
  account, once the connection's policy was enabled by hand. The logins the Bot needs
  are listed below. Next: ChatGPT Dots once the owner has
  ChatGPT Pro again.
- Log in, in the Grok Bot computer's Chrome, on the sites the owner's Bot checks
  regularly, such as card statements and AI usage pages, so the Bot never needs a
  password (owner, 2026-10-12 14:00 UTC; a phase 1 goal until the owner moved it here
  on 2026-10-12 at 20:35 UTC). Sites that sign in only through another
  site's single sign-on, or only with a code or link sent by email (owner, 14:01 UTC),
  wait for [phase 4](#phase-4-issues-and-work-as-needed); Microsoft's own sign-in page
  is a target, but a site that signs in only through it is not yet. The list, like
  the daily-use list, stays in the project's files. Pateat has logged in to Vpass there,
  opened during a takeover after the connection was enabled by hand, and the Bot
  reported a MyJCB login (2026-10-12 13:45 UTC) that nobody else checked. On
  2026-10-12 (19:08 UTC) the Bot itself opened ten of those sites on a build of
  a8350f5, and the diagnostics log showed logins to Vpass, MyJCB and Give. On JP
  BANKカードWEB the submit press left the sign-in form in place, and later attempts only
  filled the form. Google, Microsoft and OpenAI Platform stopped with
  `account-ambiguous`; the owner picks those accounts by hand on that computer for now
  (owner, 19:22 UTC). Cursor stopped at a human check and an email code. Sites that
  failed on the Grok Bot computer were to be checked in the owner's installed Chrome
  before other sites (owner, 19:23 UTC); since the move, only Google is (see the
  phase 1 table). JP BANKカードWEB signed in there within 20 seconds
  with the same recipe (19:24 UTC), so why its press failed on the Grok Bot computer
  is still open. On the Bot's later round (19:51 UTC), Microsoft's page after Next was
  sent to continue the recipe with only its email form described, and the model
  abstained; a password input hidden there for the browser to fill counting as the
  password page is the inferred cause. Such an input no longer counts, and a
  description without the input the page qualified with is read again
  ([ADR 0018](adr/0018-recipe-generation-route.md#continuing-after-an-advance)). On the
  Bot's eighth round (build `25b08b2`, 2026-10-12 23:13 UTC), OpenAI Platform was
  refused `no-route` `password-empty`: its item holds no password, only a TOTP secret
  and a passkey. [ADR 0036](adr/0036-passkey-after-the-identifier.md) lets such an item
  go on after the email to a passkey. Build `85085b7` still refused it the same way: the
  stored recipe ends at Continue, its page after the email never generated, so no step
  fills the password. Such a route now stops just past its final `advance`; by the
  owner's decision of 2026-10-13 04:42 UTC its page after the email is continued as any
  login's, or judged to learn a passkey button, and the login stops at the continued
  password step. A refusal names why after the colon (local tests only); not yet
  checked on the Bot. By the owner's decision of 2026-10-13 05:39 UTC, at that stop a
  "sign in with a passkey" button beside the password field is pressed: a learned
  `passkey` handler is entered, or the page is judged once to learn one, and its request
  is answered with the item (local tests only). On 2026-10-13 06:29 UTC the owner's
  Chrome showed `platform.openai.com/login` as a list of accounts (ADR 0028), refused
  `password-empty:chooser`; by the owner's decision of 06:32 UTC such a login now
  presses the account's row (or `other`) and stops at, or continues to, the branch's
  password step
  ([account lists](adr/0036-passkey-after-the-identifier.md#account-lists)). In that
  Chrome on `4deb95d` (08:51 UTC) the
  row's click moved the tab to `auth.openai.com`, which asked for a passkey; Pateat
  answered it and the tab came back signed in, but the login had ended `left-origin`.
  By the owner's 「完了扱い」 (13:54 UTC), a passkey answered on such a page with the
  login's item now lets the next quiet page complete the login
  ([ADR 0022](adr/0022-login-attempts-per-tab-and-origin.md)). Done in that Chrome on
  `957a53d` (15:08 UTC): after the row's click, `auth.openai.com` held the login
  (`login.move` `passkey-request` `kept`), Pateat answered its passkey, and the login
  ended `authenticated` with the account choice saved.
- Answer Google's passkey step on the Grok Bot's browser. On build `a8350f5`
  (2026-10-12 19:49 UTC) both of the page's requests were logged as `passkey.request`
  `delegate` `invalid-request`, so the browser offered only the phone (hybrid) flow,
  which failed. The log now names the member and its size (`invalid`, `invalidLength`),
  and on build `f2c68aa` (20:37 UTC) it named a 2,056-byte `challenge`, over the
  1,024-byte bound of [ADR 0007](adr/0007-existing-passkey-assertions.md#admission).
  The bound is now 4,096 bytes (local tests only). Next, the Bot signs in to Google
  Play subscriptions again.
- Debugging on the Grok Bot computer goes through the Bot today. A shell or SSH
  session for members, and a public API for messaging a Bot, are not documented;
  users report SSH over Tailscale anyway. A routine started by a webhook call, by
  email to the Bot's address, or on a schedule that reads a Notion page can take
  requests from Claude without the owner pasting them
  ([Grok Bot remote access](research/2026-10-12-grok-bot-remote-access.md)). Which
  one to use waits for the owner. A read-only probe run there on 2026-10-12 found the
  browser-tool guards in the computer's own `sand-host` process, Chrome 154 from
  Google's package with memory saver at its most aggressive, and the `a8350f5` build
  loaded. The owner wants the computer's own code read later (2026-10-12), not now.
- A way for an agent such as the Grok Bot to choose the account in Pateat's account
  chooser itself, such as a tool the agent can call, so the owner need not take over
  the agent's computer for it (owner, 2026-10-12 19:22 UTC). Low priority; until then
  the owner chooses by hand.
- Prune low-value tests with OpenClaw's `test-audit` agent skill, during this phase
  (owner, 2026-10-12 20:35 UTC; earlier planned alongside the UI polish once the
  daily-use sites were done, owner 07:43 UTC; the
  [survey](research/2026-10-12-test-pruning-skills.md) compares the alternatives). The
  skill is copied into the repository with its OpenClaw-specific validation replaced by
  `mise run check`. The owner asked for care not to remove needed tests: every deletion
  names the test that still covers its contract, and an independent subagent compares
  the deleted tests with the kept ones before each batch merges, as the skill's
  preservation review does. The suite's size and CI times in the survey are a 2026-10-12
  snapshot; re-measure them when the work starts and after each batch.
  - Batch 1, `packages/bitwarden` (started 2026-10-12): read-only reviewers marked
    every declaration keep, fix, merge or delete, naming the remaining proof for each
    removal; 943 to 920 Vitest cases, package line coverage unchanged at 96.0%. Copying
    the skill files into the repository was refused by the cloud session's approval
    policy, so the batches follow the survey's summary of its rules until the owner
    decides how the copy lands.
  - Batch 2, `services/api` (2026-10-12): 308 to 293 Vitest cases, service line
    coverage unchanged at 95.6%. The preservation review's mutations found two
    removals that were the only proof of a judgement rule, and both were kept.
  - Batch 3, `packages/inference` (2026-10-12): 336 to 323 Vitest cases, package
    line coverage unchanged at 99.1%.
  - Batch 4, `packages/contracts` (2026-10-12): 368 to 350 Vitest cases, the same
    branches covered; the extension ID constant is now covered only by the extension's
    manifest key test, and two exports only tests called were removed. The
    browser suites in `tests/options` and `tests/manage` wait until the UI changes in
    progress land.
  - Batch 5, `apps/extension` connections, vault and crypto (2026-10-12): 442 to 430
    Vitest cases, the same statements and branches covered. Files other threads are
    changing (login runtime, passkeys, observation, diagnostics, popup) wait.
  - Batch 6, `apps/extension/src/service` (2026-10-12): 311 to 295 Vitest cases, the
    same statements and branches covered.
  - Batch 7, the extension's page, diagnostics and username browser suites, apart
    from the diagnostics log (2026-10-12): 305 to 300 Vitest cases, the same
    statements and branches covered except one wrapper only tests called, removed.
    Six tests that passed without reaching the rule they named were repaired, and the
    account list's entry choice is now checked on an entry that is not the first.
  - Batch 8, the server's management pages and the extension's smaller login suites
    (2026-10-12): 42 to 41 Vitest cases, the login lane still 873 with one test
    replaced by a row the review asked for. Nearly every test there is the only unit
    proof of its rule; a URL helper only tests called was removed.
  - Batch 9, the extension's passkey lane, its vault suite unchanged (2026-10-13): 412
    to 400 Vitest cases, the same statements and branches covered. Seven tests that
    passed without reaching the rule they named were repaired.
  - Batch 10, five of the packaged-extension Playwright specs (2026-10-13): 59 to 53
    tests. Removed cases repeated another test's path or checked only Chromium's own
    IndexedDB or a pure size limit that unit tests cover; the crypto probe lost its
    cancellation page. Three checks were folded into the tests that kept their path.
    The login spec (2026-10-13) went from 68 to 66 tests, and two tests whose negative
    passed before Pateat acted now wait for it.
  - Batch 11, the extension's passkey vault suite (2026-10-13): one test folded into the
    table that checks the same guard, and a repeated row replaced by one that fails when
    a site default in an unsearched connection is reported as searched.
  - Batch 12, the options and popup pages (2026-10-13): 104 to 102 browser cases. Two
    tests that the packaged-extension specs repeat through the real background were
    deleted and one folded; six that missed the rule they named were repaired.
  - Batch 13, the observation extractor and the local log (2026-10-13): 118 to 112
    browser cases. Removed tests repeated a kept one or checked IndexedDB upgrades from
    a version Pateat never shipped; two tests whose negatives passed without their rule
    were repaired.
  - Batch 14, the remaining shared checks (2026-10-13): three tests that passed
    without their rule now check it (an address on another port, the judge's origin
    key, a renamed path test), and one login-generation row repeated by the ADR 0031
    identifier-page case was removed.
  - Batch 15, the login runtime suite (2026-10-13): 737 to 720 Vitest cases. Removed
    cases repeated a kept test's setup, branch and assertions; nine tests that passed
    before reaching their rule were repaired.
  - Done (2026-10-13): every test file was audited in the fifteen batches above. On
    the last batch's PR, [#450](https://github.com/risu729/pateat/pull/450), the CI
    workflow took 8 min 2 s, `Verify` 7 min 55 s and the six Linux end-to-end shards
    1 min 30 s to 3 min 54 s; the suite has grown with features since the survey's
    snapshot. Of the production code the audit found that only tests or older storage
    reach, the retired login attempt-store removal and the diagnostics database's
    version 1 upgrade guards were removed (no compatibility before release): an old
    `pateat.login-attempts.v3` entry stays in storage unread, and a version 1
    diagnostics database fails to open until the extension is reinstalled, as the
    vault database already does. The `!moved &&` exemption in the service's judgement
    gate was removed too: a page of another origin is judged only on the `password`
    route, whose sign-in targets are its fill targets, which the gate already checks on
    every origin. The settings page's Demo vaults preview, shown only without a
    connection client, stays: the options page tests render the page that way.
- UI improvements the owner reports from daily use of the UI polished in phase 1. Small
  fixes for broken UI still land as found.
- Features found missing during use are added here.
- If field or button mapping gets worse on real pages, consider observing more of the
  text around a control, which the extractor leaves out today
  ([AI evaluation harness progress](#ai-evaluation-harness-progress)); not before
  (owner, 2026-10-12 05:57 UTC).

### Phase 3: public release

Once the fixes have settled:

- Early in this phase (owner, 2026-10-13 19:10 UTC; not needed before then): repair a
  recipe whose elements no longer match its page. Today nothing regenerates such a
  recipe: generation runs only on a path where no cached recipe starts
  ([ADR 0016](adr/0016-recipe-generation-trigger.md)), and
  [ADR 0018](adr/0018-recipe-generation-route.md) leaves repair to a later design, so a
  stale recipe fails the same way on every visit until it is revoked on `/manage`. A
  start page whose first step's elements are not found only logs `login.refused`
  `not-started` with `first-step-missing` and never starts the login; a later step's
  elements that do not show end the attempt `retry-limit` after three 10-second waits
  (`elements-timeout`); a page after a submission whose next step does not show goes to
  the [ADR 0029](adr/0029-local-sign-in-state.md) check and the judge, and settles as
  `unknown-submit` while a sign-in field of the route still shows. The bounded repair
  request on structural mismatch that the
  [architecture](architecture.md#declarative-recipes-and-ai) describes needs a design
  the owner approves first: when a miss counts as a stale recipe rather than a slow or
  different page, its inference budget, and what happens to the stale revision. Cases
  the design must cover (owner, 2026-10-13 19:14 UTC): the same page in another
  language, where a text or label locator no longer matches though the recipe is still
  right, and a maintenance page that replaces the login page on the same URL without a
  redirect, which must not be taken as a changed login page.
- First among the text work, a review of the wording of Pateat's UI text: the popup, the
  toolbar icon's title, the options page and the in-page prompts. It includes the reason
  line the popup and the icon's title show when another tab of the site logged out or
  the site did not accept that tab's login: both say "You logged out of this site in
  another tab" (`choiceReason` in `apps/extension/src/login/choice-wire.ts`, the
  `other-tab` title in `apps/extension/src/login/runtime.ts`), which reads wrong after a
  rejection. The review comes before the Japanese text below, so that the English text
  is settled before it is translated (owner, 2026-10-13 15:17 UTC). Not started without
  the owner's confirmation (owner, 2026-10-13 15:10 UTC).
- Before publishing, turn off or remove `DEBUG_STAYS_ON` in
  `apps/extension/src/diagnostics/log.ts`, which keeps debug logging on until it is
  turned off, or keep it only behind a feature flag (owner, 2026-10-18 01:50 UTC;
  whatever replaces it must still read the stored `DEBUG_UNTIL_TURNED_OFF` deadline as
  off, or reset it, so a published build never inherits debug logging left on;
  [ADR 0019](adr/0019-local-diagnostics-and-logs.md#amendment-debug-logging-stays-on-before-publishing)).
- Next, before the rest of the work below that makes Pateat public: Japanese alongside
  English for Pateat itself (owner, 2026-10-12 13:59 UTC): the README, the docs and the
  extension's UI text. The service's pages, such as `/manage`, come later. The owner
  chose i18next with react-i18next (2026-10-12 14:31 UTC), so that the language can be
  chosen in Pateat's settings
  ([comparison](research/2026-10-12-extension-ui-translation.md),
  [dependency policy](development.md#dependency-policy)); where that setting is stored
  is not decided yet. The owner chose (2026-10-12 14:14 UTC) that "the docs" means the
  README and the user-facing pages, including those the docs website below adds; ADRs,
  this plan and research notes stay in English. AGENTS.md's English rule gets an
  exception for the Japanese pages when they land.
- The docs website (VitePress 2, see
  [decisions still requiring evidence](#decisions-still-requiring-evidence)) with
  user-facing pages for installation, setup and permissions, plus the M6 operational
  docs. The [operations runbook](operations.md) now documents current retry/revert
  procedures and the unverified D1 restore and rollback-automation boundaries; this
  does not complete installed-Chrome or disaster-recovery acceptance.
- A mode without the service. Where recipes, settings and AI calls come from without the
  service, which [ADR 0013](adr/0013-service-held-recipes-and-settings.md) makes their
  source of truth, needs a design the owner approves before implementation.
- The finite-choice role with Clef, which the owner chose to implement here. On
  2026-10-11 the owner asked for a larger corpus of real pages before planning it. After
  Clef has been tried, compare it with Jev on the same pages (owner, 2026-10-13 15:11
  UTC). Include Chrome's built-in Prompt API (`LanguageModel`, an on-device model) in
  that comparison (owner, 2026-10-13 21:36 UTC).
- Split `apps/extension/src/login/runtime.ts` (9,998 lines; `createLoginRuntime` spans
  lines 1573-9998) after [#545](https://github.com/risu729/pateat/issues/545) moves the
  undecided-page completion rule out, keeping the existing state transitions: the types
  and reports (lines 1-1572), then storing and resuming attempts (`save`, `keep`,
  `forget`, `change`), `remember` and the account choice, sign-in entry pages, page
  passkey requests, the stop before a password, recipe generation, and last `admit` and
  `runSteps`. `runtime.production.test.ts` is split along its eight top-level `describe`
  blocks once its 38 shared helpers have their own module
  ([external review](research/2026-10-13-external-review.md)).
- Before Pateat is public: settings for the two protections Pateat does not honour
  today (owner, 2026-10-13 21:57 UTC). Passkey user presence and user verification:
  Pateat sets UP and UV on every assertion it claims without a gesture or a check
  ([ADR 0007](adr/0007-existing-passkey-assertions.md#presence-and-verification)); a
  setting over the existing `PasskeyPolicy`, which ADR 0007 plans per site. Bitwarden's
  master password re-prompt: Pateat fills items marked with it and signs with their
  passkeys without asking for the master password
  ([vault adapter](architecture.md#vault-adapter)); a setting to honour it. Until then
  both stay as they are, and the README says so.
- Anyone can use Pateat. The service is not opened to other people. Continuous delivery
  publishes each extension release on GitHub Releases and meets the
  [Corresponding Source](sdk-source.md) requirements. The owner has a Chrome Web Store
  developer account and will also publish there if the store's policies allow it
  (2026-10-11). The owner accepted on 2026-10-11 (18:36 UTC) that a store item gets a
  store-assigned extension ID, so devices pair again, and that the store requires a
  privacy policy and a Limited Use statement. Risk: the
  [MV3 code rules](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
  forbid "building an interpreter to run complex commands fetched from a remote source,
  even if those commands are fetched as data". A reviewer may count service-held recipes
  (`fill`, `click` and handler steps) as such commands and reject the item; then
  GitHub Releases stays the only channel. The
  [research note](research/2026-10-17-chrome-web-store-remote-code.md) (2026-10-17)
  finds the risk real but undecidable from the documentation: recipes have no control
  flow and are the user's own synced data, which the policy allows, but AdGuard reports
  rejections that cited scriptlets and their parameters. Proposed, not decided by the
  owner: keep the recipe vocabulary closed (no control flow, expressions, selectors,
  URLs beyond exact same-origin paths, or values), explain recipes, their schema and
  how to test them in the submission, have the owner submit a Private trusted-tester
  item early to get a review verdict, and consider an unminified store build. A mode
  without the service that gets recipes from a model API directly reopens the question.
- Proposed: the checks that matter once other people install Pateat: the install-time
  site-access warning and the prompt after site access was withheld, installed-Chrome
  dummy-account tests and measured limits.
- Adopting Anthropic's
  [Claude Security plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/claude-security)
  for Claude Code: agents map the architecture, build a threat model, look for
  vulnerabilities in the whole repository or in a branch, pull request or commit, try to
  disprove each finding, and write the surviving ones as a Markdown, JSONL and SARIF
  report, with optional patch files that are never applied, committed or pushed on their
  own. Each scan writes them to a `CLAUDE-SECURITY-<timestamp>/` directory in the
  repository. Which scans run and when is decided when it is adopted. Not started
  without the owner's confirmation (owner, 2026-10-13 15:10 UTC).
  - Started (owner, 2026-10-15 11:09 UTC): the owner added the plugin to their claude.ai
    account from the plugin directory, which loads it into this project's cloud threads.
    A repository `.claude/settings.json` does not, because cloud sessions do not install
    the plugins a repository enables
    ([cloud environments](https://code.claude.com/docs/en/cloud-environments)). The
    plugin's license forbids distributing it, so it is not copied into the repository.
  - First scan (2026-10-16, owner's go-ahead 13:24 UTC): the whole repository on main
    [8883745](https://github.com/risu729/pateat/commit/8883745)
    at `medium` effort, verification status `verified`. Six findings survived the
    panel, four distinct problems, each filed as an issue at the owner's request; none
    is fixed without the owner's word (owner, 13:25 UTC):
    [#636](https://github.com/risu729/pateat/issues/636) form destination not checked
    before filling and submitting (medium),
    [#637](https://github.com/risu729/pateat/issues/637) sandboxed documents treated as
    their URL's origin (medium),
    [#638](https://github.com/risu729/pateat/issues/638) passkey assertions signed with
    UP and UV and no gesture, the [ADR 0007](adr/0007-existing-passkey-assertions.md)
    deviation (medium), and [#639](https://github.com/risu729/pateat/issues/639) a
    quadratic padding regex in the Bitwarden passkey decoder (low). Which scans run
    later, and when, is still open.
  - The owner's triage (2026-10-16 19:14 UTC):
    [#638](https://github.com/risu729/pateat/issues/638) is by design (ADR 0007) and was
    closed without a change; fix [#636](https://github.com/risu729/pateat/issues/636)
    and [#637](https://github.com/risu729/pateat/issues/637) first, then
    [#639](https://github.com/risu729/pateat/issues/639) if Bitwarden's own
    extension shows a simple way to avoid it. The scan's report is committed as
    [2026-10-16-claude-security](research/2026-10-16-claude-security/CLAUDE-SECURITY-RESULTS.md),
    reformatted for the repository's Markdown and JSON checks.
  - [#637](https://github.com/risu729/pateat/issues/637) fixed at the owner's request
    (2026-10-16 19:14 UTC): a document whose browser-reported origin is not its URL's,
    such as a page served with a CSP `sandbox` header or a sandboxed frame, is refused
    for logins, recipe generation and passkeys
    ([architecture](architecture.md#components-and-trust-boundaries)).
  - [#639](https://github.com/risu729/pateat/issues/639) fixed by
    [#644](https://github.com/risu729/pateat/pull/644): the passkey decoder strips at
    most two trailing `=` without a regex, as Bitwarden's clients avoid a backtracking
    pattern, and accepts the same inputs as before.

### Phase 4: issues and work as needed

At the start of this phase, every task still open in this plan and in the ADRs becomes a
GitHub issue: later work, deferred and not-handled items, open checks and proposals, not
only the items listed below. Each is then built when it is needed. Issues get their own
priority and area labels, and GitHub's default labels may be removed. No issues are
created before this phase, except where the owner asks for them: the findings of the
[external review](research/2026-10-13-external-review.md) became issues
[#541](https://github.com/risu729/pateat/issues/541) to
[#547](https://github.com/risu729/pateat/issues/547) so that they can be handled
separately (owner, 2026-10-14 07:24 UTC), and the adopted
[platform features](research/2026-10-14-platform-feature-candidates.md) became issues
[#553](https://github.com/risu729/pateat/issues/553) and
[#555](https://github.com/risu729/pateat/issues/555) to
[#563](https://github.com/risu729/pateat/issues/563), one per feature, each of which can
be started from the issue alone (owner, 2026-10-14 08:40 UTC). The list below names
items the owner mentioned and gates still open on 2026-10-11.

- From the [external review](research/2026-10-13-external-review.md): decrypted item
  copies in the crypto Worker that hold only the fields a request needs instead of the
  whole item; a scheduled purge of the inference log, reconsidered once
  [ADR 0035](adr/0035-page-kinds-per-site.md) changes which rows the purge keeps (a
  trigger is a deployment change the owner approves); and syncing which recipes exist
  and which are revoked separately from their bodies, if
  [#544](https://github.com/risu729/pateat/issues/544) and the recipe limits are not
  enough.
- Signing in through an identity provider
  ([ADR 0026](adr/0026-sign-in-through-identity-providers.md), ADR 0027 delivery 5).
- [ADR 0027](adr/0027-per-account-login-routes.md) delivery 4's deferred part: a `totp`
  handler that reads a custom field a saved binding names for the code, once Pateat can
  make a code from one. Until then such a binding ends `challenge`. The owner moved it
  from phase 1 on 2026-10-12 (14:26 UTC).
- Signing in with a code or link sent by email, which
  [ADR 0027](adr/0027-per-account-login-routes.md) does not handle today (such a code
  page ends `challenge`). It has the same priority as signing in through an identity
  provider (owner, 2026-10-12 14:01 UTC).
  Sites that create an account for every visitor, as ABEMA does when it is first opened,
  sign in by switching that account to the person's own. Pateat neither decides that
  the current account is such a visitor account nor switches it on its own (owner,
  2026-10-12 19:18 UTC): a general page looks the same for both accounts, and a switch
  gives up the current account's plan and purchases, which may belong to another
  person. The account switch the person starts from the popup, kept for later in
  [ADR 0021](adr/0021-account-choice-outside-settings.md#later), switches such an
  account too, even where Pateat has not logged in (owner, 19:19 UTC). A sign-in form
  that a click opens on the same path stays unsent
  ([ADR 0031](adr/0031-sign-in-entry-pages.md#not-covered)); it is proposed on its own,
  with evidence from a site that signs in with a password, when one needs it.
- Opening the service to other people, once there are users who need it; per-owner byte
  quotas come with it.
- Settings to limit Pateat as an extension that handles personal data: only allowed
  sites (an allowlist), and a choice of how long the vault stays unlocked, as the
  official Bitwarden extension offers.
- Possibly later (owner, 2026-10-14 06:44 UTC): answering Chrome's Immediate UI
  requests (`navigator.credentials.get` with `uiMode: "immediate"`, made when the
  person presses a site's sign-in button) instead of delegating them as
  [ADR 0007](adr/0007-existing-passkey-assertions.md) does today. With a stored
  passkey, Pateat would answer as it answers a modal request; answering `password: true`
  would hand the page a `PasswordCredential`, which needs a design of its own. The
  [login standards](research/2026-10-13-login-standards.md) note records how the
  official Bitwarden extension treats these requests.
- Bitwarden writes (with their own permission), so that the official Bitwarden
  extension can be uninstalled; vaults other than Bitwarden.
- Low priority (owner, 2026-10-11 18:29 UTC): pages that add another account while one
  is signed in, such as Google's AddSession or Microsoft's "Use another account", show
  a login form and are logged in with the default account today. They should not be.
- Personal details asked for during a login, filled from another Bitwarden item linked
  to the login. エポスNet asks for the card's security code after the password (owner,
  2026-10-12 04:18 UTC: it can wait), and other sites ask for a birth date or similar
  details as extra verification. The owner sees these as one need (2026-10-12 05:29
  UTC): the value is in a card or identity item, not in the login item, so the login has
  to be linked to that item. The owner chose how to link them (05:27 UTC): Pateat
  guesses the item from the site being logged into and what its pages show (such as a
  card name, brand or masked last digits), proposes it, and records the choice for the
  site once the owner confirms it.
  - The [feasibility note](research/2026-10-12-card-security-code.md) found that the
    Worker already decrypts card and identity items. Filling one of their fields needs
    a handler for the page that fills a field the binding names (ADR 0027's deferred
    `totp` binding field needs the same naming, but makes a code instead of filling a
    raw value), and a binding that can name a second item.
  - The linked item is stored like an account binding
    ([ADR 0013](adr/0013-service-held-recipes-and-settings.md#recipes-and-account-bindings)):
    in the owner's settings on the service, by provider, server, user ID and item ID,
    with custom fields by name, and never in a shared recipe.
  - Each kind of value gets its own fill rule, as passwords and TOTP codes have, rather
    than an exception to those: a card code only into a password or short numeric
    input, as Hidden fields are filled today. Bitwarden identities have no birth date,
    so it would sit in a custom field of the identity item, and forms often split it
    across year, month and day selects, as with the Japanese forms in the
    [personal-data note](research/2026-10-11-personal-data-autofill.md#japanese-forms).
  - This is the login-time part of personal-data autofill (see
    [Research](#research)): it fills only a page of a login, not a sign-up or checkout.
  - Which part of the guess runs locally, and whether the AI may see the names of card
    or identity items, is left to the design; their values never leave the device.
- Entering a value on a page's software keyboard (owner, 2026-10-17 03:35 UTC): a
  login whose field takes characters only from buttons the page draws, such as an input
  that is `readonly` and opens a keypad on focus. Pateat leaves such a page to the
  person today, as the [phase 1](#phase-1-usable) row for these pages (エポスNet)
  records: its fill writes only into inputs that are not `readonly`, and its events are
  not trusted (`isTrusted` is false), which some keypads check
  ([architecture](architecture.md#background-execution)). A page that only offers a
  software keyboard beside an ordinary input, as SMBC Direct does with its software
  keyboard button, is typed into as usual. The design is still to come: how a recipe
  names a keypad's keys, keys that change position or show their character only as an
  image, and keeping the value's characters out of what reaches the service and the AI.
  A PIN or card code asked in an ordinary input is the item above.
- Optional confirmation pages after a login, such as
  GitHub's "Verify your two-factor authentication (2FA) settings": Pateat should
  complete them itself (owner, 2026-10-12 04:08 UTC), as a general rule rather than for
  one site ([ADR 0033](adr/0033-no-site-specific-features.md), owner 13:46 UTC). Until
  then, [ADR 0029](adr/0029-local-sign-in-state.md) treats the login as complete there
  and leaves the page to the person.
- Re-verification asked while already signed in, such as a secret question before
  profile settings open (ポイントインカム's `/my/my_profile_change.php`, seen on
  2026-10-12) or a password asked again before a sensitive change: Pateat should answer
  them too (owner, 2026-10-12 15:52 UTC). Pateat has no rule for these prompts today,
  but it reacts to some of them as it does to a login (read from the code and ADRs on
  2026-10-12, not yet seen on a real site):
  - A passkey request that names its credentials is signed without asking when one
    stored passkey matches or the site has a default, also while signed in
    ([ADR 0021](adr/0021-account-choice-outside-settings.md)).
  - Pateat logs in on a form that matches a recipe's first step in a tab without a
    login attempt record of the origin. After this tab's login of the origin, or while
    another tab of the site asks after a logout, the form is taken as a logout: with
    one account to use, Pateat fills it without submitting, then asks. ADR 0021 lists
    this as a known gap.
  - On a site with a matching vault item, a password input on a path without a recipe,
    in a tab without a login attempt record of the origin
    ([ADR 0022](adr/0022-login-attempts-per-tab-and-origin.md)), is sent for recipe
    generation like a login page ([ADR 0016](adr/0016-recipe-generation-trigger.md)),
    and the returned recipe runs at once
    ([ADR 0018](adr/0018-recipe-generation-route.md)).
  - [ADR 0035](adr/0035-page-kinds-per-site.md) (owner, 2026-10-12 21:30 UTC) gives
    these pages the kind `confirm`, which Pateat only fills, never presses, and which
    each profile sets per site to `fill` or `off`, next to `sign-in` (`auto` or `fill`,
    so Pateat can be used as autofill only) and `personal-details`. Its delivery 1 is in
    [phase 2](#phase-2-use-it-and-fix-what-comes-up); deliveries 2 to 4 (the settings
    and fill-only `sign-in`, filling `confirm` pages, personal details) are here.
- The items under [later work](#initial-delivery-and-later-scope) and the ADRs' later
  sections, including synced vault policy
  ([ADR 0023](adr/0023-synced-vault-policy.md)), more settings profiles
  ([ADR 0024](adr/0024-settings-profiles.md)), the ADR 0025 later work, the ADR 0027
  cases it does not handle, and generation for passkey-only start pages.
- Real-account checks of individual Bitwarden two-step methods, other KDFs, V2 keys and
  organization items. The owner moved them after the public release on 2026-10-11
  (18:35 UTC), since few users are expected to need them; each needs the owner's
  approval for real-account use.
- Proposed: the remaining checks, namely pairing while signed out of Access and the
  Access cookie settings, real sites that wrap `get`, and a navigation during signing.
  The packaged synthetic browser suite also covers a page-owned `get` wrapper that
  clones request options: Pateat answers an eligible request once, native fallback
  remains reachable, and caller cancellation survives the copied options. This added
  coverage passed in isolated cloud Chromium on 2026-10-17; it does not close the
  real-site wrapper gate.

### Research

- Personal data autofill beyond logins: names, addresses, email addresses and password
  generation. The owner asked on 2026-10-11 to research its scope and the existing
  extensions; the [research note](research/2026-10-11-personal-data-autofill.md)
  recommends keeping it out of the current work, with password generation coming with
  Bitwarden writes. The owner sees Japanese forms as a good fit for Pateat rather than
  Bitwarden or Chrome: furigana fields and addresses split across several inputs
  (2026-10-11 18:55 UTC). The note's
  [Japanese forms](research/2026-10-11-personal-data-autofill.md#japanese-forms)
  follow-up supports that: the official Bitwarden extension's heuristics match no
  Japanese label and it fills split inputs with whole values, Chrome fills readings but
  has no Japanese address model, and no widely used extension covers them. It recommends
  Japanese forms as the first candidate if identity filling is designed later (not
  decided).
- CAPTCHA solving is out of scope because it is heavy (owner, 2026-10-12 05:35 UTC). A
  login page that shows a CAPTCHA is filled and its button left to the person (owner,
  2026-10-12 20:23 UTC, [ADR 0029](adr/0029-local-sign-in-state.md)). The
  [survey](research/2026-10-12-captcha-solving-landscape.md) records the existing
  approaches (paid solver services, audio speech-to-text, object detection, LLM agents,
  and ways to avoid the challenge such as Private Access Tokens) and their reported
  success rates.
- Cloudflare Clef for the finite-choice role, chosen for
  [phase 3](#phase-3-public-release) but not planned until the corpus of real pages
  grows (owner, 2026-10-11 17:48 UTC): the
  [research note](research/2026-10-11-clef-finite-choice.md) covers its API, where it
  would fit in recipe generation, cost, and the open questions (Japanese, calibration,
  who pays, abstention handover).
- An agent skill for pruning the low-value tests agents write (owner, 2026-10-12 07:32
  UTC): the [survey](research/2026-10-12-test-pruning-skills.md) compares six skills;
  the owner chose OpenClaw's `test-audit` (07:43 UTC), planned in
  [phase 2](#phase-2-use-it-and-fix-what-comes-up).
- Moving from Bun to aube for monorepo support (owner, 2026-10-12 07:58 UTC): the
  [research note](research/2026-10-12-package-manager-aube.md) compares Bun 1.4.3, pnpm
  12 and aube 2.7.0 and records trial installs. The owner chose aube (08:25 UTC);
  [ADR 0032](adr/0032-aube-package-manager.md) records the migration. The
  [lockfile gaps note](research/2026-10-12-aube-lockfile-gaps.md) reproduces aube
  2.7.0's `bun.lock` and `pnpm-lock.yaml` bugs (both fixed on aube main, unreleased) and
  two remaining `bun.lock` gaps (peers written as dependencies, `lockfileVersion`
  reset). The owner proposed the peers fix upstream as
  [aubepkg/aube#1727](https://github.com/aubepkg/aube/pull/1727); the `lockfileVersion`
  fix is opened after it merges.
- Why the Bitwarden SDK's async exports never settle on unparsable arguments (owner,
  2026-10-13 14:38 UTC): the
  [research note](research/2026-10-13-bitwarden-sdk-async-hang.md) traces it to
  wasm-bindgen converting async-export arguments inside the future, with tsify's
  deprecated `from_wasm_abi` and Bitwarden's pending migration as context. Worker
  termination already recovers. The owner chose not to report it upstream (15:00 UTC).
- Which hand-written primitives should become libraries or standard APIs (owner,
  2026-10-13 13:59 UTC): the [survey](research/2026-10-13-primitive-libraries.md)
  covers base64 and hex, CBOR, IndexedDB and deep equality, the areas that need no
  library, and the owner's choices that followed.
- What sends messages where inside the extension (owner, 2026-10-13 14:04 UTC): the
  [route map](research/2026-10-13-extension-message-routes.md) lists every route and
  what `@webext-core/messaging` 4.0.0 can carry; it cannot address a document by
  `documentId` and has no Port support.
- Which web standards could replace parts of a login recipe (owner, 2026-10-13 23:12
  UTC): the [note](research/2026-10-13-login-standards.md) summarises an external
  write-up, checked against primary sources, on Immediate UI, FedCM and Agentic
  Federated Login, `<login>`, WebMCP, Email Verification, Login Status, WebOTP,
  delegated authorization for agents and CXF/CXP.
- An external static review of main `4961de6` (owner, 2026-10-13 21:57 UTC): the
  [note](research/2026-10-13-external-review.md) records each of its seven findings,
  checked against the code, and the issues that handle them.
- Which newer JavaScript, CSS, React, library and Chrome features Pateat uses (owner,
  2026-10-13 21:36 UTC): the
  [note](research/2026-10-14-platform-feature-candidates.md) records each candidate of
  an external list, adopted, not adopted or experimental, under the
  [platform feature rules](development.md#platform-features), and the issues for the
  adopted ones.
- Whether a Chrome Web Store reviewer may count service-held recipes as remote commands
  (2026-10-17): the [note](research/2026-10-17-chrome-web-store-remote-code.md) reads
  the MV3 code rule, the review process and AdGuard's precedent against the recipe
  schema, and proposes what would lower the risk
  ([phase 3](#phase-3-public-release)).
- Earlier research kept as dated notes:
  [identity provider screens](research/2026-10-11-identity-provider-screens.md) behind
  [ADR 0026](adr/0026-sign-in-through-identity-providers.md);
  [device credential expiry](research/2026-10-11-device-credential-expiry.md) behind the
  90-day idle expiry, with how a Chrome Web Store item might keep the current extension
  ID;
  [Bitwarden passkey wrapper coexistence](research/2026-10-10-bitwarden-passkey-coexistence.md)
  behind ADR 0007's outermost wrapper;
  [limits on automating installed Chrome](research/2026-10-10-real-chrome-automation-limits.md);
  and [Claude Design](research/2026-10-11-claude-design.md) for the UI polish.

### To consider, not planned

- With Bitwarden writes, keeping Pateat's per-item metadata in Bitwarden custom fields,
  such as which profiles may use an item or which identity provider a site uses, so the
  service could be limited to recipe generation and sharing. Choosing the default among
  several vaults is the hard part, so this would likely be opt-in.
- Proposed (2026-10-13): once each is enabled by default in Chrome stable with a settled
  specification ([platform features](development.md#platform-features)), let a site's
  own interface replace Pateat's inference: FedCM's agent interface (Agentic Federated
  Login) for the SSO buttons of
  [ADR 0026](adr/0026-sign-in-through-identity-providers.md), `<login>` elements for
  sign-in entries and account lists
  ([ADR 0028](adr/0028-account-chooser-login-pages.md),
  [ADR 0031](adr/0031-sign-in-entry-pages.md)), and Email Verification, checked again
  before the email-code sign-in of [phase 4](#phase-4-issues-and-work-as-needed) is
  designed. Whether an extension can use FedCM's agent interface is not known yet. On
  2026-10-13 all three were drafts or origin trials
  ([login standards](research/2026-10-13-login-standards.md)).

## Foundation progress

Implemented: WXT production shell, strict Valibot status contracts, isolated
localhost-only probe build, a Worker with typed cf configuration, shared mise/hk checks,
CI/CodeQL, and automatic release of the newest tested main build after main CI
([delivery](delivery.md)). Tool versions are pinned in `mise.toml` and `mise.lock`, and
dependencies, installed by aube, in `bun.lock`; no native helper or production secrets
are required to build or test.

Local source/Worker tests, typechecks, builds, prebuilt dry-run and emitted-bundle smoke
checks have passed. At head `c24d82a`,
[Linux CI](https://github.com/risu729/pateat/actions/runs/37969704501) passed the
complete check graph, including all three Playwright tests for the production package,
installed shell status, and document-start/inactive-tab identity probe;
[CodeQL](https://github.com/risu729/pateat/actions/runs/37969704219) also passed. On
2026-10-10 the downloaded Windows Chromium failed before launch with a missing
SideBySide assembly on one local Windows host. On 2026-10-11 a clean `windows-2025`
runner launched the Playwright-downloaded Chromium and
[passed all 92 packaged-extension tests at that head](https://github.com/risu729/pateat/actions/runs/38118250919/job/114407461875),
so the failure did not reproduce on a clean Windows host. CI ran these tests on
Windows on every PR and main push from 2026-10-11, then only on main pushes and manual
runs, until the owner dropped Windows from CI later on 2026-10-12 (no Windows-only
Pateat defect was found). The later
installed-Chrome synthetic probe passed the early login gate; broader coexistence
remains a separate M1 gate. Code Quality is not used, and normal merges need no bypass;
see [merging](delivery.md#merging).

## Local settings progress

The first M2 slice provides automatic save and explicit reload controls for local
connection, group/item selection, item/field exclusions, host exclusions and
exact-origin account defaults. Two bundled demo vaults contain display metadata only.
There are no credential values, provider sessions, real vault connections, page
observations or login operations.

Settings use a versioned local snapshot and a worker-owned revision check.
Stale saves fail without overwriting newer restrictions. Invalid stored data
fails closed and is preserved. The settings page retains an unsaved draft on
conflict; explicit reload replaces it with the saved version. Storage is restricted
to trusted extension contexts before settings access. Site policy is checked
before account resolution, exclusions win, and a denied/missing default never
falls back to a different account. This is the selection boundary for a future
executor, not evidence of automatic filling or current-session switching.

Policy/storage unit tests and isolated browser tests cover these boundaries, including
browser restart, stale settings pages and content-script denial. The settings UI uses
the approved React, Tailwind/Base UI and TanStack Form/Query composition. The draft is
independent of the metadata query cache; automatic refetch/retry is disabled. Browser
component tests cover error recovery and keyboard behavior, while extension tests retain
the worker/storage boundary checks and add automated accessibility inspection. The first
executor slice adds strict bounded recipe, account-binding and operation contracts, an
XState lifecycle, and fixed DOM operations behind the separate localhost-only probe
build. It uses explicit saved account defaults and bundled synthetic values. A metadata
journal precedes every fill and click; input-triggered advance/submission declares its
effect and event explicitly. Recovery observes the current document and never blindly
replays an uncertain mutation or pending submit. Another tab's attempt of the same
origin that is running or ended without success holds the origin until that tab closes
or its record has not changed for 5 minutes;
an `authenticated` one, or one Pateat itself stopped with nothing in flight, does not,
and a new page of a tab whose login Pateat stopped before any submission logs in as a
new tab would. A tab keeps one record per
origin
([ADR 0022](adr/0022-login-attempts-per-tab-and-origin.md)).

The shared synthetic site verifies field values, click counts and server-observed
POST counts independently of the executor. Interruption fixtures distinguish
intent persistence, delivery, effect and acknowledgement; a missing acknowledgement
never authorizes another fill or a fallback click.
[Development](development.md#installed-chrome-synthetic-login-probe)
describes the early installed-Chrome acceptance procedure. Attempts start when a
recipe's first step appears, also after a same-document URL change or in a dialog opened
later, and later steps wait up to 10 seconds for their elements
([ADR 0013](adr/0013-service-held-recipes-and-settings.md#recipe-lookup)). Login forms
inside frames fill only when the frame's URL and the tab's URL both match the item
([ADR 0017](adr/0017-login-forms-in-frames.md)). Production now admits HTTPS sites
([ADR 0009](adr/0009-install-time-https-site-access.md)) and reads recipes from the
service ([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). The early
installed-Chrome run passed multi-page, background-tab, single-page, rejection,
ambiguity, concurrency and input/change-triggered advance cases using synthetic values.
It does not establish current SDK/setup compatibility or official Bitwarden extension
coexistence. See the
[dated acceptance evidence](research/2026-10-10-feasibility.md#early-installed-chrome-acceptance-2026-10-10).
M2's synthetic gates have passed; ADR 0021 adds account choices to it, and M1 still
needs the Chrome use coexistence probe.

## Bitwarden transport progress

The first M3 slice isolates provider endpoints and transport in
`packages/bitwarden`. It covers official US/EU environments and standard HTTPS
self-hosted service paths, with fixed prelogin and encrypted-sync operations.
Redirects, browser cookies, automatic retries and arbitrary caller-supplied
request destinations are excluded. Response size, cancellation and parsing
boundaries have synthetic tests; errors do not expose request or response bodies.

The connection setup below integrates this library with extension settings and the
local cache. The isolated authentication and account-mapping operations are described
below. Real-account MFA compatibility remains outstanding. Synthetic fetch tests do
not establish real-server compatibility or installed-Chrome permissions.

## Local cryptography progress

The next M3 slice uses the pinned official OSS SDK under its GPLv3 option, as
approved in [ADR 0005](adr/0005-bitwarden-local-crypto.md). It introduces isolated
local sessions, bounded PBKDF2/Argon2id admission, V1/V2 account initialization,
strict cipher and stored-passkey decryption, and verified security-version
checks. The account mapper below prepares encrypted sync responses for these
sessions. Extension connection setup and the persistent cache layer have separate
progress sections below.

The pinned SDK's V2 version export also rewraps and re-signs an in-memory copy of
verified key state. Pateat keeps only its version and does not send or persist
the export. This adds transient sensitive copies and computation. Invalid blobs
never fall back to legacy fields; supplied URI checksums are verified even for
legacy keyless items, while absent legacy checksums remain supported.

Synchronous SDK parsing checks serialized keys before asynchronous bindings that can
otherwise leave malformed-input calls unresolved. Signed COSE objects are not
pre-checked (owner decision, 2026-10-13): malformed ones inside valid base64 leave
`initialize_user_crypto` unresolved, and the extension ends that call by terminating
the Worker (`crypto-failed` from its error event, or `timeout`). Account initialization
verifies the signatures; `cbor2` then reads the verified security-state version. Key
admission can temporarily unwrap/rewrap key material; those
results are discarded and mutable key buffers cleared. This is additional local
work, not a claim of zero-copy secrets or cancellation of synchronous WASM.

Disposal invalidates results immediately but defers native object cleanup until
pending operations settle. Hard cancellation requires termination of the owning
Worker. A separate synthetic extension page exercises packaged native WASM,
real vectors and Worker termination. The reusable background host is described
below; neither probe activates production login. See the
[source/distribution requirements](sdk-source.md) before conveying its binary.

An earlier synthetic executor artifact was manually installed in the owner's
Chrome on 2026-10-10. Chrome-use observations verified single/multi-page login,
input-triggered submission, uncertain-outcome stopping and competing-tab refusal.
Page-recorded visibility showed a successful inactive-tab run. This evidence
does not cover the SDK slice, real vaults, actual-profile restart or coexistence
with the official Bitwarden extension; M1-M3 remain incomplete.

## Authentication progress

The isolated authentication slice adds local authorization-hash derivation and fixed
password/refresh-token requests. It uses the SDK for the original KDF and native
WebCrypto for the protocol's one-iteration hash, with independent upstream
answers and a synthetic MV3 probe. Authentication prelogin parameters remain
separate from vault-unlock parameters. The pinned SDK's transitional missing/null
prelogin-salt fallback uses normalized email; present-empty salt and unknown KDFs
are rejected, and no alternate endpoint is tried automatically. The password
prelogin route also accepts the flat `kdf`/`kdfIterations`/`kdfMemory`/`kdfParallelism`
fields when `kdfSettings` is absent or null, which the server model allows until its
PM-28143 cleanup. On 2026-10-11 Bitwarden Cloud US (server 2026.9.2) answered
`/accounts/prelogin/password` for a real account with only those flat fields
(`{"kdf":0,"kdfIterations":600000,"kdfMemory":null,"kdfParallelism":null}`), and setup
had stopped with `invalid-response` because `kdfSettings` was required. With this
change, real-account setup on Cloud US succeeded at main `f7d3cf5` on 2026-10-11
([passkey evidence](#passkey-progress)).

The transport supports explicit manual authenticator/email codes and new-device
OTP submission as request shapes. Challenge, rejection and interactive/unsupported
results are distinguished without returning raw server messages or challenge
URLs. No method is claimed compatible with a real account from synthetic HTTP
tests. Settings integration, code-delivery initiation, interactive providers,
token persistence and authoritative account/cache reconciliation remain separate
gates; an authenticated transport result does not mean an unlocked vault.
The transport uses the explicit read-protocol profile described in the
[architecture](architecture.md#vault-adapter). Header acceptance alone does not
prove real-account compatibility or complete sync coverage.

## Account mapping progress

The isolated mapper maps received account/sync data into the local crypto boundary
and defines an explicit read-protocol profile. It correlates provider and
subject continuity, distinguishes authentication from unlock parameters, rejects
incomplete current-format state and carries known account/security-version
floors. Unsigned token-claim decoding is consistency checking, not independent
authentication or ownership proof.

The initial mapper targets ordinary login, secure-note, card and identity items.
Other item types receive explicit unimplemented outcomes without blocking
unrelated supported items. Do not expand rare-type support solely to satisfy a
compatibility label. All received IDs still require validation and uniqueness;
malformed supported/account data cannot fall back to older formats or secrets.
Coverage remains the received envelope, not a complete-vault or atomic-cache
claim. Real-account setup, persistent unlock and cache reconciliation remain
separate integration gates.

Synthetic raw token/sync responses exercise real SDK password unlock and
decryption for personal and organization items and V2 sealed blobs. The V2
password wrapper is explicitly SDK-generated compatibility data; its signed
account state and blob/plaintext anchors come from recorded upstream fixtures.
This is not an independent password-wrapping known answer or real-account proof.
The packaged browser probe includes both V1 and V2 mapping/password-unlock paths.

## Local field and TOTP progress

The isolated field resolver covers ordinary login, secure-note, card and identity
values plus Text, Hidden, Boolean and Linked custom fields. It exposes value-free
metadata and scoped references, preserves duplicate names and leading zeros, and
requires an explicit allowlist for both a linked alias and its source fields. The
settings catalog lists each field's display label, its raw custom-field name (`null`
for built-in fields, unnamed fields and names over 200 characters), its kind and, for a
Linked field, the built-in field it reads; each connection also names its provider
account ID. These are what synced, name-based bindings need
([ADR 0013](adr/0013-service-held-recipes-and-settings.md)).
Disposing a snapshot prevents later resolution. The host must still enforce
destination policy and invalidate stale operations.

OTPAuth supplies local standard TOTP and Steam generation. Supported inputs are
canonical Base32 and explicit TOTP URI parameters; unsupported algorithms and
HOTP are explicit errors. OTP seeds are not field values or inference inputs.
Independent RFC 6238 and pinned upstream answers, clock boundaries and the
packaged MV3 probe are the verification gates for this slice.

Connection setup, cache adoption and custom-field exclusion rebinding are now
integrated, as described below. The remaining M3 integration gaps are listed after
the connection setup section.

## URI candidate matching progress

The isolated provider matcher uses the approved tldts dependency for public and
private suffix handling after WHATWG URL normalization. It implements ordinary
Domain/Host/Exact/StartsWith/Never modes and direct equivalent-domain groups;
Regex remains explicitly unsupported. Output contains candidate indices, modes,
a descriptive target origin and per-URI unavailable reasons, without raw URLs.
The trusted host must supply URIs and effective settings from the same selected
account/snapshot.

Raw prefix/equality behavior follows the pinned provider. Matching is not a fill
grant or a change to the automatic candidate-scope contract. The current executor
still has its existing account/origin/document checks, and live settings/catalog
integration must derive authorization separately. Synthetic tests cover private
suffix isolation, IDN, localhost/IP, equivalent groups and malformed destinations;
the MV3 probe passes a real SDK-decrypted, checksum-validated URI to this matcher.

Prepared accounts now retain a URI context from the same sync: normalized direct
equivalent-domain groups and the effective default mode. The default is Domain unless
an enforced organization URI-match-defaults policy applies, using the pinned SDK's
exemptions for owners, admins and provider users. Pateat cannot see the official
clients' local default setting. Differing enforced defaults, or malformed policy or
domain data, mark that part unavailable; affected URIs report unavailable rather than
falling back. An equivalent-domain entry that is not a hostname, including an empty or
overlong one, is ignored, as in the official clients, while the rest of its group still
applies. A retained context that no longer readmits, for example after an IDNA table
change, is dropped: fields keep working, and URI matching reports unavailable until the
next accepted sync.

The owner asked for official-client URI rules. The remaining differences (Regex, no
Domain fallback on unavailable context, no access to the local default setting) are
recorded in the [architecture](architecture.md) for later reconsideration.

The crypto Worker captures login URI rules while verifying every received item,
skipping deleted and archived items, and answers fixed snapshot-bound match requests
with item IDs and URI indices only. A settings bridge queries enabled connections
whose snapshot is ready or under review, after site exclusions, and keeps only
eligible, non-quarantined items. Unavailable connections and eligible items with
unevaluated rules are reported, never treated as no match. Pateat only receives
confirmed organization memberships, so a policy from an accepted-only membership is
treated as enforced; this can only enforce or mark a default unavailable. Native browser
tests verify an actual SDK-decrypted URI with the retained context across a full
profile restart, and the unavailable result for a cache without context.

## Background cryptographic host progress

The offscreen host slice connects trusted background operations to packaged
Dedicated Workers running the approved SDK. Its private runtime Port is bound
to the browser-reported offscreen document context. Fixed operations support
authorization hashing before a user ID is known, scoped account sessions and
local field access; they do not expose SDK dispatch to pages.

The verification graph includes actual MV3 sender/context checks, real SDK vectors
through the host, connection isolation, lock and hard cancellation, bounded
deadlines, and fresh recovery after service-worker or offscreen-document loss.
A new background incarnation must replace old hosts and reject
old handles without replaying requests. Production artifacts now package the
host and WASM. The connection setup slice below now calls the same host.

[PR #18](https://github.com/risu729/pateat/pull/18) passed the complete Linux
verification graph with 46 host tests and 42 extension tests. Its actual browser
tests verify native Worker creation/destruction, hard cancellation, fresh
offscreen recreation and service-worker restart. This is synthetic runtime
evidence; it does not establish real-provider or installed-Chrome compatibility.

The persistent-unlock layer below adds encrypted-cache acceptance; that behavior
is not proven by the host's in-memory restart fencing. Connection setup and
settings/catalog integration are described below; real-provider compatibility
remains unverified.
Conveying a new artifact still requires its matching
[Corresponding Source](sdk-source.md).

## Persistent unlock and cache progress

The cache slice implements
[atomic local cache records](adr/0006-atomic-local-vault-cache.md), verified SDK
unlock-key retention, offline restoration and durable local disable. It has no provider
HTTP or production setup UI.
[PR #19](https://github.com/risu729/pateat/pull/19) passed full Linux CI with 71 vault
tests and 58 extension tests. The 16 added browser cases passed real IndexedDB revision
conflicts and aborts, disable versus stale acceptance, full browser restart with the
same isolated profile for V1/V2/organization accounts, fresh SDK verification, preserved
snapshot identity, and unavailable-item replacement without older secrets. Independent
review verified restore/disable ordering and cleanup joining. This is synthetic native
browser evidence, not an installed-profile or real-account compatibility claim.

## Connection setup and live catalog progress

The connection setup slice connects manual options setup to the existing authentication,
mapping and durable-cache components. It adds configured-provider host permissions,
bounded manual challenges and a value-free catalog for local settings. Production site
execution remains a separate integration gate. Provider authentication was transient
in this slice; [durable provider sessions](#provider-session-progress) followed.

Catalog replacement preserves custom-field denies: exact unchanged encrypted field
sequences, or decrypted fields the crypto host finds equal while the old snapshot is
still open, can rebind snapshot-scoped references, while changed or ambiguous sequences
with custom-policy history block the affected item's secret release until reviewed.
Protected snapshot bindings survive even a review choosing no exclusions. Generic saves
cannot clear unresolved exclusions or that binding history. Separate cache/settings
stores detect mismatched state after interruption; they do not provide one atomic
combined commit. Catalog bounds are validated before unlock-key export and cache commit.

The settings page can delete a connection locally, as
[Development](development.md#manual-bitwarden-setup-preview) describes. Unit, options
component and isolated Chromium tests cover deletion with synthetic providers, including
removed native records after a full profile reopen. The owner also deleted leftover
connections in the installed Chrome on 2026-10-11, then completed first setup against
a real Bitwarden Cloud account
([evidence](research/2026-10-10-feasibility.md#first-real-account-sign-in-2026-10-11)).

[PR #20](https://github.com/risu729/pateat/pull/20) passed
[full Linux CI](https://github.com/risu729/pateat/actions/runs/38047201686) with 766
package, 72 connection, 73 vault, 47 host, 42 contract, 21 options and 69 extension
tests, and [CodeQL](https://github.com/risu729/pateat/actions/runs/38047201688). The 11
added native setup cases cover restoration after a full browser close, manual MFA and
new-device verification, two connections, preservation of the existing cache after
rejected re-authentication or oversized metadata, and custom-field rebinding and review.
Independent review approved the change. The fixed browser probe substitutes provider
responses and host permission decisions; it does not establish real optional-permission
prompt behavior or real-account authentication. Production starts with an empty catalog
until connections are configured. The demo catalog remains confined to the synthetic
probe. Production builds with the SDK and this setup have since connected the owner's
real Bitwarden Cloud US account in their Chrome
([evidence](research/2026-10-10-feasibility.md#first-real-account-sign-in-2026-10-11)).

### Remaining M3 integration gaps

- The executor chooses the account for each admitted document. A saved site default
  wins. Without one, it asks every enabled connection for provider URI candidates for
  the document's own URL and uses the item only when exactly one eligible item matches
  (ADR 0013). Several matches refuse as `account-ambiguous`, none as `default-not-set`
  (which asks for a vault check,
  [ADR 0025](adr/0025-automatic-vault-sync.md#after-no-item-matches));
  an unevaluated item (including Regex rules) as `item-uri-unevaluated`; and a
  connection that cannot answer, or a locked vault, as `vault-unavailable`. Each
  document asks once and reuses the answer while every connection's snapshot is
  unchanged, so a new match from a later sync stops the attempt; every policy check
  still compares the choice with the attempt's account. It is saved (`siteDefaults`
  plus `settings.bindings`) only after the outcome is `authenticated`, only for the
  account the attempt used, only when the settings revision is still the one the
  attempt was authorized under, and only for what is missing; nothing is saved on
  `credential-rejected` or an unknown outcome. Saving bumps the settings revision every
  attempt checks, so it is skipped while another login is still running; the next login
  chooses again.
- A site default names the provider account and item
  (`{ origin, provider, userId, itemId, itemName?, accountName? }`, ADR 0013).
  `itemName` is the item's label and `accountName` the vault connection's label when the
  default was saved, kept only for display, such as for an account that is not connected
  here; a default can lack them. A binding has the same optional `accountName` beside
  its required `itemName`; settings sync fills in a missing name (see
  [service sync progress](#service-sync-progress)). The executor and the settings page
  find this device's connection through the catalog connection's `userId`, and an
  account that is not connected here refuses as `connection-missing`, one connected
  twice as `account-ambiguous`, and one whose vault is locked or unavailable as
  `vault-unavailable`; the settings page refuses to save a default it could not use. An
  automatic choice is checked in the same form, so the only URI match of an account
  connected twice also refuses as `account-ambiguous`. The device-local form with a
  `connectionId` was removed before release
  ([compatibility before release](development.md#compatibility-before-release)).
- The settings page lists, as the default account for an origin, only the items its
  unsaved draft allows that could serve it: a provider URI match for `origin/`, a static
  `allowedOrigins` entry, or a stored passkey whose RP ID is the origin's host or a
  registrable parent domain. The draft decides which connections and items are searched;
  it grants nothing, and usernames are read only under the saved settings. The
  background answers `settings.site-accounts` with item IDs, the reasons and, for those
  matched items only, the login username (owner decision, 2026-10-11: usernames are
  shown only while matching, never kept in the catalog or sent to the server). It says
  when a vault or an item could not be searched. Items whose names are still equal get
  an item ID prefix. A deeper-path Exact or StartsWith rule is not evaluated there, so
  the page can also list, after the matches, every other item the draft allows, marked
  as not matching. A saved default for a live vault item is not shown as an origin
  mismatch, since its URI rules are checked on each page. Its row asks the same question
  for its origin: when its item matches, the row shows how and the login username,
  looked up again on each visit and never saved (the same 2026-10-11 decision); when
  every vault was searched and it does not match `origin/`, the row says so; otherwise
  the row keeps the neutral note. Either way it shows no username. The background
  answers these lookups one at a time, since a vault's crypto Worker takes one job at a
  time. The owner confirmed both the picker and the saved row against a real vault in
  the installed Chrome on 2026-10-11
  ([evidence](research/2026-10-10-feasibility.md#default-account-picker-on-a-real-vault-2026-10-11)).
- A saved default's own item is matched the same way. A match satisfies the item origin
  check for that document only, and is reused while the connection's snapshot is
  unchanged; it never saves `allowedOrigins` or grants a field. Each new document is
  matched again, so an Exact rule refuses a later page at another path. No match refuses
  as `item-origin-mismatch` and asks for the same vault check. Page URLs over 8192
  characters and answers from another snapshot refuse as `vault-unavailable`. Static
  `allowedOrigins` remain empty for live items; Domain-mode subdomains and raw
  StartsWith rules cannot be expressed as exact origins, so do not derive them.
  Synthetic unit tests cover these paths, and `tests/extension/login-service.spec.ts`
  runs the chain in Chromium: the built API Worker, served locally over HTTPS with a
  local D1 database, holds a recipe and a binding; the extension syncs both, chooses the
  synthetic Bitwarden item by its single URI match, logs in on a routed HTTPS site,
  uploads the saved account and logs in again after a full browser restart.
- The declarative executor reads account metadata from the live settings catalog on
  every policy check and resolves each bound field through the connection runtime
  immediately before a fill. An unavailable connection or an item awaiting field review
  is refused before an attempt starts. A denied, locked or failed field read, or a
  replacement snapshot before delivery, blocks the attempt as `policy-changed` without
  filling. Production admits HTTP(S) documents
  ([ADR 0050](adr/0050-http-pages-for-http-items.md)) on a non-excluded site with
  granted host access (a frame also needs its tab's page admitted;
  [ADR 0017](adr/0017-login-forms-in-frames.md)), with or without a saved default
  ([ADR 0009](adr/0009-install-time-https-site-access.md)); without a cached recipe they
  stop with `recipe-not-found` before the policy catalog or vault is opened, unless the
  page qualifies for recipe generation
  ([ADR 0016](adr/0016-recipe-generation-trigger.md)). Only the
  probe build grants its loopback origin to the probe item and supplies recipes and
  bindings. Recipes and account bindings come from the service cache
  ([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). The executor looks up the
  chosen item's binding in `settings.bindings` by recipe, provider, provider account ID
  (the catalog connection's `userId`) and item, falls back to the built-in-slot binding
  (`defaultLoginBinding`), and maps it to this device's field IDs with
  `resolveBindingFields` over the catalog's raw field names. A recipe with another slot
  and no saved binding refuses as `binding-not-found`; a connection without a `userId`
  refuses as `vault-unavailable`. Production reads recipes from the synced recipe cache
  described under [service sync progress](#service-sync-progress), and bindings from the
  synced settings described there. Settings always carry a `bindings` list, which may be
  empty. Provider-derived origins remain open.
- A fill step refuses as `structural-mismatch` before writing anything unless all of its
  inputs share one `<form>` (or all sit outside any form), and each secret value lands
  in an input made for it. A Bitwarden `login.password` (or the probe's dummy
  `password`) fills only `type="password"` inputs or inputs whose `autocomplete`
  includes `current-password`. A `login.totp-code` fills `autocomplete="one-time-code"`
  inputs, or `inputmode="numeric"`, `type="tel"` or `type="number"` inputs with a
  `maxlength` from 1 to 10. A Hidden custom field fills the password inputs above or
  those short numeric inputs (a PIN), never a plain `type="text"` input such as a
  passphrase field. A Linked custom field follows the rule of the built-in field it
  reads, so one linked to `login.password` fills only password inputs. The owner chose
  this rule on 2026-10-10. Each write rechecks the same conditions. Usernames, Text
  custom fields and other values fill any writable input. There is no per-binding
  exception, so a bank PIN rendered as `<input type="tel">` and
  bound to `login.password` is refused; revisit if such sites are common.
- A real Bitwarden Cloud US connection passed on 2026-10-11 (see
  [connection setup](#connection-setup-and-live-catalog-progress)). Individual MFA
  methods, the install-time site-access warning and the setup prompt after withheld site
  access in installed Chrome remain separate gates.

## Provider session progress

Implemented as [ADR 0008](adr/0008-durable-provider-sessions.md) describes. The native
IndexedDB database at version 2 holds a `records` store and a `providerSessions` store;
vault records still never contain tokens. A version 1 database from an earlier build
fails to open until the extension is reinstalled
([compatibility before release](development.md#compatibility-before-release)). A
refresh claim holding only the refresh token commits by compare-and-swap before HTTP, a
network failure, timeout, 429 or 5xx restores the previous session so a later sync
retries it, a claim left by a stopped worker is resumed by the next sync, any other
failure requires password sign-in, rotation commits before sync,
and an absent refresh token keeps the captured one. Local forget, permission loss for
that provider, a rejected refresh or access token, and a mismatched account context
clear only the sync session. Startup only reads state; the settings page shows sync
sign-in and automatic unlock separately and labels forget as local.

Automatic sync is implemented as [ADR 0025](adr/0025-automatic-vault-sync.md) describes:
page and passkey events and a five-minute alarm check the revision date at most once a
minute, and a full sync runs only when it moved and no login is in progress. Unit tests
cover the schedule, the replacement hold, the revision outcomes and manual Sync; an
isolated Chromium test fires the alarm against the synthetic probe. The comparison of
protected items' decrypted custom fields is covered by unit tests and an isolated
Chromium sync of a synthetic item whose password changed and whose custom fields were
re-encrypted. After a page with a recipe finds no matching item, a check runs at most
every ten seconds and reconnects only the refused document once it applied a new
snapshot; unit tests cover the gate, the window and the reconnect target, and
`tests/extension/login-service.spec.ts` logs in on a routed site once the item's URI
arrives through that check. Automatic sync is not yet verified in installed Chrome or
against a real account.

On 2026-10-12 the owner's installed Chrome reported `reauthentication-required` about
five minutes after an extension update, after hourly refreshes had worked since the
previous day's sign-in. A refresh claim had been left behind: either the worker stopped
during the refresh request (the log shows 184 worker starts in 14 hours) or the request
failed with a non-retryable error; the log could not tell which. The owner decided that
an interrupted refresh resumes without the password
([ADR 0008](adr/0008-durable-provider-sessions.md)). Automatic checks also run under the
same keep-alive as model calls, and each refresh result is logged as `vault.refresh`
with its error code and status. Unit tests cover the resumed claim; it is not yet
verified in installed Chrome.

Unit tests cover claims, rotation, concurrent writers, forget and permission races,
expiry from the token's own claims, and per-provider permission loss. Isolated Chromium
tests cover the native session store's guards and readback, two password-free syncs
after a full profile reopen, and local forget and permission removal with offline unlock
kept. These use synthetic providers.
An
[installed-Chrome check](research/2026-10-10-feasibility.md#installed-chrome-provider-session-check-2026-10-10)
confirmed a password-free Sync after a full browser restart with the synthetic probe. On
2026-10-11 the owner's installed Chrome confirmed, with the real Cloud US account, two
password-free refreshes separated by a full browser restart, and that changing site
access to "On click" cleared only the sync session while the local vault and automatic
unlock stayed
([evidence](research/2026-10-10-feasibility.md#real-account-refresh-and-host-access-revocation-2026-10-11)).

## Service sync progress

The first M4 slice turns the health-only Worker into a device-authenticated
settings/recipe sync API with Hono, Drizzle and a D1 schema. Shared Valibot contracts
cover synced settings, immutable recipe revisions with tombstones, cursor pages and
conflict responses. Every query is scoped by the owner resolved from a hashed,
revocable device credential; request paths and bodies never select an owner. Settings
writes and recipe heads use conditional revision writes, and a recipe's history row
is recorded in the same D1 batch only when that request won the head.

Local Miniflare tests cover unknown, malformed and revoked credentials, owner and
device isolation, stale and concurrent writes, tombstones, cursor paging, strict
schema rejection, media type and body limits, and fail-closed handling of corrupt
stored documents. Concurrent cases interleave within one local runtime, not hosted
D1. A migration check regenerates SQL from the Drizzle schema. The D1 database was
created on 2026-10-11 and the service is deployed at `pateat.takuk.me` (see
[delivery](delivery.md)).

The second slice adds the service side of
[device pairing](architecture.md#device-enrollment). The Worker verifies Cloudflare
Access tokens itself (RS256 signature against the team keys, issuer, audience, expiry
and a user subject) and maps the issuer and subject to an owner. `POST /pair`
([ADR 0020](adr/0020-direct-device-pairing.md)) sits behind Access, accepts only an
`Origin` naming an extension ID in `PAIRING_EXTENSION_IDS`, limits pairing per
identity, creates the owner on first pairing and answers the device credential once.
The owner can list and revoke devices; a device can revoke itself. Local Worker tests
use synthetic signing keys and extension IDs and cover forged, expired, wrong-audience
and service tokens, missing configuration, refused and missing origins, strict bodies,
the per-identity limit, concurrent first pairings, the absence of CORS headers, the
removed `/enroll` and `/redeem` routes and cross-owner revocation. The typed-code
`/enroll` and `/redeem` flow it replaced, with its `enrollments` table, is removed;
a D1 migration drops the table.

The extension side of pairing is the third slice. The settings page has an optional sync
service panel: it accepts only an exact HTTPS origin and a device name that passes the
shared label schema. **Pair this device** asks Chrome for site access to the service
host inside the click, then asks the background to pair. The background service worker
sends one `POST /pair` with the browser's cookies, unfollowed redirects and
`X-Requested-With: XMLHttpRequest`, and writes the credential straight into trusted
extension storage; it never crosses the runtime message boundary. An Access redirect,
a `401`, or a response that is not JSON, such as the Access login page, means the user
must sign in; a non-JSON `429` or `5xx` edge error page counts as rate limiting or an
unexpected answer instead. On a sign-in the page opens
`<service>/pair/signed-in` ([ADR 0030](adr/0030-pairing-without-warp.md)) in a new tab
once per click, retries once when it is shown or focused
again, and offers **Try again** and **Open sign-in page**; a later retry opens no tab by
itself. Nothing is stored until the service has created the device, and an issued
credential whose write failed is kept in memory and saved on the next request. An
unreadable stored connection fails closed until the owner forgets it. Disconnecting
revokes the device with its own credential and forgets it locally even when the service
cannot confirm, in which case the page points to the management page. Only pairing sends
cookies; the `/v1` requests refuse redirects, send no cookies and bound response bodies.

Unit tests cover the transport with synthetic responses, including a synthetic
`opaqueredirect`, HTML login, `401` and denial pages, edge error pages, each error code,
oversized bodies and timeouts; the settings client's sign-in tab URL and its refusal of
an invalid origin; and the background runtime with in-memory storage. Component tests in
Vitest Browser Mode cover one-click pairing, the sign-in tab, **Try again**, the focus
and visibility retry, no second automatic tab, each error message, declined site access
and the absence of any code. `tests/extension/pairing-service.spec.ts` loads the
production build in bundled Chromium against the built Worker behind a loopback stand-in
for Access, which forwards a request carrying a synthetic `CF_Authorization` cookie with
a synthetic signed assertion and redirects any other to a login page. With the cookie,
one click paired: the `POST /pair` came from the background with
`Origin: chrome-extension://ekcnbbomcllhpomkeofikjagmjoibffk` and the cookie, the
settings page sent no request to the service, and the first `/v1` sync sent no cookie.
Without it, the page opened `/manage` once and paired after **Try again**, or by itself
on the `focus` event that the test sends after bringing the page to the front; headless
Chromium does not reliably send one itself. This shows bundled Chromium behavior only.
The stand-in does not model Access's own `401`, denial page or cookie validation; only
the transport unit tests' synthetic responses cover those.

On 2026-10-11 the owner ran this in the console of Pateat's **service worker**
(production build of main `59a2d12`, console context `background.js`):

```js
fetch("https://pateat.takuk.me/manage/api/devices", { credentials: "include", redirect: "manual" })
```

It returned `200`, type `basic`, with the device list. So installed Chrome sends the
Access session cookie on the background's requests to the service host. The Access
application's cookie settings at that time (SameSite, HttpOnly, binding cookie) are not
recorded yet. On 2026-10-11 the post-deploy probe ran from the background of the owner's
old install, whose path-derived ID is not listed, against revision `ac33781`:
`POST /pair` returned `403`, type `basic`, with `extension_not_allowed`, and created no
device. So the Access cookie reaches the Worker and the extension `Origin` arrives
intact. Installed Chrome later paired directly on 2026-10-11 (see
[remaining M4 service gaps](#remaining-m4-service-gaps)).

The fourth slice syncs recipes into a last-known-good cache that the login executor
reads. The background pulls `GET /v1/recipes` pages from the stored cursor with the
paired device's credential, applies active and revoked changes, and writes the cursor
and recipes together, so a failed page or write leaves the previous consistent copy. It
reads at most 50 pages per sync, plus one blocked-page retry after an overflow walk,
and refuses a page that moves the cursor backwards or
does not advance it. The cache belongs to one paired device: a new pairing starts from
an empty cache, nothing is served while no device is paired or the pairing cannot be
read, and disconnecting or forgetting an unreadable pairing clears it. Sync runs right
after pairing completes, also when another device's sync is still running, and in the
background when the worker starts, a lookup arrives or the settings page is open and the
last attempt is more than five minutes old. The attempt time is stored, so a worker
restart does not sync again sooner, and a 429 postpones background syncs, but not the
one after pairing, for 15 minutes. A lookup does not wait for the network or for pairing
and disconnect requests. The serialized cache is limited to 2 MiB of the extension's 10
MB `storage.local` quota, which it shares with settings, login attempts and other
extension state (the vault cache is in IndexedDB); a page that would exceed it is not
fully applied. Sync walks later current heads within the shared 50-page budget,
saving revocations and newer non-growing updates to already cached recipes with
the old applied cursor. A separate device-bound checkpoint resumes lookahead
across syncs and worker restarts, including freeing changes beyond the first
50 pages, without adding bytes to the capped recipe cache. Safe cache writes
precede checkpoint advancement. One additional fresh request retries the
blocked page from the applied cursor; pending active changes wait until their
entire page fits. The settled current-head feed can therefore recover when its
active documents fit the service cap, while storage and transport failures
retain earlier durable reductions. Disconnect clearing waits for pending
writes and removes both records
([ADR 0013 amendment](adr/0013-service-held-recipes-and-settings.md#amendment-durable-recovery-under-cache-pressure-2026-10-14)).
How many recipes the cache holds and the implemented service cap are under
[service limits](architecture.md#service-limits). A 401 marks the device as
rejected: syncing stops, login keeps using the cached recipes, and the settings
page says to pair again.
Lookup uses `selectLoginRecipe` for a new attempt and the recipe ID for a resumed one;
two recipes starting on one page find no recipe. Unit tests use synthetic pages and
in-memory storage; sync against the deployed service has no recorded check yet.

The fifth slice syncs the device-independent settings in the same run, after recipes:
site exclusions, site defaults that name a provider account and item, and account
bindings. Vault connections, item selection and field exclusions stay on the device; the
service document always has an empty `connections` list. The background reads
`GET /v1/settings` and merges three copies per entry (exclusions by hostname, defaults
by origin, bindings by recipe, origin and account): the last agreed base, stored under
`pateat.sync-settings.v1`, the local settings and the service's. A side that changed an
entry since that base wins, and the service wins when both changed it; removing an entry
counts as a change. The base keeps the service's copy and the local copy it accounts
for. Both are the same after a complete sync; after an upload whose local write has not
happened yet, the local copy is still the one the merge started from, so a merged entry
the device has not written yet is not read as a local removal, and a local edit made
meanwhile still wins. The base is used only when the service revision is newer than the
stored one, or equal with the same content. Without a base (a new pairing, or a service
whose revision went back below the stored one or matches it with other content) both
sides' entries are kept, the service wins where they differ, and nothing is removed. A
service restored to an older state whose revision has since passed the stored one is
merged against the stored base, so its removals apply. Writing the base is best effort;
when that write fails, the next sync uses the older base, which can drop a later local
edit to an entry that the sync with the lost base changed. Disconnecting forgets the
base but keeps local settings, so pairing with another owner's service uploads this
device's synced settings there. The merge is written back with a conditional
`PUT /v1/settings`, and a stale service or local revision merges again, in up to three
attempts per sync. A merge over the settings limits (1,000 entries per list, or an
uploaded document over 120 KiB of the service's 128 KiB body limit) is not applied, and
the settings page says the settings no longer fit; when a later attempt in the same sync
goes over, an earlier upload stays. Local settings change through the settings store's
revision check, only when the merge differs from them, so an unchanged sync does not
stop running login attempts. Before the merge is uploaded and written, the display names
that site defaults and bindings lack are filled in from this device's catalog when their
provider account is connected exactly once here: the item's label and the connection's
label. A name already set is never overwritten, since another device may label the
account differently or hold an older item label until its vault syncs; an account that
is not connected here, connected twice or unavailable, or a catalog that cannot be read,
leaves the names as they are. The catalog is built only while an entry still lacks a
name, and a settled sync writes nothing. While a login is running, including one between
pages, the upload still happens but the local write waits for a later sync, for at most
two minutes after the first wait. The time of the first wait is stored under
`pateat.sync-settings-hold.v1`, so the limit holds across service worker restarts, and
it is cleared when a sync finds no login running. A later sync starts when the recipe
schedule is due again. Saving settings on the extension's page or saving an automatic
account choice starts a sync at once. A recipe sync that cannot reach the service skips
settings, a 401 from either request marks the device rejected, and the settings page
shows a complete sync only when both finished. Unit tests use a synthetic service and
the real settings store over in-memory storage; sync against the deployed service has no
recorded check yet.

Device credentials expire after 90 days unused, and each use renews them (owner,
2026-10-11; [device enrollment](architecture.md#device-enrollment)). An expired device
gets 401 `device_expired`, which the extension treats like revocation, and the web UI
shows each device's last use and marks expired ones. Local Worker, extension and web UI
tests cover it.

### Remaining M4 service gaps

- Pairing in installed Chrome against the deployed service
  ([ADR 0020](adr/0020-direct-device-pairing.md)): note the Access application's cookie
  settings and run the
  [installed Chrome pairing check](development.md#installed-chrome-service-pairing).
  After `79a1424` was released, `redeem` was removed from the "pateat bypass" Access
  application on 2026-10-11 at about 14:00 UTC; it now lists only `/v1/*`, `/health`
  and the two `/.well-known` issuer paths. An anonymous `GET` or `POST /redeem` then
  got Access's `403` instead of the Worker's `404`, while `/health`, `/v1/settings`
  (`401`) and both `/.well-known` paths still reached the Worker.
  On 2026-10-11 the production build of `e7c7014` was installed in the owner's Chrome
  156.0.8078.16 with ID `ekcnbbomcllhpomkeofikjagmjoibffk`. Pairing from the settings
  page while signed in to Access finished in one click with "This device is paired.",
  and `/manage` listed the new device "risu-thinkpad Chrome" as paired at 14:00 UTC
  (check step 2). Step 3 (signed out) and the cookie settings are not recorded yet.
- Settings that use device-local connection IDs, such as item selection and field
  exclusions, are not synced yet.
  [ADR 0023](adr/0023-synced-vault-policy.md) decides their synced form and custom-field
  review; it is not implemented.
- Done: the [owner web UI](architecture.md#owner-web-ui) serves its React app, assets
  and JSON API behind Access, with the devices, sites, account bindings and recipes
  pages. Settings edits and recipe revocations there use the same revision checks as
  device sync, and a stale page changes nothing.
- Done: the generation routes stop at
  $100 of estimated Claude spend per owner a month and $5 a day (`CLAUDE_CALL_LIMITS` in
  `services/api/src/claude/calls.ts`,
  [ADR 0014](adr/0014-claude-generation-provider.md)). The inference route authenticates
  to Claude per owner through Workload Identity Federation
  ([ADR 0015](adr/0015-per-owner-claude-credentials.md)); a registered, encrypted API
  key is a later second option. The issuer metadata routes, the `inference_credentials`
  table and `resolveClaudeCredential` exist. Owners enter identifiers on the temporary
  `/manage/claude` page until the React web UI replaces it. On 2026-10-11 at 12:26 UTC
  the deployed service at `pateat.takuk.me` exchanged a real assertion with Anthropic.
  The owner's federation rule is scoped to `workspace:developer`, because the Console
  offered no `workspace:inference`, and the token was valid for 10 minutes. The first
  real generation call followed at 12:27 UTC for `https://my.jcb.co.jp/Login`. The model
  abstained (`insufficient-evidence`, $0.008), because the installed build's extractor
  skipped the page's login control: an `<a>` without `href` that submits the form
  from `onclick`.
- Every table is owner-scoped, and any identity the Access policy admits becomes an
  owner on first pairing. Per-owner [service limits](architecture.md#service-limits)
  cap requests (120 a minute), active recipes (1,000 recipes and 1.5 MiB of their
  documents) and kept recipe revisions (10), sized for the owner's own use.

## Passkey progress

[ADR 0007](adr/0007-existing-passkey-assertions.md) records the M5 bridge and
presence policy. The Bitwarden package maps one decrypted FIDO2 credential view
per item into secret-free metadata: ECDSA P-256 public-key credentials, GUID or
`b64.` credential IDs, canonical user handles, lowercase ASCII domain RP IDs
(no IP literals) and decimal counters. Items with several credentials are rejected
instead of choosing one; a nonzero counter is preserved so selection can refuse it.
The SDK-decrypted private key is decoded with a DER framing check only; WebCrypto
import validates its structure. Unit tests cover malformed and unsupported views and
an SDK round trip through the synthetic legacy account fixture.

The extension's assertion core admits only requests with mediation absent, `optional`
or `required` (ADR 0007, amended 2026-10-12) that pass WebAuthn RP ID validation with
tldts private suffixes, and `conditional` ones for a login of the page to answer
([ADR 0034](adr/0034-answer-page-passkey-requests.md)); everything else is a
delegation result. A `PasskeyPolicy` decides whether a missing gesture or a UV
requirement also delegates; the initial policy sets UP and UV unattended. It selects
exactly one eligible credential, refuses nonzero counters, serializes `clientDataJSON`,
builds authenticator data with UP, UV, BE and BS and a zero counter, and returns DER
ECDSA signatures from a non-extractable sign-only key. Unit tests reproduce the WebAuthn
Level 3 ES256 client data and authenticator data byte for byte, verify the published and
produced signatures, and cover the HTML registrable-suffix examples.

Both builds connect that core through a request bridge: a document-start MAIN-world
wrapper for `navigator.credentials.get`, an isolated relay that checks top-level
placement, secure context and the `publickey-credentials-get` policy and reports
transient user activation, and a background runtime bound to the browser-supplied sender
origin, frame 0 and document. Every unclaimed request, failure or deadline calls the
browser's original `get` with the caller's arguments. In the probe build only, a
synthetic source signs with the public WebAuthn test-vector key for `http://localhost`
only. Playwright tests against a synthetic relying party verify Pateat assertions with
Node's independent ECDSA verifier, including UP and UV for page-load and UV-required
requests, prove delegation to a CDP virtual authenticator for nonzero-counter and
unconfigured requests and, under a ceremony policy, for unattended and UV-required
requests, keep the browser's rejection for unknown allow-list credentials and a denied
permissions policy, and cover abort and background timeout.

The crypto Worker can search the verified, live login items of the accepted snapshot for
stored passkeys whose RP ID equals the requested one, and sign with the passkey of one
such item. The host and vault manager expose these two operations with the same snapshot
binding, durable-revision checks and late-result withholding as URL matching. The search
decrypts credential metadata only for items whose encrypted `login.fido2Credentials` is
non-empty and returns only the secret-free metadata above. Items whose metadata cannot
be decrypted, and decrypted items with this RP ID that cannot be used (for example
several stored passkeys), are listed in `unavailableItemIds` instead of failing the
search; items whose passkeys all have other RP IDs are not. Signing re-derives the
item's single credential, requires the requested credential ID and RP ID to match it,
refuses a nonzero stored counter, and signs only 37-byte zero-counter assertion data
whose RP ID hash matches and whose flags carry UP, BE and BS with no attested data,
extension or reserved bits. The decoded key is imported non-extractable inside the
Worker and only a DER signature crosses the Port. A reply bound to another snapshot,
item or credential, or with any other shape, locks the session; an unreadable or
ambiguous item fails on its own without retiring the session. Unit tests sign through
the pinned SDK with the synthetic FIDO2 fixture and verify against its public key.
`apps/extension/src/passkeys/vault.ts` applies the
[ADR 0007 item selection](adr/0007-existing-passkey-assertions.md#item-selection) on top
of that search: enabled connections only, excluded sites, excluded and quarantined
items, the exact-origin site default as the tie-break, and no single-match choice while
a connection or eligible item could not be searched. Signing through it requires the
same settings revision, snapshot and item eligibility before and after the Worker signs.
Unit tests cover it with fake vault managers. Both builds register the bridge on every
top-level `https://*/*` document and answer it from this source; the probe build keeps
its test-vector key for `http://localhost` only. A probe-build Playwright test on
`https://synthetic.example.test`, served by request interception, connects the synthetic
Bitwarden account (fixture variant `passkey`, one login holding one zero-counter
passkey), gets an assertion signed in the crypto Worker and verified with the fixture's
public key, and gets the browser's own credential once the item is excluded. A
production-build test checks that the bridge is installed at document start there, that
no content script posts a message to the page, and that with no vault connected the
request goes to the browser. A claimed assertion from a vault passkey is tested only
through the probe build, which wraps the same vault source. The real-site and
real-account results are listed below, including a primary sign-in with a discoverable
passkey on `https://my.jcb.co.jp`; a navigation during signing relies on Chrome dropping
the response to the replaced document.
[Development](development.md#installed-chrome-synthetic-passkey-probe) describes the
installed-Chrome acceptance procedure. Page script can detect the wrapper and read the
extension ID from stack traces; the relay posts only the outcome of a request to the
page, never the delegate reason. The production build logs the reason and value-free
counts to its local log
([diagnosis](development.md#why-a-passkey-request-was-delegated)). On 2026-10-11 a real
passkey sign-in on webauthn.io went through the wrapper unchanged and CreepJS did not
flag it ([wrapper detectability](research/2026-10-11-passkey-wrapper-detectability.md)).
A page or provider wrapper that rebuilds the options before calling its saved `get` runs
once when it calls synchronously and at most four times otherwise
([ADR 0007](adr/0007-existing-passkey-assertions.md#bridge-topology)); before that
change one that replaced the challenge looped without end.

Evidence, 2026-10-10, synthetic relying party only:

- At main `2716b96`, the probe build passed steps 3 to 6 of that procedure in cloud
  Chromium 141.0.7390.37 with no other extension, loaded unpacked in a Playwright
  persistent context with `--headless=new`. Both buttons and the page-load request
  reported `Pateat, flags 0x1d, signature verified`; `/denied` reported
  `error NotAllowedError`.
- In the owner's Chrome 154.0.8037.98 with the official Bitwarden extension 2026.6.1,
  the request without a UV requirement reported a verified Pateat assertion, but the
  UV-required and page-load requests reported `error Error`. Bitwarden's page script
  had replaced `navigator.credentials.get` outside Pateat's wrapper. For the
  UV-required request it showed its "No passkeys found" window and, when that closed,
  rejected instead of falling back.
- The owner then chose to keep Pateat's wrapper outermost
  ([ADR 0007](adr/0007-existing-passkey-assertions.md#bridge-topology)). In cloud
  Chromium, a synthetic page script shaped like Bitwarden's (`/provider` on the
  synthetic relying party) reproduced `error Error` before that change; after it, both
  buttons returned Pateat assertions, also after the script restored its saved `get`,
  and an unclaimed request reached that script once. While the script held an unclaimed
  request, as Bitwarden's "Your vault is locked" window does, a new request still got a
  Pateat assertion and the held one ended with the script's own `Error`. A conditional
  request that the script passed on as a shallow copy reached it once, and a later
  modal request still got a Pateat assertion. Real-site testing must also check pages
  that wrap `get` themselves, which no longer see claimed requests.
- At main `5d0e1ac`, the probe build passed steps 3 to 6 in the owner's Chrome
  154.0.8037.98 on Windows 11 (Default profile) with the official Bitwarden extension
  2026.6.1. Both buttons and the page-load request reported `Pateat, flags 0x1d,
  signature verified`, with Bitwarden unlocked and again with it locked after a reload.
  No Bitwarden window appeared, and no request errored or stayed pending.

Evidence, 2026-10-11, real sites with the owner's real Bitwarden account: production
build at main `f7d3cf5`, the owner's Chrome 154.0.8037.98, the official Bitwarden
extension 2026.9.3, Bitwarden Cloud US.

- Setup connected the real account after a new-device verification code, and Sync
  succeeded ("Vault verified and local cache accepted.").
- `https://www.npmjs.com`: the site asks for the passkey as a second-factor security
  key. Bitwarden's autofill entered the username and password, and the security-key
  step then succeeded with no Chrome or Bitwarden window, which indicates Pateat signed
  it unattended.
- `https://my.jcb.co.jp`: about six passkeys for this RP ID are stored in separate login
  items and no site default was set, so Pateat delegated as designed and Bitwarden
  showed its own window. The options page's site-default account list did not filter by
  site, did not show usernames, and could not tell apart items with the same name, so
  the owner could not pick the right item; that is tracked as executor work.
- Not tested at this build: a primary sign-in with a discoverable (username-less)
  passkey. It passed later on `https://my.jcb.co.jp` (below).

Evidence, 2026-10-11, `https://my.jcb.co.jp` with a saved site default, in the owner's
Chrome 154.0.8037.98 with the official Bitwarden extension 2026.9.3 and the same real
account, production build at main `623dc39`:

- The first retry still delegated. The service-worker log (`Pateat passkey request`, see
  [Why a passkey request was delegated](development.md#why-a-passkey-request-was-delegated))
  showed `rpId: "my.jcb.co.jp"`, `allowCredentials: 0`, `stored: 5`, `accepted: 5`,
  `siteDefault: 0`, `siteDefaultItem: "unset"`, `reason: "ambiguous-credential"`. The
  default was in the options page's unsaved draft only; the page then had a separate
  save button, which is now gone (#160).
- After saving, the username-less primary sign-in succeeded with no Bitwarden or Windows
  window, so Pateat signed it with the default's passkey among the five.

Evidence, 2026-10-11, after the move to `@bitwarden/sdk-internal` `0.2.0-main.1099`
(#151), in the owner's Chrome with the same real account: on a production build at main
`9152fdb`, reloading the extension unlocked the vault automatically with no password and
Sync succeeded ("Local vault ready"). On main `59a2d12`, the `https://www.npmjs.com`
security-key step again succeeded unattended.

Evidence, 2026-10-11, a passkey-only site in the owner's Chrome with the same real
account, production build at main `6c2eda9`: on `https://accounts.pixiv.net`, "Log in
with passkey" with no ID entered (a username-less request). Two pixiv passkey items
matched and no site default was set, so Pateat delegated as designed and Bitwarden
showed its window. After the owner set and saved a site default for
`https://accounts.pixiv.net`, the retry logged in with no Bitwarden or Windows window
(11:48 UTC).

Evidence, 2026-10-11, the passkey chooser window and asking again after a logout
([ADR 0021](adr/0021-account-choice-outside-settings.md) parts C and D), in the owner's
Chrome with the official Bitwarden extension and the same real account, production build
at main `8581f1d`, on `https://accounts.pixiv.net` (two pixiv passkey items):

- With no site default, "Log in with passkey" with no ID opened Pateat's "Choose a
  passkey" window: "accounts.pixiv.net asks for a passkey. 2 in your vault match.", both
  items with their user names and the connection label, the "Use this account for
  accounts.pixiv.net from now on" box ticked, and "Use the browser or another
  extension". Bitwarden's window did not appear.
- Choosing one with the box ticked logged in, and `/manage/sites` then listed it as the
  default for `https://accounts.pixiv.net`. "Use the browser or another extension"
  opened Bitwarden's own window, which worked, and so did closing the window with its
  close button.
- After a Pateat sign-in and a logout in the same tab, the next "Log in with passkey"
  opened the window with "Pateat signed in to this site from this tab before", the
  default first as "Site default" and "Replace the default account for
  accounts.pixiv.net with this one" unticked. Choosing the other item logged in as that
  account.
- In a new tab, "Log in with passkey" logged in with no window. Which account it used
  was not recorded, so that the default stayed unchanged is by design, not observed.
- Waiting in the window failed: after about 30 s it closed and Bitwarden's window
  appeared by itself. The extension log shows the request `cancelled` at 16:58:32 UTC,
  the same second as the last recipe sync, which applied a default removed on
  `/manage` shortly before. That settings change cancelled the waiting request, and the
  page then handed it to the browser. Since then a settings change leaves the window
  open, and a wait that runs out fails the request with `NotAllowedError` instead of
  handing it to the browser (ADR 0021 part C).

Evidence, 2026-10-11 and 2026-10-12, after
[#232](https://github.com/risu729/pateat/pull/232), same Chrome, account and site, no
site default:

- Choosing after waiting about 30 s logged in (production build `b4c2ec1`, 02:15 UTC):
  `passkey.request` outcome `assertion`, chooser `chosen`. No sync landed while the
  window was open, so staying open across a sync is covered only by the Playwright test.
- Closing the window with its close button handed the request to the browser as
  designed (`b4c2ec1`, 02:12 UTC): outcome `delegate`, reason `chooser-closed`, chooser
  `closed`. Bitwarden's window and then Windows Security appeared, and cancelling them
  ended in pixiv's own error.
- Leaving the window unanswered (`b4c2ec1`, 02:35 UTC): exactly 2 minutes after the
  click, the window closed by itself with no Bitwarden or Windows prompt, and pixiv
  showed its own error, "Failed to log in with passkey. Please use a different method to
  log in." The log shows outcome `not-allowed`, chooser `timeout`. The origin had a
  site default by then, and the window still opened because of `signedBefore`: Pateat
  had signed in from that tab before (ADR 0021 part D).

## AI evaluation harness progress

`packages/inference` holds the first offline M4 slice. A proposed sanitized observation
contract (`packages/contracts/src/observation.ts`, for the extension extractor) carries
bounded, value-free element roles, locators and labels; incomplete observations are
rejected before inference. The generation/repair role uses AI SDK
structured output and the finite-choice role uses the SDK decision contract with an
explicit none option per question. Both resolve observation-local candidate IDs, check
slot/role compatibility, joint mapping uniqueness and same-form grouping, refuse secrets
in new-password fields except a sign-in form's lone one beside the identifier the plan
fills ([ADR 0018](adr/0018-recipe-generation-route.md#decision), owner decision of
2026-10-12), and apply the shared recipe step contract. They return explicit
ok, abstained or failed outcomes. Usage sums every attempt, including failed retries;
one attempt without reported usage makes the total unknown. Retries default to none and
are bounded; timeouts, caller cancellation and byte limits on the sent instructions,
input and output schema or questions are enforced locally (provider envelope overhead is
not counted). SDK telemetry is disabled per call so prompts, page text and outputs never
reach global integrations. The finite-choice state carries page context and the slots
(meanings plus any ADR 0010 hints); eligible elements appear solely as question options.

Per [ADR 0010](adr/0010-inference-field-hints.md), slots may name the allowed vault
field and give the coarse shape (length, character classes, email form) of a login
username or Text field value, and observations carry page `maxLength`, `minLength` and
`inputMode`. `checkPlanValues` checks a plan against the real values before filling and
turns a mismatch into a `value-mismatch` abstention; the harness applies it when a case
carries synthetic values. The executor applies the same check to the real inputs before
filling. Automatic generation sends the username's shape when every matching item agrees
([ADR 0016](adr/0016-recipe-generation-trigger.md#username-shape)), and custom fields as
`fieldName` offers, with `fieldPosition` for duplicate names and Text shapes under the
same rule ([ADR 0027](adr/0027-per-account-login-routes.md)). Their opaque request IDs
(`custom-1`) carry no meaning; the corpus's bank cases send theirs the same way, and the
model names each one it uses with a generic recipe slot ID. `valueShapeOf`
(`packages/contracts/src/values.ts`) takes `{ source: "username" | "text", value }`, so
a caller must resolve Linked fields and never pass Hidden, password or TOTP values.

For [ADR 0018](adr/0018-recipe-generation-route.md), `appendPageSteps` builds a
generated recipe one page at a time: the first page starts it at revision 1, and a later
page is appended only after a step that advances, within the contract's bounds. The
recipe's slots are the ones its steps fill. `createCompletionJudge` sends the page shown
after the final submission, with the login paths, and returns `signed-in` with a button
or link marker, `rejected` or `challenge`, or abstains when unclear. An unknown marker,
one that is not a button or link, or a page that still has a password input not marked
`new-password` or a field marked `username`, `current-password` or `one-time-code` fails
as `invalid-output`. `addCompletion` stores the marker as the recipe's `completion` in
the next revision. It refuses a marker that is not on the judged page, a page on another
origin, a marker one of the recipe's own steps uses on that path, and a page that still
shows an element a step uses on that path or a field any step fills. A failed sign-in
that shows the form again with the same locators, on its own path or where the form
posted, is then not learned as signed in. A site that signs in on the login page's own
path learns its completion only once that form is gone, and the completion then lists
that path's fill fields as `absent` (at most four), which the executor requires to be
missing. Both roles share `runStructuredRole` for metering, timeouts and disabled
telemetry. The service routes call them
([API README](../services/api/README.md#recipe-generation)), and the extension calls
those routes as described under the remaining M4 AI work below.

A 16-page synthetic Japanese/English corpus covers bank branch/account/password
(including an unlabeled page distinguishable only by length),
identifier-first and password steps, one-time codes, decoy search/sign-up/SSO controls,
label injection, unlabeled ambiguity and a page without a login form. The harness
reports semantic accuracy, false submits, abstentions, joint-mapping rejections,
errors, p50/p95 latency and usage. Fake-provider tests cover malformed output,
nonexistent targets, malformed probabilities, refusal, truncation, timeout, rate limits,
oversized and incomplete inputs and the absence of fallback.

[ADR 0014](adr/0014-claude-generation-provider.md) selects `claude-opus-5-5` at effort
`low` through `@ai-sdk/anthropic` for the generation/repair role; the finite-choice role
has no provider yet. `createClaudeGenerationModel` in
`packages/inference/src/providers/claude.ts` builds that model, and
`mise run //packages/inference:bench --paid` runs the generation role over the corpus
with the local value check. It stops before a case that could take the estimated
spend past `--max-cost-usd` (default 2) and still prints the cases already run, the
estimated cost and the model IDs the API reported serving. In cloud sessions the key is
provided as the environment variable `PATEAT_ANTHROPIC_API_KEY`, because the name
`ANTHROPIC_API_KEY` is withheld from sessions; run:

```sh
ANTHROPIC_API_KEY="$PATEAT_ANTHROPIC_API_KEY" mise run //packages/inference:bench --paid
```

The one owner-approved run (2026-10-10, main `29ab04c`, cap $2) gave:

| Measure | Result |
| --- | --- |
| Served models | `claude-opus-5-5` only |
| Verdicts (16 cases) | 13 correct, 2 correct abstentions, 0 missed, 0 false submits, 1 failed |
| Semantic accuracy | 0.9375 (15/16) |
| Abstentions | `ambiguous` 1 (`ja-unlabeled-ambiguous`), `no-login-form` 1 (`en-newsletter-only`) |
| Errors | `refused` 1 (`ja-bank-unlabeled-lengths`) |
| Joint-mapping rejections | 0 |
| Latency | p50 2,285 ms, p95 6,727 ms (one call per case, no retries) |
| Usage | 21,182 input and 1,146 output tokens over 16 calls |
| Estimated cost | $0.108 at $4/$20 per million (about $0.0067 per call) |

The one failure is a model refusal: the API ended the call with a refusal
(`finishReason` `content-filter`) on the unlabeled Japanese bank page that has only
`maxLength` 7/3/4 numeric fields. As ADR 0014 requires, there is no fallback model, so
such a page gets no generated recipe. Measured usage per call is well below the ADR
0014 estimate of about 3,000 input and 1,000 output tokens.

After that run the owner chose two changes and one more run of all 16 cases. The
generation instructions now open by saying that Pateat is a password manager, that the
credentials' owner asked it to sign in to their own account (the page may still not be a
login form), and that the model sees only the page structure and slot meanings while the
extension fills values locally. A `refused` outcome now carries `refusalCategory`, the
provider's refusal category code (for Claude, `stop_details.category`, such as `cyber`),
when it is a short code; free-text explanations are dropped. The benchmark lists it per
case.

The second owner-approved run (2026-10-10, main `d105f76`, cap $2) gave:

| Measure | Result |
| --- | --- |
| Served models | `claude-opus-5-5` only |
| Verdicts (16 cases) | 14 correct, 2 correct abstentions, 0 missed, 0 false submits, 0 failed |
| Semantic accuracy | 1.0 (16/16) |
| Abstentions | `ambiguous` 1 (`ja-unlabeled-ambiguous`), `no-login-form` 1 (`en-newsletter-only`) |
| Errors | none |
| Joint-mapping rejections | 0 |
| Latency | p50 2,129 ms, p95 4,746 ms (one call per case, no retries) |
| Usage | 22,798 input and 1,402 output tokens over 16 calls |
| Estimated cost | $0.119 at $4/$20 per million (about $0.0075 per call) |

`ja-bank-unlabeled-lengths` now maps all three fields correctly, and the cases that
must abstain still do. With one sample per case this cannot show that the refusal will
not recur; no refusal occurred, so no category was observed.

On 2026-10-12 the owner chose short, language-neutral instructions
([ADR 0014](adr/0014-claude-generation-provider.md)). The generation instructions went
from 3,106 to 1,298 characters and the judge's from 1,671 to 838, with each field's
meaning moved into the response format's descriptions (690 and 461 characters added
there). Rendered locally through `createClaudeGenerationModel` with a fake `fetch` for
the synthetic corpus case `ja-basic`, whose observation also stands in for the judged
page, the whole Claude request went from 6,217 to 5,099 characters (generation) and from
3,762 to 3,390 (judge), most of the rest being the page itself. Local tests check that
the instructions and response formats hold only ASCII text. No paid run has measured
the change yet; a corpus run needs the owner's approval.

Remaining M4 AI work:

- Login routes and second-factor pages chosen per account
  ([ADR 0027](adr/0027-per-account-login-routes.md)), approved by the owner on
  2026-10-11: custom-field names and Text shapes in generation, page handlers for a
  security key and TOTP learned by the judge, start-page routes (password variants,
  passkey, SSO), in the PR order the ADR lists. Delivery 1 is implemented: custom-field
  offers (Text, Hidden and Linked, by name and position) with Text shapes, generic slot
  IDs named by the model and returned as `customSlots`, the device-local generated slot
  map, bindings built from another item's saved binding or that map, and the `hidden`
  slot kind. Unit, service and extension runtime tests cover it with synthetic data; no
  paid generation call and no real-account login has used it yet, and its check on SMBC
  or PayPay Bank needs the owner's approval. Delivery 2 is implemented: item facts and
  the catalog `empty` flags, the `password` route and `no-route`, `passkey` handlers
  learned by the judge and run in the same login, the judging rules and limits
  (`page_judgements`), the bridge using the login's item, and no `totp` slot for start
  pages without a code field. Unit, service and extension runtime tests cover these with
  synthetic pages and fakes, and the 122 existing extension E2E specs pass; no E2E spec
  drives a security-key page, and nothing has run in real Chrome yet. Its real-Chrome
  check on npmjs.com's security-key page is still open. Delivery 3 part A is
  implemented: `password` route variants (the recipe's own slots and steps plus up to 3
  `alternatives`), the per-variant checks, the first fitting variant chosen once from
  the item's facts and recorded in the attempt, bindings per variant, start detection
  over every variant, generation of alternatives for identifier sets the start page
  shows at once, and the synthetic corpus case `ja-bank-two-identifier-sets`. Unit,
  service and extension runtime tests and one probe E2E spec (the second identifier set
  filled for an account that maps only that one) cover it with synthetic data; no paid
  generation call or real-account login has used it. An identifier set behind a tab, as
  SMBC's contract-number tab appears to be, is not generated. Delivery 3 part B is
  implemented: the start page's `passkey` route (one click on its passkey sign-in
  button), taken first for an item with a discoverable passkey, needing no binding,
  ending `challenge` for any result but `authenticated` and saving only the site
  default; the held click and the judge's rules for its button; and generation of the
  button as `passkeyButton`, with the corpus case `ja-myjcb` expecting it. Unit, service
  and extension runtime tests and three probe E2E specs (a discoverable passkey clicks
  the button, a reload that shows it again ends `challenge`, a second-factor passkey
  fills the password) cover it with a synthetic passkey fact; no WebAuthn exchange, paid
  generation call or real-account login has used it. Its real-Chrome check on MyJCB
  needs the paid regeneration listed in phase 1, with the owner's approval. Delivery 4
  is implemented: the `totp` handler (one code field and its button on a path), learned
  from a judge answer that names a code the page does not say was sent to the person or
  comes from another source (from an authenticator app or, since 2026-10-13, with no
  source said), in a single
  code field of at least 6 characters, or the first of 6 to 8 one-digit
  inputs, with a button of its form; entered when all its elements show and are usable,
  after a `passkey` handler shown with it, at most one code per login, filling the
  item's built-in TOTP field under the TOTP fill rule and clicking once after a 2-second
  watch; and a code page that submits by itself counts as the click and is held while it
  verifies. A judged completion is never a page of a handler's path that shows its code
  field, and generation maps a one-time-code slot only to an input the TOTP fill rule
  accepts. Unit, service and extension runtime tests and fourteen probe E2E specs (the
  code filled and verified, a wrong code ending `challenge` after one click, an item
  without TOTP leaving the field untouched, a page that submits on the last digit, three
  pages that verify their own submission for over a second: a new document, a status
  message with a disabled button and a form rendered again, and three ordinary pages
  clicked once: Verify disabled until the code is in, Verify rendered again on every
  digit and a digit counter, and a page that checks the code itself with Verify kept
  disabled, or disabled again after enabling it for a moment, signing in or held on a
  wrong code without a click) cover it with a synthetic TOTP fact and the fixed code
  `012345`; no paid judge call, real authenticator code or real-account login has used
  it. A binding that names a custom field for the code is deferred and ends `challenge`.
  Its real-Chrome checks are listed with the installed-Chrome checks of phase 1 (Resend)
  and phase 2 (npmjs.com). The one-digit inputs are typed one digit per input (owner
  decision, 2026-10-12 19:21 UTC, after Resend's code page stopped the login; Resend was
  then thought to split its code, but it has one input); six probe
  E2E specs (one Verify click, a page that submits on its last digit, Verify disabled
  until the code is in or only while it is partial, an input the page changes after the
  first digit and seven inputs for a six-digit code, both stopping without a click)
  cover it with the same synthetic fact.
- Continuing a generated recipe on the page after an `advance` step, through the
  generation route's `base`, is implemented
  ([ADR 0018](adr/0018-recipe-generation-route.md#continuing-after-an-advance)). A
  recipe that already holds the steps after the advance continues on another path, and
  since 2026-10-12 ([#252](https://github.com/risu729/pateat/pull/252)) on the same path
  once those steps' elements become ready
  ([architecture](architecture.md#background-execution)). Runtime tests and three probe
  E2E specs on `/identifier-first` (the password form shown in place, the same after a
  `history.pushState` that keeps the path, and a page that shows the password form from
  the start never continuing) and one on `/identifier-swap` (one button and a kept
  password input across a view swap) cover that with synthetic values only. A
  generated recipe that ends in an `advance` is continued too: after its final
  `advance`, a page that has loaded, shows a password, username or email input for a
  slot the recipe does not fill yet, and stays on one path for a second is sent once per
  step; the running login takes
  the continued revision over and runs its new steps, then the page after the submission
  is judged for `completion`, and the account choice saved after `authenticated` covers
  both pages' slots. A page that fills one of the recipe's slots again is refused by the
  extension and the service. Contract, inference, service, service-client and runtime
  unit tests and three probe E2E specs cover it with a local stand-in for Claude: an
  identifier form that shows its password form in the same document, and an identifier
  page whose Next opens the password page as a new document, each signing in after one
  Next and one Log in, sending the identifier page, the password page with its base and
  the signed-in page, never an input value (a page is sent as observed, so one that
  shows the identifier just entered sends it as page text; redacting the account's own
  username is planned in [phase 1](#phase-1-usable)), ending at revision 3 with a
  completion, and a second visit running all four steps with no model call; and an
  identifier form shown again where it posted, which is never continued. None of this
  has run in installed Chrome, with a paid generation call or on a real site; that check
  is listed with the phase 1 installed-Chrome checks.
- A different remembered account, approved by the owner on 2026-10-11: on a step that
  fills a secret but no username, the executor compares the account shown in that
  form and the page headings with the selected account's username, locally only. If
  they differ (`myaccount@example.com` shown while `my2@example.com` is selected), it
  fills nothing and stops with `wrong-account`. A masked value consistent with the
  username (`m***@example.com`) cannot be told apart and proceeds. The owner chose on
  2026-10-11 how the switch continues: the executor clicks the recipe's optional
  `accountSwitch` target once and ends the attempt, and the login continues with the
  recipe that starts on the page the switch leads to, generated there if none exists
  ([ADR 0016](adr/0016-recipe-generation-trigger.md)). The comparison, the stop, the
  switch click and the new attempt on the next page are implemented
  ([Background execution](architecture.md#background-execution)), and a page where no
  recipe starts is offered for generation (the service keeps one generated recipe per
  start path). The extractor locates a link by its text and the generation role may
  name the page's `accountSwitch`, so a generated recipe carries it
  ([Background execution](architecture.md#background-execution)).
- More Japanese pages. The owner chose on 2026-10-11 to take them from both public
  login pages opened in Chrome on the owner's PC and the request log; six public pages
  are in (below). Next, in a browser that can reach the sites (a cloud environment whose
  network access allows them, or the owner's PC): refresh the six with the current
  extractor, and observe more public login pages of banks, securities firms, card
  issuers, shops and telecom carriers, retrying the twelve that gave no or an incomplete
  observation. On 2026-10-11 the request log held one Japanese row, a MyJCB
  generation that abstained (`insufficient-evidence`) on an observation from before
  #206 with no login control, so it adds no case. The finite-choice provider waited
  for a Claude baseline, which now exists for both page sets.

The real-page corpus per ADR 0012 starts with
[Formasaurus](https://github.com/scrapinghub/Formasaurus) commit `4bb46a9`:
`mise run //packages/inference:corpus:formasaurus <absolute checkout path>` renders each
of its 954 annotated pages in Chromium with scripts off, meta refreshes removed, every
request but the saved document aborted and no host resolvable, observes it with
`extractLoginObservation` and labels the observation from the Formasaurus annotations.
`packages/inference/src/corpus/formasaurus.json` keeps only the derived observations,
labels and the source page name. Each case sends the slots the extension sends for an
item with a username and a password (`builtInLoginSlots` in `packages/contracts`). The
ground truth is the page's single login form: its username, email or "username or email"
field, its password field and its one submit control. A page the extension would send
(it has a password field, or a field marked `username` or `one-time-code`) without a
login form, such as a sign-up page, must abstain. A page is left out when its truth is
unclear: several login forms, a password field in an unannotated form or outside any
form, any field in an unannotated form or outside a form on a page without a login form,
another field in the login form (a captcha or a security code), a password-only form, a
form without one clear submit control, or annotations that do not line up with the
parsed forms.

Before publishing, every case was reviewed for personal data (2026-10-11, by an
independent review agent and the importer's author). Held back: a private person's
homepage, a forum for cashing out stolen funds, and a page whose path carried an encoded
session ID (Magento's `/referer/<base64>/`); the importer now skips long opaque path
segments. The corpus holds 113 plans and 18 abstentions. Three cases are Japanese (two
from `buyee.jp`, one from `zeiri4.com`); `language` comes from the extractor's script
heuristic, which also marks one Chinese page `ja` and every other non-Japanese page
`en`. The owner chose on 2026-10-11 to publish the derived page text (titles, headings
and labels) as is, with the attribution in
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md). Some sites appear twice with the
same login form. It was regenerated on 2026-10-11 with the extractor of main `84df607`,
which locates links by their text (#184) and observes script buttons (#206); the first
import used an extractor from before #184. The cases, their plans and their abstentions
are unchanged. The observations gained 132 links that only their text can locate, which
the probe now resolves among links as the executor does; candidate IDs shifted with
them. The 132 link texts were reviewed for personal data and hold none. It was
regenerated again on 2026-10-11 with main `e48b4e7`: judging completeness by the login
form (#211) made 36 more pages complete cases, observing script links as buttons (#226)
gave one more login form (formasaurus-33) its submit control, and the stricter path rule
(#214) now refuses formasaurus-836, whose path carries a base64 segment. In 11 earlier
cases links became buttons; in formasaurus-799 and -848 newly observed script buttons
shifted candidate IDs, and 848's label was renumbered to the same controls. No earlier
label changed its meaning. The 37 new cases and the changed observations were reviewed
for personal data by an independent review agent and hold none.
`mise run //packages/inference:bench --paid --corpus real` runs the Claude benchmark on
it; `--from` and `--count` run a slice of the corpus in its fixed order, so it can be
run in batches. Each case in the report carries the plan in candidate IDs.

`--provider heuristic` scores a free, model-free comparator (`heuristicPlan` in
`packages/inference/src/heuristic.ts`, not used at runtime): the one form with a single
sign-in password, its `username` or `email` field or else the nearest field before the
password that an identifier may fill and that is not marked as a one-time code, and
its first button after the password, or else its first button. Without such a form,
the one form whose only fill field is marked `username` or `email` advances. It reads no
labels, and its inputs pass the same schema and completeness gate as generation. On
2026-10-11 it scored 0.958 on the 95 cases before the `e48b4e7` regeneration and, on the
current corpus before the ADR 0027 slot re-keying:

| Corpus | Correct | Correct abstentions | Missed | False submits | Semantic accuracy |
| --- | --- | --- | --- | --- | --- |
| Real pages (131) | 109 | 14 | 1 | 7 | 0.939 |
| Synthetic (16) | 7 | 2 | 2 | 5 | 0.5625 |

Its real-page false submits are four sign-up pages with a single password field, which
it takes for a login (formasaurus-35, -62, -140 and -407), and three login forms where
it presses the wrong button: "create account" (formasaurus-216 and -739) or "Mégsem"
(cancel, formasaurus-254). It misses formasaurus-275, whose sign-in and registration
forms each hold one password. The real-page corpus is mostly plain username and password
forms, which form heuristics already handle; the synthetic corpus holds the bank, decoy
and multi-step pages where they fail.

Since the ADR 0027 slot re-keying, the bank cases offer their branch and account number
fields as `custom-1` and `custom-2` with field names, as the extension sends them, in
place of the descriptive slot IDs `branch-number` and `account-number`. The heuristic
names no custom slot, so it fails those cases with `missing-slot-name` instead of
filling the wrong field. Measured on 2026-10-11 at `1ddf138` (the ADR 0027 delivery 1
branch):

| Corpus | Correct | Correct abstentions | Missed | False submits | Failed | Semantic accuracy |
| --- | --- | --- | --- | --- | --- | --- |
| Real pages (131) | 109 | 14 | 1 | 7 | 0 | 0.939 |
| Synthetic (16) | 7 | 2 | 2 | 3 | 2 | 0.5625 |

The two failed synthetic cases are `ja-bank-branch-account` and
`ja-bank-unlabeled-lengths`, which were false submits before.

The owner approved the Claude baseline on this corpus on 2026-10-11, to run about five
cases at a time with fixes between batches, once the MyJCB generation fix (#206) was in.
It first ran on main `c409d0a` in 19 batches of five and scored 95/95 ($0.808). After
the `e48b4e7` regeneration it ran again on the 131 cases in 27 batches (26 of five and
one of one, `--from 0 --count 5` through `--from 130`, cap $0.50 each). No batch had a
wrong case, so nothing was changed between batches:

| Measure | Result |
| --- | --- |
| Served models | `claude-opus-5-5` only (effort `low`) |
| Verdicts (131 cases) | 113 correct, 18 correct abstentions, 0 missed, 0 false submits, 0 failed |
| Semantic accuracy | 1.0 (131/131) |
| Abstentions | `no-login-form` 18 |
| Errors | none |
| Latency | p50 2,011 ms, p95 3,751 ms (one call per case, no retries) |
| Usage | 232,382 input and 9,494 output tokens over 131 calls |
| Estimated cost | $1.119 at $4/$20 per million (about $0.0085 per call) |

Claude gets right the eight pages the heuristic gets wrong: it abstains on the four
single-password sign-up pages, picks the sign-in button on the three wrong-button pages
and maps formasaurus-275. On this corpus the model's margin over the heuristic is those
eight pages (accuracy 1.0 against 0.939); on the
synthetic corpus it is 16 against 9 of 16. A page set like this one, mostly plain
forms, cannot tell a finite-choice model apart from Claude; the synthetic and Japanese
pages carry that comparison.

Japanese pages are in `packages/inference/src/corpus/japanese.json`
(`--corpus japanese`). On 2026-10-11 a session on the owner's PC loaded 18 public
Japanese login pages with Playwright in the installed Chrome, one empty browser context
per page (no profile, cookies or account, locale `ja-JP`), and observed each with the
probe from main `9ac17c4`; the six usable pages were observed again with main `e48b4e7`.
Nothing was typed or clicked. Nine gave no observation: MUFG
rendered no field, Japan Post Bank showed a service-unavailable page, Monex, SMBC Card
and Eki-net answered 403, Yahoo! JAPAN redirected to a captcha, Yodobashi failed with an
HTTP/2 error, au ID landed on a 404 page and Mercari showed only a reCAPTCHA frame.
Three gave incomplete observations, which inference rejects without a call: SBI
Securities (its top page, not a login form), niconico and pixiv. The six complete ones
are the cases. Each keeps the observation, its label and the page's origin and path,
with no query; the page text holds no account or personal data (reviewed 2026-10-11).
PayPay Bank and SMBC send branch and account number custom fields and a password, as the
synthetic bank case does; the others send the username and password slots. SMBC's
login control is `<a href="javascript:;" onclick=...>`, and MyJCB's script sets
`href="#"` on its `onclick` link at load. The first observation saw both as links, so
both were labelled abstain; Claude then named the link, which the plan check rejects as
`incompatible-role` (4 of 6, $0.089 with a rerun that recorded the reason, which each
failed case now reports as `detail`). Since #226 both are script buttons and both pages
are labelled plans. Measured before the ADR 0027 slot re-keying:

| Case | Expected | Heuristic | Claude |
| --- | --- | --- | --- |
| SMBC Direct (bank fields) | submit with "ログイン" | false submit (branch number in the account number field, software keyboard button) | correct |
| Mizuho Direct | `advance` after the customer number | missed | correct |
| docomo SMTB Net Bank | submit | correct | correct |
| PayPay Bank (bank fields) | submit | false submit (branch number in the account number field, password-reset button) | correct |
| Rakuten Securities | submit, not "クリア" | correct | correct |
| MyJCB | submit, not the passkey button | correct | correct |

The heuristic scored 3 of 6 with 2 false submits. Claude (`claude-opus-5-5`, effort
`low`, this corpus on main `e48b4e7`, one batch, $0.061 for 6 calls) scored 6 of 6.

After the re-keying (2026-10-11, `1ddf138`) the heuristic scores 3 correct, 1 missed
(Mizuho Direct), 0 false submits and 2 failed with `missing-slot-name` (`ja-smbc-direct`
and `ja-paypay-bank`), accuracy 0.5. The Claude results on this corpus and on the
synthetic corpus were measured with the old descriptive slot IDs; a Claude rerun on the
bank cases is a paid run and needs the owner's approval.

`mise run //packages/inference:corpus:japanese` repeats the observation of the Japanese
pages in Playwright's Chromium, or in another browser named with `--chromium <path>`
such as the installed Chrome. `--refresh` observes each case's page again and moves its
label to the new observation by the role and locator of each labelled candidate. A case
keeps its old observation and is reported for a person to relabel when the new one is of
another path, is incomplete, shows other fields to fill, or lacks a labelled control or
has it in another role. Listed URLs are observed into a local report for labelling by
hand. Each case records the date and the commit of its observation, and refreshed page
text is reviewed for personal data again before it is committed. A cloud session on
2026-10-15 reached none of the pages: the cloud environment's network policy refused
every site (`ERR_TUNNEL_CONNECTION_FAILED`), so the six pages of 2026-10-11 are still
the corpus.

The same import measured the extractor on real markup (2026-10-11, main `9cf8356`). Of
the 241 pages with an annotated login form, 6 gave no observation and 109 an incomplete
one, which inference rejects without a call; 126 were complete. These totals were the
same on main `84df607`. In 62 of the 109, the
only shown select, radio button, text area or other unsupported input was outside the
login form, for example a search form's category select. In 42 none was shown, so a
control without a unique `id`, `name` or `data-testid` is the likely cause (inferred,
not measured). The saved pages have no stylesheets, so elements a live page hides may
count here. At `9cf8356` the extractor refused only `;jsessionid=` and ASP.NET session
segments, not other session IDs in a path such as Magento's `/referer/<base64>/`; #214
added the rule below, and the `e48b4e7` regeneration above reflects it and #211.

`extractLoginObservation` (`apps/extension/src/observation/extract.ts`) builds a
`LoginObservation` from a page's DOM for recipe generation. It reads element types,
locators, labels, placeholders, descriptions, `autocomplete` (the sign-in tokens, `off`,
and the personal-data tokens that mark a sign-up form) and declared input constraints,
plus the title and visible `h1`-`h3`. It never reads input values, hidden inputs or
query strings. Since 2026-10-16 it sends a path that may carry a session ID or another
token with each such segment as `[id]`, as every observed page does
([ADR 0039](adr/0039-redacted-token-path-segments.md)); until then it refused it. Such a
segment is one, percent-decoded, with a matrix parameter such as `;jsessionid=`, an
ASP.NET part such as `(S(...))`, a query (`?`, `&` or `=`, as in Magento's
base64-encoded `/referer/<URL with ?SID=...>/`), a UUID, a run of 16 or more letters and
digits that contains a digit, or a base64url-like run of 16 or more letters, digits, `-`
and `_` that contains a digit and switches case or between letters and digits often.
Each segment is checked as it is and percent-decoded up to three times.
`extractSignedInObservation` replaces the same segments. The rule is a heuristic: it
misses tokens shorter than 16 characters and some plain-looking ones, and it also
replaces segments that carry no session, such as Microsoft Entra tenant IDs
(`/<tenant UUID>/oauth2/v2.0/authorize`), mixed-case Azure AD B2C policy names such as
`B2C_1A_SignUpOrSignIn`, Okta authorization server IDs and long numeric IDs; until
2026-10-16 generation was not offered there. On the Formasaurus pages of the real-page
corpus it refused 10 of 954 paths (2026-10-11). Label text is rendered text only:
scripts, styles, `<noscript>`, SVG, hidden elements and select or text area contents
never contribute. Only forms that hold a field count, or every control outside a form
when a field is outside one. In those forms the candidates are visible text, email, tel,
number and password inputs, checkboxes, buttons (disabled ones too, since many enable
after typing), script links (an `<a>` without `href` that has an `onclick` attribute or
`role="button"`, or an `<a href>` with a `javascript:` URL or with an empty or
fragment-only `href` and an `onclick` attribute or `role="button"`) as buttons, other
elements with `role="button"` that have an `id`, `name` or `data-testid`, or in a login
form or beside a password form a unique text (as
[architecture](architecture.md#declarative-recipes-and-ai) describes) and, as context
only, links. Up to four buttons outside every form are also kept as optional candidates
when they sit anywhere inside the element two levels above a login form with a password
field (never the body or the root element, never in a header or navigation landmark),
such as SBI Securities' "パスキー認証でログイン" button beside its password form; more
than four are left out as page content. On the 954 Formasaurus pages (2026-10-12) this
added 36 buttons on 33 pages, mostly social sign-in, registration and font-size buttons.
No page's completeness changed, apart from one page whose completeness differs between
runs with and without the change. Script links with `href` were added after observing
public Japanese login pages on 2026-10-11 showed the login buttons of MyJCB (`href="#"`)
and SMBC Direct (`href="javascript:;"`) as links, which generation cannot name as the
page action. On the 954 Formasaurus pages of the real-page corpus (2026-10-11) this
turned 371 candidates on 121 pages, 32 of them login pages, into buttons, mostly from
links; no page's completeness changed, and five pages that are not login pages lost some
context links to the 48-candidate limit or to shared text. Hidden, collapsed,
`aria-hidden` and before-the-page-start inputs are skipped as likely traps; a
transparent (opacity 0, also through an ancestor) or tiny field makes the form
incomplete. Since 2026-10-17 an element transparent only because it or each transparent
ancestor has a running or paused CSS animation, CSS transition or script animation that
still takes its opacity above 0 later in its current iteration, in the direction it
plays (one still in its delay from the iteration's start), counts as opaque, wherever
the content script reads whether an element is shown (fields, buttons and their text,
lists of accounts, sign-in entries and the signed-in page). An input at opacity 0 with
no such animation stays transparent, as does one under an animation that holds the
opacity at 0 for the rest of its iteration (a fade-out that then holds, a carousel's
slide hidden until its next cycle) or finished at 0. Labels come from
`aria-labelledby`, `aria-label`, `<label>`, the text next to a field (the preceding
table cell, `<dt>` or sibling, at most three levels up, never across another control or
its label), then `title`; image `alt` names buttons, including `<input type="image">`. A
text, email, tel, number or password field also gets a `description`: the rendered text
of the elements its `aria-describedby` names, such as `半角数字3桁` under a branch
number field, left out when it equals the label. Error messages can echo what the user
typed, so a field marked `aria-invalid="true"` gets no description, and neither an
element the field's `aria-errormessage` names nor the text of an alert, status or other
live region, around the description or inside it, ever counts. An error message with
none of these marks is still read. The description reaches the generation, finite-choice
and completion roles as untrusted page text, like labels. The owner chose on 2026-10-12
to add only this now and to consider the rest only if field or button mapping gets worse
on real pages. Not observed today: text after a field that no `aria-describedby` names
(a hint printed under an input), a second label source once one is found (the text next
to a field when a `<label>` exists), text around a button (a line above a passkey
button, or which `h1`-`h3` heading a button sits under) and a button's
`aria-describedby`, the `pattern` attribute, and whether a button is disabled. Whatever
the model saw, the executor still checks a field's `maxlength` and `minlength` before it
fills and the browser's validation, `pattern` included, before it clicks. Text is
redacted as [architecture](architecture.md#declarative-recipes-and-ai) describes. Each
target is the first of `id`, `name` and `data-testid` that matches exactly one element,
as the executor resolves it, skipping an `id` React's `useId` generated and trying one
holding a random-looking run or Mantine's `mantine-` prefix (2026-10-13) last, and for
an input without one, its first `autocomplete` token that is `username`, `email`,
`current-password`, `one-time-code` or `webauthn` and that no other input carries, then
its visible name when no other shown fillable input has it, before such an `id`
([ADR 0037](adr/0037-fields-by-visible-name.md)); a button without one gets a text
locator when its text matches exactly one button and redaction leaves it unchanged, and
a script link when its text matches no button and exactly one script link. In a login
form, a field, button or checkbox without a target, a control the executor cannot act on
(a select, radio, text area, another input type, or a read-only, disabled, transparent
or tiny field) or a control in a shadow root makes the observation incomplete, as do
more than 48 candidates, so inference rejects it; a page without a field, or where
nothing in a login form can be located or acted on, is refused. The login forms are
those with one password field that is not `new-password`, or with a `username` or
`one-time-code` field, as ADR 0016 detects a login; failing that, any with a password
field; otherwise every form that holds a field. Any other form with such a control, such
as a search form with a category select or a sign-up form with a birth-date select, is
left out entirely, so every form the observation describes is complete. On the 233
observed Formasaurus login pages of the real-page corpus (2026-10-11), this cut the
incomplete ones from 108 to 52: 55 became complete, each still showing the form
Formasaurus labels as the login form, and one whose login form has no locatable control
now gives no observation. A field in any open shadow root marks it incomplete too, as it
may be the real login. Links are context only: the plan check accepts only a button as
the page action. Known limits: a read-only username shown again on a password step makes
that step incomplete, and honeypot inputs moved to the right or clipped by
`overflow: hidden` stay candidates. `extractSignedInObservation` describes the page
after a generated recipe's final submission the same way, but over the whole page: every
field, then buttons and links up to 48 candidates, listed in document order. A field it
cannot describe marks it incomplete, except a read-only, transparent or tiny field that
does not look like a sign-in field, which is left out since 2026-10-12: the page after
アパホテル's login was logged as `unfillable-field` and never judged, and a read-only
date picker of its hotel search is the inferred cause. In the owner's Chrome on
2026-10-12 (06:17 UTC) the page after the login was then judged `signed-in` with the
ログアウト button as its marker. A disabled field that does not look like a sign-in
field is left out too since 2026-10-12 (22:03 UTC), but such a page completes only on
`signed-in` ([ADR 0029](adr/0029-local-sign-in-state.md)): Q-move's signed-in page was
logged `disabled-field` and never judged. Buttons and links past the limit or without a
locator are left out, since they are only possible sign-in markers. Links are located by
their text too, and those in a page header or navigation, where account menus usually
sit, are kept first; the rank reads only the page's structure, never words of one
language. A text locator with a digit, such as a points balance or an unread count,
never names a marker there, and the judge is told that the marker must show on every
signed-in visit of every account, and that a marker located by its text keeps that text
in the recipe, so it must read the same everywhere, never the person's name, a count or
a balance. A marker located by `id` stores no text: on リクルートID (2026-10-12, 08:07
UTC) the judge named the points balance `{"by":"id","value":"total-point1"}`, which the
earlier wording forbade although nothing private is stored, so the rule now names text
targets only. On ポイントインカム (2026-10-12) the page after sign-in gave 21
candidates, all carousel controls, news tabs and an ad's close button, because its
header links have no `id`; the judge answered `unclear`. A synthetic page of that shape
now keeps the header's links. There, an attribute locator that redaction would change
counts as no locator, so an account number in an `id` is never sent.
`mise run //apps/extension:test:dom` covers these cases in Chromium with synthetic
pages.

Evaluation data candidates, checked 2026-10-10 (terms are as published by each
source; confirm before use):

| Source                                                                                                           | Contents                                                                         | Use                                                            |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [Formasaurus](https://github.com/scrapinghub/Formasaurus)                                                        | 954 real pages, 274 login forms labeled by field type; 4 Japanese pages          | Derived observations with attribution (code MIT; page HTML unclear) |
| [SSO-Monitor](https://sso-monitor.me)                                                                            | Login-page URLs and SSO elements for top sites                                   | Seed URLs for capture                                          |
| [Chromium form classification tests](https://source.chromium.org/chromium/chromium/src/+/main:components/test/data/password_manager/form_classification_tests/) | 96 sign-in and 112 sign-up site scripts from 2016 with password selectors | Seed URLs (BSD); sites may have changed                        |
| [WebUI](https://huggingface.co/datasets/biglab/webui-all)                                                        | About 400,000 pages with accessibility trees and screenshots; no login labels    | Private evaluation only (research terms)                       |
| [Phish360](https://web.cs.hacettepe.edu.tr/~selman/phish360-dataset/)                                            | 10,748 samples incl. legitimate login pages in 27 languages; no field labels     | Private evaluation only; request form                          |
| PILWD-134K                                                                                                       | Legitimate and phishing login pages, 2019-2020                                   | Private evaluation only; institutional request                 |

No public source has meaningful Japanese or bank branch/account coverage, so those
pages come from the request log and the owner's Chrome. Reusing per-site recipes from
[Bitwarden map-the-web](https://github.com/bitwarden/map-the-web) (GPL-3.0, 32 hosts),
[Apple password-manager-resources](https://github.com/apple/password-manager-resources)
(MIT, shared credential backends) or
[2fa.directory](https://github.com/2factorauth/twofactorauth) (MIT) is later scope.

## Initial delivery and later scope

The [architecture](architecture.md) owns the product contracts. These boundaries
order delivery; deferred capabilities remain product scope, without requiring
their implementation in M1-M6.

Initial delivery includes multiple vault connections, connection/item/field/site
policies, saved site account defaults, cached-recipe execution, Bitwarden
password/custom-field/TOTP use, and existing zero-counter software passkey assertions.
The first server configuration uses Cloudflare Access, server-readable private settings
sync and server-side AI. Per [ADR 0013](adr/0013-service-held-recipes-and-settings.md),
the service is the source of truth for settings, recipes and account bindings, which are
edited on its web UI; the extension keeps a last-known-good cache and only the pages
that handle local secrets. Running without the service is planned for
[phase 3](#phase-3-public-release). On 2026-10-11 the
owner added account choice outside the settings page to initial delivery
([ADR 0021](adr/0021-account-choice-outside-settings.md)): a toolbar popup for the
current site's default and exclusion, choosing among several password matches there
(once or as the default), a passkey chooser window, and choosing again after a logout in
the same tab. They land as separate PRs in that order. The toolbar popup is implemented:
clicking the icon opens `popup.html` for the active HTTP(S) tab, whose "Pateat on this
site" switch shows whether the site is excluded and which lists the vault items that
match its origin as the default account. A rule that includes subdomains is shown but
changed only in settings, because it also covers other sites. On 2026-10-11 the popup
opened in installed Chrome on the production build of `8581f1d` and, on
`https://example.com`, showed the site, its exclusion button and the default account
section. Text without a size of its own was 12px there, smaller
than the notes, because Chrome gives extension pages a body rule with
`font-size: 75%` and its own font family. The shared stylesheet now sets the body to
`1rem` and the stylesheet's font family on every extension page; that fix is tested in
Playwright Chromium only.

When several items match a page and no default is saved, the refused document is
recorded and the tab's icon shows the count as a badge. The popup then lists only those
candidates. The waiting choice and a pick are kept in `chrome.storage.session`
(`pateat.login-choices.v1`, `pateat.login-picks.v1`), so a restarted service worker asks
the refused document to announce again and offers the same choice, or clears the badge
when the document is gone. A default saved for the site meanwhile ends the choice. The
background sends `login.reconnect` to the refused document only and answers the popup
once that document's announce is handled. A pick applies to that document and then to
the attempt it started, wins over a saved default there, and still has to match the page
and pass every policy check; a pick that starts nothing is dropped, so the form's next
appearance asks again. "Make it the default for this site" (on by default, off in a
private window) saves the pick through the existing choice save after `authenticated`;
it replaces another saved default only when the user picked it. The passkey chooser
window is implemented: a request matching several passkeys, none of them the site
default, opens `passkey-picker.html` to choose one once or as the default. After Pateat
signed for an RP ID in a tab, a username-less request for it there opens the window even
for one match or a default (part D, passkeys).

Choosing again after a logout (part D, passwords) is built. After a login in a tab ended
as `authenticated`, or `blocked` with `credential-rejected`, `wrong-account`,
`left-origin` or `interrupted`, a page of that origin in the tab's top frame answers
`logged-in` with the first steps to watch, and the content script keeps watching, also
in the document that logged in once its status reports the end; there a form that is
still showing does not count until it shows again. When a first step then shows, the
tab's record for that origin is released and the tab asks with reason `logged-out`: the
badge and popup list the saved default first and every URI match, even a single one. The
tab and origin are kept in `pateat.login-logouts.v1` in `chrome.storage.session`, so a
reload or a restarted worker asks again until a pick logs in. Since 2026-10-12, when one
account is to be used (the saved default or the only match), each such document is first
filled once without pressing anything, and then asks; filled documents are kept in
`pateat.login-logout-fills.v1` so a restarted worker does not fill them again. Another
tab's record that still holds the site (running, or ended without success in a way that
still holds, such as a refused password; 2026-10-12) blocks it with `origin-busy`, and
the tab's tooltip says so; while that tab keeps its logout state, other tabs of the site
that show a first step ask (and are filled) as well (2026-10-11). If the URI matches
cannot be listed, the saved default alone is offered. A login whose result is still
`reconciling` is resumed, not taken as a logout. Since 2026-10-12 a tab whose own login
stopped after a submission asks the same way, in that tab only, once a later page shows
the login form after the record's 5-minute hold on other tabs has ended
(`pateat.login-stopped-asks.v1`). Since 2026-10-13 (owner, after Oracle Cloud and Sony
Bank) a watched login (ADR 0027) whose first step shows again never signed in, so it is
no logout: it ends `challenge-abandoned` or `watch-abandoned`, only its tab asks that
way, and the site's other tabs log in (local tests only). Since 2026-10-13 a tab asks at
once, on any path, without filling that page again, when the site answers the password
submission with its sign-in form again (its password input and no other sign, even when
the result stays unknown) or the login ends `credential-rejected`; its record is
released then, so other tabs of the site ask instead of being held, and the badge and
popup say the site did not accept the login (`pateat.login-rejected-asks.v1`). Frame
logins and sites whose logout page shows only a password step are not detected. By the
owner's constraint (2026-10-12) a session that only expired never needs a manual press,
so a logout of a session carried over from another tab's login or an earlier browser
session is not detected by the form alone. Since 2026-10-16 (owner, after
dash.cloudflare.com) a click on a control whose name or nearby text says log out makes
the tab's next first step of that site within 10 minutes ask the same way
(`pateat.login-logout-clicks.v1`, ADR 0021 D); otherwise Pateat logs in again there.

Later work includes independently permitted vault create/update operations, nonzero
passkey counter writeback and passkey creation; Bitwarden provider login with passkeys,
API keys, SSO or device approval; signing in to sites through an identity provider
(policy in ADR 0026); external email/SMS OTP and magic links; and separately authorized
post-login actions, including transactions and approvals. UI extensions, automatic
account switching (logging out and in again when another account is picked while logged
in, recorded in ADR 0021), recipe sharing, additional service auth, E2EE settings
sync, MCP, Vaultwarden support and vaults other than Bitwarden are also deferred. They
are extension points, not implicit permissions or initial acceptance requirements. A
mode without the service and direct AI are planned for
[phase 3](#phase-3-public-release); the [roadmap](#roadmap) says which of these deferred
items become issues.

## Ordered milestones

| Milestone                                     | Deliverable                                                                                              | Acceptance evidence                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0: Documentation bootstrap                   | Empty main root, repository settings, this docs PR                                                       | Empty tree/root verified; rules read back; independent docs review. Owner merges separately                                                                                                                                    |
| M1: Tooling and runtime probes                | WXT skeleton, shared Valibot contracts, mise/hk, mandatory CI                                            | Frozen installation; full checks; packaged extension build; early injection/background execution in isolated Chromium and a small installed-Chrome/Chrome-use dummy-page coexistence probe; compatible cf/Workers test harness |
| M2: Local login engine and settings           | Dummy vault adapter, settings page, multi-connection policies, saved site defaults, declarative executor | Multi-field/multi-page fixtures; policy precedence, excluded-site pass-through, background, navigation, interruption and concurrency tests; no automatic extension UI                                                          |
| M3: Bitwarden passwords                       | First real adapter, local sync/crypto, persistent unlock, custom fields and TOTP                         | Synthetic protocol/crypto vectors; supported environment/authentication and TOTP cases below; restart/unlock; no vault writes; explicit unsupported cases; controlled account test only when authorized                        |
| M4: Private settings/recipe service and AI    | Worker+D1, Access-session pairing, settings/recipe/binding sync and web UI, Claude generation adapter (ADR 0014) | Owner/device isolation, revocation, redaction, offline cache, revision conflicts, malformed AI output, bounded complete inputs, explicit abstention, retry and monthly spend-stop tests; benchmark report |
| M5: Existing software passkeys                | Request bridge and Bitwarden-backed zero-counter assertion capability                                    | Standards/wire vectors, RP ID and cancellation tests, configured UV/UP policy, controlled interoperability; reject nonzero counters; no registration                                                                             |
| M6: Integrated acceptance and server delivery | Chrome use coexistence, operational docs, hosted service release                                         | Installed Chrome dummy-account tests plus artifact-verified deployment and hosted synthetic smoke checks; measured limits documented                                                                                           |

M1's small cf compatibility probe may precede a backend skeleton; it must not
provision resources. M2 starts with a dummy adapter so login correctness does not
depend on account secrets. Bring the WebAuthn document-start probe forward into
M1; defer full signing to M5. Each milestone can be several focused PRs.

### Library decisions before implementation

[ADR 0004](adr/0004-library-composition.md) and the
[candidate comparison](development.md#dependency-policy) distinguish approved
choices from pending recommendations. Ask the owner to decide each major addition
or replacement after presenting its purpose, alternatives and tradeoffs. Do not
infer adoption approval from a research or plan-update request.

Approved M2 slice: migrate the settings page to React, Tailwind + Base UI with
selected shadcn/ui components, and TanStack Form + Valibot. Pin compatible versions
with WXT/Vite, verify MV3 CSP and emitted bundles, and retain draft preservation,
revision conflicts, validation and keyboard/focus behavior. Keep UI dependencies
out of the background worker and content scripts. Add the approved Vitest Browser
Mode with `vitest-browser-react`, `@axe-core/playwright` and Knip to the existing
test stack. Keep real-extension Playwright tests and manual keyboard/focus checks;
configure WXT entrypoints before acting on Knip findings. Use the approved fast-check
for policy invariants, state transitions and controlled async-ordering tests.

Also approved for M2: TanStack Query for metadata loading/mutations and
`@webext-core/messaging` for extension communication. The library carries the messages
to the background; the background's sends to a tab's document, Ports and page messages
stay raw (owner decision, 2026-10-13;
[development](development.md#dependency-policy)). Keep dirty form drafts
separate from refreshed data, configure retry/refetch behavior explicitly and
retain runtime payload/sender authorization. Use the approved XState for the M2
executor; verify navigation cancellation, timeout handling and interrupted-submit
reconciliation before expanding execution. Persist allowlisted resumable metadata
only; restoring state must not blindly replay submission. Every Pateat record in
`storage.local` and `storage.session`, including the login runtime's, is read and
written through WXT storage; `storage.local` is restricted to trusted contexts before
any read or write, and the existing single-writer revision checks and fail-closed
handling of corrupt settings stay in Pateat's code.

Approved for M4: Hono and Drizzle for the first substantive API/schema. Keep
Valibot boundary validation, verify generated SQL and migrations, and test owner
isolation, conditional revision writes and D1 batch behavior. Neither dependency
automatically supplies those application guarantees.

Selected for M3/M5 under delegated maintenance review: OTPAuth for standard TOTP
and URI handling, and tldts for public/private suffix information after WHATWG URL
normalization. Verify Bitwarden parameters/Steam format and destination/RP policy
separately; neither library approval expands the supported protocol scope.
Approved for M4: AI SDK with Valibot for supported generation APIs. Preserve
role-specific decision adapters, explicit retry/timeout limits, redacted diagnostics
and usage accounting. This selects transport tooling, not an inference provider.

Potential integration points, subject to those decisions, are M2 settings UI,
forms, async state, attempt lifecycle and verification; M3/M5 protocol libraries;
and M4 service/database and inference transport. Once a choice is approved, record
it and add the concrete integration slice with compatibility and regression gates.
Until then, continue independent work without installing the candidate or making
the current plan depend on it.

M3 initially targets Bitwarden Cloud US/EU and official self-hosted servers at
ordinary HTTPS URLs. Use email/master-password authentication, with human-entered
two-step/new-device verification in settings. Probe individual MFA methods before
claiming compatibility. This provider setup is separate from website OTP
automation. Preserve supported Bitwarden TOTP forms, including raw Base32,
`otpauth://totp/` parameters and Steam form; verify algorithms, digits, periods
and clock boundaries. Do not imply HOTP support from URI parsing alone.
Vaultwarden support is later work (owner request, 2026-10-11). A self-hosted
connection to a Vaultwarden URL is accepted, but Pateat is tested only against
official Bitwarden server response shapes, so Vaultwarden compatibility is
unverified until its own response shapes and sign-in flow are tested.

## Mandatory acceptance matrix

| Area                  | Minimum cases                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab/document identity | Inactive live tab, active-tab switch during inference, two tabs, nested/cross-origin permitted frames, navigation invalidating a late response, frozen/discarded tab classification                                                                                                                                                                            |
| Login execution       | Branch/account/password, username then password/passkey, dynamic React inputs, delayed render, explicit field mappings before AI, ambiguity without guessing, credential rejection versus layout mismatch versus unknown outcome, no duplicated click after restart                                                                                            |
| MV3 and coexistence   | Worker suspension/restart, browser restart, no page extension iframe, official BW coexistence, actual Chrome use attach and concurrent input                                                                                                                                                                                                                   |
| Secret boundary       | Malicious page messages, origin mismatch, redirects, unauthorized frames, storage access level, redacted observations/logs, no secrets in server/provider payloads                                                                                                                                                                                             |
| Vault and settings    | PBKDF2 and Argon2id, authenticated ciphertext corruption, encoding, multiple connections, deny precedence and field exclusion, organization/custom fields capability, duplicate/linked fields and leading zeros, supported TOTP forms, sync expiry, persistent unlock and revocation                                                                           |
| Passkeys              | Existing zero-counter software key, nonzero-counter rejection, secure context, RP ID/public suffix, challenge, ancestor/topOrigin/crossOrigin, denied iframe Permissions Policy, allowCredentials/userHandle, signature encoding, configured UV/UP, abort/timeout, competing provider/conditional mediation                                                      |
| Service/AI            | Service auth separate from vault unlock, device ownership, replay/revocation, schema compatibility, settings revision conflicts, offline cache, separate generation/repair and finite-choice settings, injection text, nonexistent targets, refusal/truncation/timeout/rate-limit, no automatic provider/model fallback, monthly spend stop and attempt limits |

Fixtures use synthetic sites and credentials. A bundled Chromium pass is not
proof for installed Chrome or Chrome use. A single successful login is not
support for every site or vault format. Keep observed limitations explicit.

## Decisions still requiring evidence

- Establish the Chrome use ownership/wait mechanism before integrated automation
  claims. If no integration hook exists, document the tested wait protocol and
  remaining races rather than inventing support.
- Verify the owner-approved official OSS SDK for local Bitwarden cryptography,
  including Argon2id, legacy/current formats, strict failure handling, GPL
  distribution, memory/time and browser lifecycle. See
  [ADR 0005](adr/0005-bitwarden-local-crypto.md); do not implement cryptographic
  primitives ourselves or treat library adoption as compatibility proof.
- [ADR 0007](adr/0007-existing-passkey-assertions.md) records the owner's choice
  to set UP and UV on every claimed assertion without a gesture; making it a setting
  is planned for [phase 3](#phase-3-public-release). Nonzero-counter synchronization
  is deferred.
- Per [ADR 0013](adr/0013-service-held-recipes-and-settings.md), decide how to choose
  among several URI-matched items. How synced field exclusions move to
  device-independent references, and where custom-field review happens, are decided in
  [ADR 0023](adr/0023-synced-vault-policy.md).
- Pairing and device credential lifetime (90 days unused, renewed on use; see
  [service sync progress](#service-sync-progress)) are settled, and a lost
  device is replaced by pairing a new one, since the service holds settings and recipes
  ([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). Pricing (ADR 0014's $4
  and $20 per million tokens) and the spending limits are settled: the owner confirmed
  $200 of monthly Claude API credit, ADR 0014 sets the monthly limit to $100, and the
  service also stops at $5 a day. Calls run one at a time per owner, and each is charged
  its maximum cost before it starts and corrected afterwards
  (`services/api/src/claude/calls.ts`), so a limit is passed by at most one call.
- Benchmark generation/repair and finite-choice roles separately on the same
  Japanese/English synthetic login corpus. Measure the ADR 0014 Claude configuration for
  generation; for decisions, the owner chose Clef for
  [phase 3](#phase-3-public-release), and Clef-flash, Jev and Chrome's Prompt API remain
  candidates. Report
  semantic correctness, false-submit count, abstentions, joint mapping consistency,
  p50/p95 end-to-end latency and usage/cost. Test invalid candidate IDs, malformed
  probabilities, context overflow and incomplete observations. Clef vendor latency/price
  claims are research inputs, not Pateat measurements. Present results to the owner; a
  model or effort change is an owner decision, and evaluating a candidate does not
  authorize adopting it. There is no latency promise. Use only the configured
  provider/model for each role; its failure is an error, not an automatic fallback.
  Cached recipes continue after an AI/budget failure.

Before implementing deferred features, add their concrete slice and evidence to
this plan: write capabilities need independent connection permissions and no
automatic permission upgrade; post-login actions need site/action authorization
separate from credential use; provider passkey login needs authentication versus
vault-unlock and PRF/RP/origin checks; external challenge adapters need explicit
channel permissions. None requires a blanket prompt on every operation once a
user has authorized its supported scope.

Future page UI must avoid extension iframes, preserve accessible keyboard/focus behavior
and recheck policy locally. The service's HTTPS management UI and MCP must share the
internal operation contracts. Before implementing MCP, verify that the target client can
autonomously invoke allowed dummy operations after connection approval; MCP does not
bypass client rules. One-time account choices and choosing again after logout (ADR 0021)
need tests that cover several tabs on one origin; automatic logout/re-login also
requires shared-session/race tests. Direct AI requires trusted extension key storage and
provider compatibility tests. Alternative service auth, E2EE sync and Vaultwarden
require their own interoperability/recovery evidence.

Extension releases on GitHub Releases, with their continuous delivery, are planned for
[phase 3](#phase-3-public-release), with the Chrome Web Store if its policies allow;
public recipe sharing and hosted
browser installation are outside the plan. A simple docs website comes in phase 3 and is
not a phase 1 gate. The owner chose VitePress for it on
2026-10-11, as risu729/biwa uses, so biwa's Bun and mise build, assets-only Cloudflare
Worker and per-PR previews can be reused. The owner chose VitePress 2 even before its
stable release (on 2026-10-11 the npm `next` tag was 2.0.0-alpha.20, as biwa uses), and
nothing is installed before the site is built. Starlight and Docusaurus were the
alternatives. The docs/ pages are written for development, so user-facing pages
(installation, setup, permissions) are still to be written for the site. Extension build
and automated tests remain in CI scope. Native helpers are not required by the product.
