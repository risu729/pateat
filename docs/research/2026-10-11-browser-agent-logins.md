# Browser agents and logins

Researched: 2026-10-11, from vendor documentation (learn.chatgpt.com, docs.x.ai,
support.1password.com), public GitHub issues and press coverage. Nothing below was
tested: no ChatGPT, Grok or Claude account was used and no build was installed. It
answers two owner questions of 2026-10-11: whether Pateat can be installed in the
browser of an agent's cloud computer, and how browser agents handle logins today, with
the existing solutions. It is the research that the
[Phase 2](../plan.md#phase-2-use-it-and-fix-what-comes-up) item on agents with their
own cloud computer asks for first. It is not a decision and grants no capability.

## The agents

| Agent | What it is | Browser it uses |
| --- | --- | --- |
| ChatGPT dots | OpenAI's always-on agent, rolling out in 2026, with "its own computer and browser" in the cloud ([Meet dots](https://learn.chatgpt.com/docs/dots)) | Its cloud browser; a connected PC on request |
| ChatGPT Work | ChatGPT's task mode; the 2025 "ChatGPT agent" mode was withdrawn in its favour (help article as quoted in search results; help.openai.com returned HTTP 403 to this session) | Cloud browser, the desktop app's built-in browser, or the user's browser through the ChatGPT extension |
| Grok Bot ("Grok bots") | xAI's computer-use agent, included with paid Cursor plans, launched 2026-08-11 ([GIGAZINE](https://gigazine.net/gsc_news/en/20260812-spacexai-grok-bot)); each member's Bots share one hosted computer ([overview](https://docs.x.ai/grok-bot/overview), [computers](https://docs.x.ai/grok-bot/computers)) | That computer's browser |
| Claude in Chrome | Anthropic's extension driving the user's Chrome | The user's own Chrome profile |

## How agents handle logins

For Grok Bot and ChatGPT the stop at a login is documented vendor behaviour: the agent
does not type the password or code and hands the step to the person.

- Grok Bot: "For passwords, passkeys, two-factor codes, CAPTCHAs, and payment
  confirmations, the Bot should hand you control of the computer", and "Do not send a
  password or one-time code in ordinary chat"
  ([approvals, security and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)).
  For a login it can also show a form in the chat, one per step, and "fill your
  answers into the page".
- ChatGPT Work: "When ChatGPT encounters a login screen, it pauses and asks you to
  enter your credentials"; "Use the sign-in form provided by ChatGPT. Don't send
  passwords in the chat" ([Browser](https://learn.chatgpt.com/docs/browser)).
- Claude in Chrome: Anthropic's page advises against "password management"
  ([Claude in Chrome](https://claude.com/claude-in-chrome)). No published Anthropic
  rule on typing passwords was found. A closed bug report about Claude Code's preview
  tool, not Claude in Chrome, asks that Claude "never fill any input[type=password]
  field … even if the user supplies and explicitly authorizes the password"
  ([anthropics/claude-code#80853](https://github.com/anthropics/claude-code/issues/80853),
  filed 2026-07-24, closed as not planned 2026-09-04).

Sites add their own stops. "Some websites block cloud browsers or require further
verification" ([dots](https://learn.chatgpt.com/docs/dots/computers-and-apps)); a site
may "block automation, require a new login, present a CAPTCHA, or require human
confirmation" ([Grok Bot FAQ](https://docs.x.ai/grok-bot/faq)). Passkeys need a
person's approval on a device in every consumer product below
([Flavio Copes, updated 2026-09-09](https://flaviocopes.com/ai-agent-passwords/)); Grok
Bot's Enterprise Team Setup can install a password manager whose passkeys work in the
computer browser, and the page does not say whether a person approves each use
([identity and access](https://docs.x.ai/grok-bot/identity-and-access)).

No first-hand forum thread was found where an agent refused after the user typed the
password into the chat; the vendor behaviour above explains it.

## Existing solutions

All of them keep the password out of the agent's chat:

| Solution | How it works | Limits |
| --- | --- | --- |
| Manual login on the agent's computer | ChatGPT's sign-in form sends values "to the remote browser outside your conversation", or **Take over** / **Sign in on web page instead**; Grok Bot's in-chat form or **Take control** | A person at every login; ChatGPT takeover fails in open reports ([openai/codex#39295](https://github.com/openai/codex/issues/39295)) |
| Saved sessions | Cloud-browser sessions last "until you sign out or the website expires it" (dots); Grok Bot's sessions are shared by all of a member's Bots | Ends at each site's session expiry; any task on that computer can use it |
| ChatGPT **Save to Passwords** | A login saved in ChatGPT and reused after confirmation ([dots](https://learn.chatgpt.com/docs/dots/computers-and-apps)) | Storage details are not documented on that page |
| The user's logged-in browser | Claude in Chrome or ChatGPT's `@Chrome` use the profile's existing cookies | A prompt injection can act on every site with a session |
| 1Password for Claude | Claude requests a login, the person approves on their device, the 1Password extension fills and submits, and Claude "only knows which login it used" ([1Password support](https://support.1password.com/1password-claude/)) | Launched July 2026 with approval on each fill ([Flavio Copes](https://flaviocopes.com/ai-agent-passwords/)); Mac, Claude desktop app and Claude in Chrome only; no passkeys; while Agentic Mode is on, the 1Password extension and inline autofill are blocked |
| 1Password with Browserbase | The 1Password extension inside Browserbase's cloud browser, approval on the person's device | Early access since October 2025 ([Flavio Copes](https://flaviocopes.com/ai-agent-passwords/)) |
| Bitwarden Agent Access SDK | An approved item is injected into the agent's process as environment variables, not into the model | Early alpha; pairing and approval in a CLI ([Flavio Copes](https://flaviocopes.com/ai-agent-passwords/)) |

## Where Pateat fits

When its vault is unlocked and a site has a recipe (or one is generated on a page with
a vault match, [ADR 0016](../adr/0016-recipe-generation-trigger.md)), Pateat fills from
its vault cache and submits by recipe when the page loads, without the agent typing or
being given the password. If the agent does not act on the form first, it would find
the site signed in, the same as a saved session, and the vendor stop would not come
into play. This is untested, and only holds where Pateat is installed:

| Browser | Can Pateat run there |
| --- | --- |
| The owner's Chrome driven by Claude in Chrome or ChatGPT `@Chrome` | Yes, already installed |
| ChatGPT desktop app's built-in browser | Unknown. Chrome extensions are supported since 2026-09-18, and OpenAI says "ChatGPT's agent cannot interact with extensions or their data" ([RuntimeWire](https://runtimewire.com/article/openai-chatgpt-desktop-browser-chrome-extensions)). No source says whether unpacked ones load, and Pateat is not on the Web Store. It would also need its own pairing ([ADR 0020](../adr/0020-direct-device-pairing.md)) and Bitwarden login |
| Cloud browser of dots or ChatGPT Work | No documented way. It "doesn't use your personal browser's … extensions" ([Browser](https://learn.chatgpt.com/docs/browser)), and no page describes installing one. The retired agent mode "cannot … install extensions" (Atlas help article as quoted in search results; the page returned HTTP 403) |
| Grok Bot's computer | Yes, observed on 2026-10-12 (see [Observed on a Grok Bot computer](#observed-on-a-grok-bot-computer)), including after the computer slept and after a computer update |

[ADR 0024](../adr/0024-settings-profiles.md) already expects remote agent browsers that
reinstall the extension often, and the
[architecture](../architecture.md#product-boundary) leaves hosted browsers to "that
environment allowing installation and storage". Running there is a tradeoff for the
owner: the encrypted vault cache and the retained unlock key
([ADR 0006](../adr/0006-atomic-local-vault-cache.md)), and the Bitwarden session
([ADR 0008](../adr/0008-durable-provider-sessions.md)), would sit on the vendor's
machine.

Differences from 1Password for Claude that matter here:

- **No per-login approval.** 1Password asks on the person's device for every fill;
  Pateat logs in automatically on every site with a recipe that eligibility and site
  exclusions allow. A prompt-injected agent that opens such a site gets a signed-in
  session, as with the cookies a logged-in browser already has. ADR 0024's later
  per-device profiles are where narrower site lists for agent browsers are planned.
- **The agent may read filled values.** 1Password has Claude pause reading the page
  until the fill finishes. A value Pateat fills is readable by the page and potentially
  its debugger ([architecture](../architecture.md#components-and-trust-boundaries)).
  ChatGPT's extension may ask for "Access the page debugger"
  ([Browser extension](https://learn.chatgpt.com/docs/chrome-extension)), and full CDP
  use needs the user to turn on **Enable full CDP access** in Developer mode and
  approve each site ([Browser](https://learn.chatgpt.com/docs/browser)).
- **No hand-back signal.** The agent does not know Pateat is logging in. It may start
  typing into the form itself, or hand the login to the person before Pateat finishes.
  How Pateat's per-tab attempts
  ([ADR 0022](../adr/0022-login-attempts-per-tab-and-origin.md)) behave in an
  agent-driven tab was not checked.

## Observed on a Grok Bot computer

On 2026-10-12 the owner ran the install check on their own Grok Bot computer, with no
vault, no pairing and no login:

- The owner attached the build of main `da61428` (`pateat-chrome-da61428.zip`) with the
  Pateat and Bitwarden SDK source archives to the Bot's chat. The Bot placed them in
  `/workspace/pateat-ext` and unpacked the zip; the files arrived intact.
- The Bot reported the computer's browser as Google Chrome 154.0.8037.97.
- During a takeover, `chrome://extensions` opened and showed "Your browser is managed by
  your organization", but **Developer mode** and **Load unpacked** were available.
  Pateat 0.1.0 loaded from `/workspace/pateat-ext/unpacked` with ID
  `ekcnbbomcllhpomkeofikjagmjoibffk` and was enabled. Its settings page
  (`chrome-extension://ekcnbbomcllhpomkeofikjagmjoibffk/options.html`) opened and showed
  "Saved settings loaded · Revision 0" and the **Bitwarden connections** form; nothing
  was entered.
- uBlock Origin Lite installed from the Chrome Web Store, so Web Store installs also
  work.
- The browser already had xAI's own "Grok Bot WebAuthn proxy" 0.1.14 (ID
  `mpfkaohnmdhkmmoekeammpleipnbgjjd`), described as running "the box browser's
  security-key ceremonies on the machine the key is plugged into". Pateat also answers
  passkey requests, so how the two interact is unchecked.

Later on 2026-10-12 the owner checked whether the install lasts:

- After the computer had gone to sleep, waking it showed Pateat 0.1.0 still listed
  and enabled in `chrome://extensions`.
- The owner then ran **Update** under Grok Bot app Settings, Updates, Grok Bot's
  Computer. Pateat was still listed and enabled afterwards. **Reset** on the same
  screen was not tried.
- The WebAuthn proxy's toggle was off and greyed out with no **Remove** button, which
  suggests it is controlled by policy. While it is off it cannot interfere with
  Pateat's passkey handling; passkeys from Pateat come from its own vault, not from
  that proxy.

Not yet checked: anything that needs pairing. Pairing from this browser is refused
today, because the service's Access policy requires a WARP-connected device
([delivery](../delivery.md)).

## What to check next

None of these has been run. Each needs the owner's ChatGPT, Claude or Grok account, so
each needs separate owner approval:

1. In the owner's Chrome with Pateat installed, have Claude in Chrome and a ChatGPT
   Work task with `@Chrome` open a recipe's start page and record whether the agent
   waits, types into the form or hands the login back.
2. In the ChatGPT desktop app's built-in browser, check whether an unpacked extension
   can be loaded at all.
3. On a dot's cloud computer during a takeover, check whether `chrome://extensions`
   or the Web Store opens. This only records what is possible; running Pateat there
   with a vault is the owner's tradeoff above.
4. On the Grok Bot computer, pairing and a login on one of the owner's real sites with
   the owner's existing Bitwarden account (owner decisions, 2026-10-12). This needs the
   "pateat pair" Access application of [ADR 0030](../adr/0030-pairing-without-warp.md)
   first, and a build from current main with its source beside it
   ([Corresponding Source](../sdk-source.md)).
