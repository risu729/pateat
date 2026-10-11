# Browser agents and logins

Researched: 2026-10-11, from vendor documentation (learn.chatgpt.com, docs.x.ai,
support.1password.com), public GitHub issues and press coverage. Nothing below was
tested: no ChatGPT, Grok or Claude account was used and no build was installed. It
answers two owner questions of 2026-10-11: whether Pateat can be installed in the
browser a ChatGPT agent uses, and why browser agents stop at logins even when the user
gives permission and the password, with the existing solutions. It is not a decision
and grants no capability. The owner placed "Claude in Chrome and ChatGPT agent logins
must work" in Phase 2 of the plan.

## The agents

| Agent | What it is | Browser it uses |
| --- | --- | --- |
| ChatGPT dots | OpenAI's always-on agent, rolling out in 2026, with "its own computer and browser" in the cloud ([Meet dots](https://learn.chatgpt.com/docs/dots)) | Its cloud browser; a connected PC on request |
| ChatGPT Work | ChatGPT's task mode; the 2025 "ChatGPT agent" mode was withdrawn in its favour (help article, as quoted in search results; help.openai.com returned HTTP 403 to this session) | Cloud browser, the desktop app's built-in browser, or the user's browser through the ChatGPT extension |
| Grok Bot ("Grok bots") | xAI's computer-use agent; each account runs several Bots, early beta since 2026-08-11, distributed through Cursor ([overview](https://docs.x.ai/grok-bot/overview)) | One persistent cloud computer shared by the account's Bots ([FAQ](https://docs.x.ai/grok-bot/faq)) |
| Claude in Chrome | Anthropic's extension driving the user's Chrome | The user's own Chrome profile |

## Why agents stop at logins

The stop is a vendor rule, not a model failure. Each vendor tells its agent not to
type passwords or codes and to hand the step to the person:

- Grok Bot: "For passwords, passkeys, two-factor codes, CAPTCHAs, and payment
  confirmations, the Bot should hand you control of the computer", and "Do not send a
  password or one-time code in ordinary chat"
  ([approvals, security and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)).
- ChatGPT Work: "When ChatGPT encounters a login screen, it pauses and asks you to
  enter your credentials"; "Use the sign-in form provided by ChatGPT. Don't send
  passwords in the chat" ([Browser](https://learn.chatgpt.com/docs/browser)).
- Claude in Chrome: Anthropic's page advises against "password management"
  ([Claude in Chrome](https://claude.com/claude-in-chrome)); third-party guides describe
  Claude stopping at the login for the user. A user report says Claude should "never
  fill any input[type=password] field even when the user supplied the password"
  ([anthropics/claude-code#80853](https://github.com/anthropics/claude-code/issues/80853)).
  No Anthropic page stating the rule was found.

Sites add their own stops: some block cloud browsers or automation, ask for a CAPTCHA,
or flag the login as suspicious
([dots](https://learn.chatgpt.com/docs/dots/computers-and-apps),
[Grok Bot FAQ](https://docs.x.ai/grok-bot/faq)). Passkeys need a person's approval on a
device, so no product below lets an agent use one unattended
([Flavio Copes, 2026-09-09](https://flaviocopes.com/ai-agent-passwords/)).

No first-hand forum thread was found where an agent refused after the user typed the
password into the chat; the vendor rules above explain that behaviour.

## Existing solutions

All of them keep the password away from the model:

| Solution | How it works | Limits |
| --- | --- | --- |
| Manual login on the agent's computer | ChatGPT's secure sign-in form sends values "to the remote browser outside your conversation", or **Take over** / **Sign in on web page instead**; Grok Bot's **Take control** and its masked secret request for supported connections | A person at every login; takeover fails in open reports ([openai/codex#39295](https://github.com/openai/codex/issues/39295)) |
| Saved sessions | Cloud-browser sessions persist "until you sign out or the website expires it" (dots); Grok Bot's sessions are shared across the Bot roster | Ends at each site's session expiry; any task on that computer can use it |
| ChatGPT **Save to Passwords** | ChatGPT stores a login and reuses it after confirmation ([dots](https://learn.chatgpt.com/docs/dots/computers-and-apps)) | The credential is stored by OpenAI |
| The user's logged-in browser | Claude in Chrome, ChatGPT's `@Chrome`, Atlas or Comet use existing cookies | A prompt injection can act on every site with a session |
| 1Password for Claude (July 2026) | Claude requests a login, the person approves on their device, the 1Password extension fills and submits, and Claude "only knows which login it used" ([1Password support](https://support.1password.com/1password-claude/)) | Mac, Claude desktop app and Claude in Chrome only; approval on every fill; no passkeys; Claude only |
| 1Password with Browserbase | The 1Password extension inside a cloud browser, approval on the person's device | Developer early access since October 2025 |
| Bitwarden Agent Access SDK | An approved item is injected into the agent's process, not the model | Early alpha, CLI only ([Flavio Copes](https://flaviocopes.com/ai-agent-passwords/)) |

## Where Pateat fits

Pateat already logs in without the agent seeing the password: it fills from the
local vault and submits by recipe when the page loads. When an agent opens a recipe's
start page in a browser where Pateat runs, the agent should find the site already
signed in, the same as a saved session, so the vendor rule never comes into play. That
holds only where Pateat is installed:

| Browser | Can Pateat run there |
| --- | --- |
| The owner's Chrome driven by Claude in Chrome or ChatGPT `@Chrome` | Yes, already installed |
| ChatGPT desktop app's built-in browser | Unknown. Chrome extensions are supported since 2026-09-18 ([RuntimeWire](https://runtimewire.com/article/openai-chatgpt-desktop-browser-chrome-extensions)), but no source says whether unpacked ones load, and Pateat is not on the Web Store. It would also need its own pairing ([ADR 0020](../adr/0020-direct-device-pairing.md)) and Bitwarden login |
| Cloud browser of dots or ChatGPT Work | No documented way. It "doesn't use your personal browser's … extensions" ([Browser](https://learn.chatgpt.com/docs/browser)); no page describes installing one. The retired agent mode "cannot … install extensions" ([Atlas help](https://help-lb.openai.com/en/articles/12628199-using-ask-chatgpt-sidebar-and-chatgpt-agent-on-atlas)) |
| Grok Bot's cloud computer | No source mentions extensions |

Installing Pateat on a vendor's cloud computer would also put the unlocked vault key
and the persistent unlock key ([ADR 0006](../adr/0006-atomic-local-vault-cache.md)) on
that vendor's machine. "Keep vault secrets and signing local"
([ADR 0001](../adr/0001-local-login-boundary.md)) does not allow that without a new
owner decision.

Differences from 1Password for Claude that matter here:

- **No per-login approval.** 1Password asks on the person's device for every fill;
  Pateat logs in automatically on every site with a recipe. A prompt-injected agent
  that opens such a site gets a signed-in session, as with the cookies a logged-in
  browser already has.
- **The agent can read filled values.** 1Password has Claude pause reading the page
  until the fill finishes. ChatGPT's extension holds "Access the page debugger" and
  can use CDP after a per-site approval
  ([Browser extension](https://learn.chatgpt.com/docs/chrome-extension)), and a value
  Pateat fills is readable by the page and its debugger
  ([architecture](../architecture.md#components-and-trust-boundaries)).
- **No hand-back signal.** The agent does not know Pateat is logging in. It may start
  typing into the form itself or stop and hand the login to the person before Pateat
  finishes. How Pateat's per-tab attempts
  ([ADR 0022](../adr/0022-login-attempts-per-tab-and-origin.md)) behave in an
  agent-driven tab was not checked.

## What to check next

None of these has been run. Each needs the owner's ChatGPT, Claude or Grok account, so
each needs separate owner approval:

1. In the owner's Chrome with Pateat installed, have Claude in Chrome and a ChatGPT
   Work task with `@Chrome` open a recipe's start page and record whether the agent
   waits, types into the form or hands the login back.
2. In the ChatGPT desktop app's built-in browser, check whether an unpacked extension
   can be loaded at all.
3. In a dot's cloud computer during a takeover, check whether `chrome://extensions` or
   the Web Store opens. This only records what is possible; installing Pateat there
   needs the owner decision above.
