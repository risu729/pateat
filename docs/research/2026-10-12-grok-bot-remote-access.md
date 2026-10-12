# Grok Bot computer: shell access and messaging a Bot from outside

Researched: 2026-10-12 (18:05 to 18:50 UTC), from public sources only. Nothing was
installed on the Grok Bot computer, no tunnel was opened and no Bot setting changed.
On 2026-10-12 the owner found debugging Pateat on the Grok Bot computer tedious, asked
whether Claude can SSH into it (18:02 UTC), and asked whether Claude or another outside
program can talk to a Grok Bot directly instead of the owner pasting text from Notion
(18:05 UTC). Background on that computer is in
[browser agents and logins](2026-10-11-browser-agent-logins.md).

Primary sources read on 2026-10-12: the Grok Bot documentation
([index](https://docs.x.ai/llms.txt), every `docs.x.ai/grok-bot/*` page listed there;
Cursor publishes the same pages under `cursor.com/docs/grok-bot/`), the
[Grok Bot Terms](https://cursor.com/terms/grok-bot) (last updated 2026-10-12), the
[Cursor Terms of Service](https://cursor.com/terms-of-service) (2026-09-03), the
[Cursor Acceptable Use Policy](https://cursor.com/en-US/acceptable-use-policy)
(2026-08-11), and Grok Bot threads on the [Cursor forum](https://forum.cursor.com/),
where Cursor staff answer Grok Bot reports. The documentation says the computers are
Cursor-hosted. The Grok Bot Terms name no company: "Provider" is "the entity providing
Grok Bot to Customer under the Agreement". The copy read here is on cursor.com, and the
Cursor Terms of Service say Grok Bot use is "also subject to the Grok Bot Terms". Access
can also come from a SuperGrok subscription, and which agreement and acceptable use
policy cover the owner's access is not recorded. The xAI copies under `x.ai/legal/`
(including `grok-bot-terms`) returned HTTP 403 to this session and were not read, so
the Cursor documents below may not be the ones that apply.

## Summary

| Question | Answer | Source |
| --- | --- | --- |
| Can a member open a shell or SSH session on the cloud computer? | Not documented. Members watch the computer in **Agent Computer** and use takeover for sensitive steps | [Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) |
| Can a tunnel or VPN client run on it? | Documented only as Enterprise **Team Setup** scripts for outbound access to a private network. Any member can instead route the computer's egress through their own desktop | [Connect to private networks](https://docs.x.ai/grok-bot/private-networks) |
| Do the terms allow or forbid SSH or a tunnel? | The Cursor documents read here do not name SSH, tunnels or remote access. The Cursor AUP forbids bypassing protective measures and safety mitigations. The xAI copies were not read | Grok Bot Terms, Cursor AUP |
| Is there an official API or SDK to send a Bot a message? | No. A Cursor forum reply on 2026-10-12 says there is none | [Forum](https://forum.cursor.com/t/grok-bot-official-api-to-create-bots-and-send-receive-chat-for-companion-uis/170985) |
| What official ways start Bot work without the app? | Scheduled routines, routines started by Slack or GitHub events, and tagging @bot in a public post on X | [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), [Tag @bot on X](https://docs.x.ai/grok-bot/tag-on-x) |

## Shell access to the cloud computer

What the documentation says about the computer:

- "Grok Bot works from a persistent cloud computer. It can use a browser, command line,
  files, and connected tools without depending on your laptop remaining open." Members
  see it through **Agent Computer**: "Open **Agent Computer** from a conversation to
  view the shared desktop." For a password, passkey, two-factor code, CAPTCHA or payment
  step the member takes control, completes "only the blocked step", and hands control
  back. For checks a site raises, the page says to "Ask the Bot to pause and notify you
  rather than attempting to bypass the check."
- No page describes a member terminal, SSH, VNC, open ports or inbound connections. The
  [security page](https://docs.x.ai/grok-bot/security) covers egress only: computers
  "reach the internet through shared static egress IP addresses by default", and the
  destination allowlist (**Network Controls**) is Enterprise only.
- "Team computers run Linux, and scripts run as the computer user with `sudo`
  available" ([private networks](https://docs.x.ai/grok-bot/private-networks), Team
  Setup section).
- "Treat temporary directories, manually installed packages, and uncommitted
  application state as replaceable." **Update** in **Settings → Updates** "installs the
  latest software on the computer and keeps your files in place"; the
  [Manage computers](https://docs.x.ai/grok-bot/computers) page says a recreate or
  terminate, which Enterprise organization admins run from the Cursor dashboard,
  removes "apps and packages members installed themselves".

The only documented tunnel or VPN setup is
[Connect to private networks](https://docs.x.ai/grok-bot/private-networks): Tailscale
(the pattern "exercised" on team computers) or a `cloudflared` client, installed by
**Team Setup** scripts, so that the computer can reach services inside the customer's
network. SSH appears there only as a private TCP service the computer connects out to
with `cloudflared access tcp`. "Team Setup is Enterprise only. It does not appear on
other plans." The same page lets any member turn on **Settings → Computer → Network →
Route traffic through this computer** in the desktop app, which sends the computer's
egress through the member's desktop. Neither describes connecting into the computer.

Community reports, not official: a community wiki lists a shared Bot template that
installs Tailscale on the computer for `ssh box@grok-bot` over the user's tailnet
([Grok Bot Wiki](https://www.grokbotwiki.com/bots/ssh-to-grok-bot-via-tailscale),
"Not affiliated with or endorsed by xAI or X Corp."). On the
[Cursor forum](https://forum.cursor.com/t/grok-bot-can-i-send-it-a-message-from-outside/168199)
one user wrote "I installed tailscale on the computer and it works great!", and another
has the Bot connect out over SSH through Tailscale to the user's own machine. So the
Bot can likely install such a client with `sudo` on an individual plan (inferred, not
tried).

What the terms read here say:

- The Grok Bot Terms list no prohibited uses. §1.1 allows use "subject to the
  Agreement, the Provider's acceptable use policy, and the applicable account settings
  and permissions", and §1.2 says users "will use Grok Bot in accordance with
  Provider's Documentation". No clause mentions SSH, tunnels, remote access or inbound
  connections.
- The Cursor Terms of Service §1.5 forbid trying to "reverse engineer, disassemble,
  decompile, decode" the Service and to "probe, scan or attempt to penetrate the
  Service".
- The Cursor AUP does not mention SSH, tunnels or remote access. It forbids "bypassing
  our systems or protective measures", "Disrupting, interfering with, or unauthorized
  access to the Service or its safety systems, including circumventing any rate limits
  or restrictions or protective measures and safety mitigations", and says "Don't
  circumvent safeguards unless you have our official written consent". It also lists
  "Accessing the Service through automated or non-human means, whether through a bot,
  script, or otherwise".

No source found here allows a member to open a shell or tunnel into the computer, and
none forbids it by name. Using such a shell to drive the computer's Chrome directly, for
example over its DevTools port, would skip the Bot's browser tool and the checks that
come with it. Two are known: the Bot reported on 2026-10-12 that its browser tool runs
through a proxy that blocks `chrome://` pages, and browser actions have failed with
"The box could not confirm that no saved credential is being filled into its browser",
reported on the
[Cursor forum](https://forum.cursor.com/t/my-browser-blocks-every-action-with-a-credential-check-error/173944)
on 2026-10-07 and seen by the owner's Bot on 2026-10-12. Skipping them reads as
bypassing protective measures under the AUP. A shell used only to read Pateat's files or
logs is not addressed by any source.

Outbound connections are also limited at the moment. A Cursor forum report says that
since 2026-10-01 the computer reaches only HTTPS on port 443, with SSH on port 22 and
mail ports timing out and `SAND_EGRESS_TUNNEL_ENABLED=1` set
([forum](https://forum.cursor.com/t/grok-bot-computer-all-outbound-non-https-traffic-blocked-since-oct-1-mysql-ssh-imap-smtp-ftp-time-out/173504)).
Cursor staff (Colin, 2026-10-02) replied: "Since a recent change, some Grok Bot
computers can only make outbound HTTPS connections on port 443", "it isn't intended",
and "There's no reliable workaround on the computer itself yet". Whether a Tailscale or
`cloudflared` client can connect through that proxy was not checked.

Risks independent of the terms: the computer holds the whole-vault cache and the unlock
key for the owner's Bitwarden account (see
[browser agents and logins](2026-10-11-browser-agent-logins.md)), so an inbound path
adds a new way to reach them; and a recreate removes the client, and an Update may, so
the path can break without notice.

## Messaging a Bot from outside

Official:

- **No public API.** A Cursor forum reply on 2026-10-12 (poster `deanrie`, who appears
  to be Cursor staff; the page does not label roles): "There's currently no official
  public API or SDK for Grok Bot for this use case", "UI automation is basically the
  only option right now". That describes the situation; it is not permission, and the
  AUP's "automated or non-human means" line above bears on any outside program that
  drives the app.
- **Routines.** A routine runs a workflow "on a schedule or, where supported, after an
  event". "Routine schedules must be at least five minutes apart", and "Background
  routines can run while your laptop is closed". "Cursor account integrations can start
  a routine from an event, such as a Slack message or a GitHub notification", with
  "a narrow matching rule".
- **Connectors.** A Bot works with supported services through plugins from **Connect
  apps**; installed connectors are account-wide. The owner's Bot already reads Notion
  this way.
- **Tag @bot on X.** A public post or reply on X that tags @bot hands that post to the
  member's main Bot as a task; @bot replies publicly on X with a confirmation. Not
  available for accounts based in Australia, the UK, the EU, Iceland, Liechtenstein or
  Norway.

Not documented:

- A routine **webhook trigger** is described by
  [Hookdeck](https://hookdeck.com/webhooks/platforms/using-hookdeck-with-grok-bot-reliable-webhook-triggers)
  as an in-app control ("Add trigger", then "Webhook") that gives a URL and a key, but
  it does not appear in the documentation. On 2026-08-12 a forum reply (poster
  `kevinn`, who appears to be Cursor staff) said having a Bot "respond to an inbound
  webhook event is a great idea, and we are tracking the ask". One forum user reported
  that creating a webhook routine broke the info pane.
- A forum user reports an internal HTTP API on the computer and calls it "an
  undocumented internal API, not an officially supported Cursor integration". Using it
  would fall under the reverse-engineering, probing and automated-access lines above, so
  it is not an option.
- Third-party MCP servers that send messages to Bots exist (listed on
  [Glama](https://glama.ai/mcp/servers?query=grok+bot)); how they reach the Bot was not
  checked, and the same lines apply if they drive the app or that internal API.

A scheduled routine on the Bot that reads a fixed Notion page and carries out the newest
request written there would let Claude write requests to that page without the owner
pasting them. This is an untested design built on documented routines and connectors.
Anyone who can edit that page could then direct the Bot on a computer that holds the
vault cache, each run uses Grok Bot usage, and results arrive no faster than the
routine's interval (five minutes or more). A Slack or GitHub event trigger needs a
workspace or repository the Bot listens to; this repository is public, so a trigger on
it would need a matching rule that only the owner's own events pass (not checked).
Tagging @bot makes every request a public post.

## Not checked

- The xAI copies of the terms (`x.ai/legal/grok-bot-terms`, consumer terms, AUP), which
  this session could not fetch, and which agreement covers the owner's access.
- Whether the webhook trigger appears in the owner's Grok Bot app. If it does, it would
  start a routine on each request instead of every five minutes, and Claude would hold
  its key.
- Whether the owner's computer already has `tailscale`, `cloudflared` or `sshd`
  installed, and whether a routine can read Notion while the owner's laptop is closed.
- Whether the AUP's "automated or non-human means" line covers driving the Grok Bot
  desktop app with computer use, as the local session does today for takeovers.
